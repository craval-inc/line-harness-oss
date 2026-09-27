/**
 * [Craval kzn] WEBHOOK_INBOX / INCOMING_IMAGE_STORE / MIRROR の結合テスト。
 * DB は node:sqlite 上の D1 互換アダプタ（schema.sql + 046）＝実 SQL で重複排除・条件付き更新を検証する。
 * LINE API（LineClient）とイベントバスだけモック。
 */
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn().mockResolvedValue(true),
    LineClient: vi.fn().mockImplementation(() => lineMocks),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
}));

import { webhook } from './webhook.js';
import { fireEvent } from '../services/event-bus.js';
import { handleWebhookEvent } from './webhook.js';
import { LineClient } from '@line-crm/line-sdk';
import { createKznTestDb, type SqliteD1 } from '../test-utils/sqlite-d1.js';
import { runInboxMaintenance, hmacHex, insertIncomingLog, saveInboxEvents, UNSENT_PLACEHOLDER, RETRY_AFTER_MS } from '../services/webhook-inbox.js';

const SIG = 'A'.repeat(43) + '=';
const USER = 'U0000000000000000000000000000test';

function app() {
  const a = new Hono();
  a.route('/', webhook);
  return a;
}

let db: SqliteD1;
let pending: Promise<unknown>[];

function ctx(): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

function env(extra: Record<string, unknown> = {}) {
  return {
    DB: db.asD1(),
    LINE_CHANNEL_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    WORKER_URL: 'https://kzn.example',
    WEBHOOK_INBOX: '1',
    INCOMING_IMAGE_STORE: '0',
    ...extra,
  } as Record<string, unknown>;
}

async function post(events: unknown[], e = env()) {
  const res = await app().request(
    '/webhook',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': SIG },
      body: JSON.stringify({ destination: 'x', events }),
    },
    e,
    ctx(),
  );
  await Promise.all(pending.splice(0));
  return res;
}

let seq = 0;
function evId() {
  seq += 1;
  return `01TESTEVENT${String(seq).padStart(15, '0')}`;
}

const follow = (ts: number, id = evId()) => ({
  type: 'follow', webhookEventId: id, timestamp: ts, replyToken: 'rt-follow',
  source: { type: 'user', userId: USER }, mode: 'active', deliveryContext: { isRedelivery: false },
});
const unfollow = (ts: number, id = evId()) => ({
  type: 'unfollow', webhookEventId: id, timestamp: ts,
  source: { type: 'user', userId: USER }, mode: 'active', deliveryContext: { isRedelivery: false },
});
const text = (messageId: string, body: string, ts = 5000, id = evId()) => ({
  type: 'message', webhookEventId: id, timestamp: ts, replyToken: 'rt-msg',
  source: { type: 'user', userId: USER }, mode: 'active', deliveryContext: { isRedelivery: false },
  message: { id: messageId, type: 'text', text: body, quoteToken: 'q' },
});
const image = (messageId: string, ts = 5000, id = evId()) => ({
  type: 'message', webhookEventId: id, timestamp: ts, replyToken: 'rt-img',
  source: { type: 'user', userId: USER }, mode: 'active', deliveryContext: { isRedelivery: false },
  message: { id: messageId, type: 'image', contentProvider: { type: 'line' } },
});
const unsend = (messageId: string, ts = 6000, id = evId()) => ({
  type: 'unsend', webhookEventId: id, timestamp: ts,
  source: { type: 'user', userId: USER }, mode: 'active', deliveryContext: { isRedelivery: false },
  unsend: { messageId },
});

function rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return db.raw.prepare(sql).all(...(params as never[])) as T[];
}

beforeEach(() => {
  vi.clearAllMocks();
  lineMocks.getProfile.mockResolvedValue({ displayName: 'テスト太郎', userId: USER });
  db = createKznTestDb();
  pending = [];
});

async function seedFriend() {
  await post([follow(1000)]);
}

describe('WEBHOOK_INBOX=1 — 入口保存と重複排除', () => {
  test('テキスト受信: 受信箱に保存→処理済み・messages_log に line_message_id 付きで1件', async () => {
    await seedFriend();
    const ev = text('m-1', 'こんにちは');
    const res = await post([ev]);
    expect(res.status).toBe(200);
    const inbox = rows<{ processed: number; attempts: number }>('SELECT processed, attempts FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId);
    expect(inbox).toEqual([{ processed: 1, attempts: 0 }]);
    const logs = rows('SELECT content, line_message_id FROM messages_log WHERE direction = ?', 'incoming');
    expect(logs).toEqual([{ content: 'こんにちは', line_message_id: 'm-1' }]);
  }, 10_000);

  test('同一 webhookEventId を2回（逐次）→ 処理は1回', async () => {
    await seedFriend();
    const ev = text('m-2', 'hello');
    await post([ev]);
    await post([ev]);
    expect(rows('SELECT * FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId)).toHaveLength(1);
    expect(rows("SELECT * FROM messages_log WHERE direction = 'incoming'")).toHaveLength(1);
  }, 10_000);

  test('同一イベントを1リクエスト内で重複・並行2リクエスト → 処理は1回', async () => {
    await seedFriend();
    const ev = text('m-3', 'dup');
    await Promise.all([post([ev, ev]), post([ev])]);
    expect(rows("SELECT * FROM messages_log WHERE direction = 'incoming'")).toHaveLength(1);
  }, 10_000);

  test('同一 follow イベントの重複到着 → ハンドラは1回だけ（プロフィール取得1回）', async () => {
    const ev = follow(1000);
    await post([ev]);
    await post([ev]);
    await Promise.all([post([ev]), post([ev])]);
    expect(lineMocks.getProfile).toHaveBeenCalledTimes(1);
  }, 10_000);

  test('別イベントIDでも同じ LINE message id なら messages_log は1件（部分一意インデックス）', async () => {
    await seedFriend();
    await post([text('m-4', 'a')]);
    await post([text('m-4', 'a')]);
    expect(rows("SELECT * FROM messages_log WHERE direction = 'incoming'")).toHaveLength(1);
  }, 10_000);

  test('受信箱への保存失敗 → 500（処理しない）', async () => {
    await seedFriend();
    db.failOn = /INSERT OR IGNORE INTO webhook_inbox/;
    const res = await post([text('m-5', 'x')]);
    expect(res.status).toBe(500);
    db.failOn = null;
    expect(rows("SELECT * FROM messages_log WHERE direction = 'incoming'")).toHaveLength(0);
  }, 10_000);

  test('処理途中の例外 → processed=0・attempts=1 が残り、Cron 再処理で1回だけ完了', async () => {
    await seedFriend();
    const ev = text('m-6', 'retry me');
    db.failOn = /INSERT OR IGNORE INTO messages_log/;
    await post([ev]);
    db.failOn = null;
    expect(rows<{ processed: number; attempts: number }>('SELECT processed, attempts FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId))
      .toEqual([{ processed: 0, attempts: 1 }]);

    const process = (event: never, accountId: string | null) =>
      handleWebhookEvent(db.asD1(), new LineClient('token'), event, 'token', accountId, 'https://kzn.example', '', undefined, { inbox: true });
    const later = () => Date.now() + RETRY_AFTER_MS + 1000;
    const r1 = await runInboxMaintenance({ db: db.asD1(), process, mirror: null, now: later });
    expect(r1.reprocessed).toBe(1);
    const r2 = await runInboxMaintenance({ db: db.asD1(), process, mirror: null, now: later });
    expect(r2.reprocessed).toBe(0);
    expect(rows("SELECT content FROM messages_log WHERE direction = 'incoming'")).toEqual([{ content: 'retry me' }]);
  }, 10_000);
});

describe('INCOMING_IMAGE_STORE=0', () => {
  test('画像は R2 に保存せずラベル記録（IMAGES 未バインドでも落ちない）', async () => {
    await seedFriend();
    const res = await post([image('img-1')]);
    expect(res.status).toBe(200);
    expect(rows("SELECT message_type, content FROM messages_log WHERE direction = 'incoming'"))
      .toEqual([{ message_type: 'image', content: '[画像]' }]);
  }, 10_000);

  test('IMAGES がバインドされていても保存しない', async () => {
    await seedFriend();
    const put = vi.fn();
    await post([image('img-2')], env({ IMAGES: { put, get: vi.fn() } }));
    expect(put).not.toHaveBeenCalled();
  }, 10_000);
});

describe('unsend（送信取消）', () => {
  test('受信後に取消 → messages_log と受信箱の生本文が置換される', async () => {
    await seedFriend();
    const ev = text('m-10', '秘密の内容');
    await post([ev]);
    await post([unsend('m-10')]);
    expect(rows("SELECT content FROM messages_log WHERE direction = 'incoming'")).toEqual([{ content: UNSENT_PLACEHOLDER }]);
    const [row] = rows<{ body_json: string }>('SELECT body_json FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId);
    expect(row.body_json).not.toContain('秘密の内容');
    expect(JSON.parse(row.body_json).message.text).toBe(UNSENT_PLACEHOLDER);
  }, 10_000);

  test('取消が先着 → 後から届いた元メッセージの本文を保存しない', async () => {
    await seedFriend();
    await post([unsend('m-11')]);
    const ev = text('m-11', '後着の秘密');
    await post([ev]);
    expect(rows("SELECT content FROM messages_log WHERE direction = 'incoming'")).toEqual([{ content: UNSENT_PLACEHOLDER }]);
    const [row] = rows<{ body_json: string }>('SELECT body_json FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId);
    expect(row.body_json).not.toContain('後着の秘密');
    // 取消済みメッセージではイベント発火（自動化・送信Webhook）も行わない
    expect(vi.mocked(fireEvent).mock.calls.filter((c) => c[1] === 'message_received')).toHaveLength(0);
  }, 10_000);
});

describe('follow / unfollow の時刻条件', () => {
  test('新しい unfollow の後に古い follow を処理しても、ブロック状態のまま', async () => {
    await post([follow(2000)]);
    await post([unfollow(3000)]);
    await post([follow(1000)]); // 遅延到着した古い follow
    expect(rows('SELECT is_following FROM friends WHERE line_user_id = ?', USER)).toEqual([{ is_following: 0 }]);
    expect(rows('SELECT is_following, state_at FROM friend_follow_state WHERE line_user_id = ?', USER))
      .toEqual([{ is_following: 0, state_at: 3000 }]);
  }, 10_000);

  test('新しい follow の後に古い unfollow を処理しても、フォロー状態のまま', async () => {
    await post([follow(5000)]);
    await post([unfollow(4000)]);
    expect(rows('SELECT is_following FROM friends WHERE line_user_id = ?', USER)).toEqual([{ is_following: 1 }]);
  }, 10_000);
});

describe('ミラー転送（MIRROR_URL）', () => {
  const MIRROR = { MIRROR_URL: 'https://mirror.example/api/line-harness-event', MIRROR_SECRET: 'mirror-secret' };

  test('2xx → mirrored=1・HMAC 署名が生本文と一致・replyToken を含まない', async () => {
    const calls: { body: string; headers: Record<string, string> }[] = [];
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ body: String(init.body), headers: init.headers as Record<string, string> });
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      await post([follow(1000)], env(MIRROR));
      const ev = text('m-20', 'ミラーして');
      await post([ev], env(MIRROR));
      const msgCall = calls.find((c) => JSON.parse(c.body).eventType === 'message')!;
      expect(msgCall).toBeTruthy();
      expect(msgCall.headers['X-Mirror-Signature']).toBe(await hmacHex('mirror-secret', msgCall.body));
      const payload = JSON.parse(msgCall.body);
      expect(payload).toMatchObject({ webhookEventId: ev.webhookEventId, lineUserId: USER, lineMessageId: 'm-20', text: 'ミラーして', displayName: 'テスト太郎' });
      expect(msgCall.body).not.toContain('rt-msg');
      expect(String(payload.sentAt)).toBe(msgCall.headers['X-Mirror-Timestamp']);
      expect(rows<{ mirrored: number }>('SELECT mirrored FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId)).toEqual([{ mirrored: 1 }]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 10_000);

  test('非2xx → mirrored=0 のまま（mirror_attempts=1）→ Cron 再送で mirrored=1', async () => {
    let status = 500;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status })));
    try {
      await post([follow(1000)], env(MIRROR));
      const ev = text('m-21', 'x');
      await post([ev], env(MIRROR));
      expect(rows<{ mirrored: number; mirror_attempts: number }>('SELECT mirrored, mirror_attempts FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId))
        .toEqual([{ mirrored: 0, mirror_attempts: 1 }]);
      status = 200;
      const r = await runInboxMaintenance({
        db: db.asD1(),
        process: vi.fn(),
        mirror: { url: MIRROR.MIRROR_URL, secret: MIRROR.MIRROR_SECRET },
        now: () => Date.now() + RETRY_AFTER_MS + 1000,
      });
      expect(r.remirrored).toBeGreaterThanOrEqual(1);
      expect(rows<{ mirrored: number }>('SELECT mirrored FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId)).toEqual([{ mirrored: 1 }]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 10_000);

  test('MIRROR_URL 未設定 → 転送せず保存時点で mirrored=1', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    try {
      await seedFriend();
      const ev = text('m-22', 'x');
      await post([ev]);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(rows<{ mirrored: number }>('SELECT mirrored FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId)).toEqual([{ mirrored: 1 }]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 10_000);
});

describe('env 未設定（sbo/fzk と同じ）→ 従来挙動', () => {
  test('受信箱に書かず、messages_log は line_message_id なしで記録（同一メッセージ再送は従来どおり2件）', async () => {
    const legacy = env({ WEBHOOK_INBOX: undefined, INCOMING_IMAGE_STORE: undefined });
    await post([follow(1000)], legacy);
    const ev = text('m-30', 'legacy');
    await post([ev], legacy);
    await post([ev], legacy);
    expect(rows('SELECT * FROM webhook_inbox')).toHaveLength(0);
    expect(rows("SELECT line_message_id FROM messages_log WHERE direction = 'incoming'")).toEqual([
      { line_message_id: null },
      { line_message_id: null },
    ]);
  }, 10_000);
});


// ─── CODEX コードレビュー2 の指摘（落ちる→直る）─────────────────────────────

const postback = (data: string, ts = 7000, id = evId()) => ({
  type: 'postback', webhookEventId: id, timestamp: ts, replyToken: 'rt-pb',
  source: { type: 'user', userId: USER }, mode: 'active', deliveryContext: { isRedelivery: false },
  postback: { data },
});

function reprocessDeps(extra: Partial<Parameters<typeof runInboxMaintenance>[0]> = {}) {
  const process = (event: never, accountId: string | null) =>
    handleWebhookEvent(db.asD1(), new LineClient('token'), event, 'token', accountId, 'https://kzn.example', '', undefined, { inbox: true });
  return { db: db.asD1(), process, mirror: null, now: () => Date.now() + RETRY_AFTER_MS + 1000, ...extra };
}

describe('[review2-1] 取消先着の本文は保存時点で伏せる（処理失敗でも残らない）', () => {
  test('unsend → message（処理は失敗）でも webhook_inbox に本文が残らない', async () => {
    await seedFriend();
    await post([unsend('m-40')]);
    db.failOn = /INTO messages_log/;
    const ev = text('m-40', '絶対に残してはいけない');
    await post([ev]);
    db.failOn = null;
    const [row] = rows<{ body_json: string; processed: number }>('SELECT body_json, processed FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId);
    expect(row.processed).toBe(0);
    expect(row.body_json).not.toContain('絶対に残してはいけない');
  }, 10_000);

  test('insertIncomingLog は挿入文の中で取消を判定（呼び出し側が生本文を渡しても伏字で保存）', async () => {
    await seedFriend();
    const friendId = rows<{ id: string }>('SELECT id FROM friends')[0].id;
    db.raw.prepare('INSERT INTO unsent_messages (line_message_id, unsent_at) VALUES (?, ?)').run('m-41', 1);
    const inserted = await insertIncomingLog(db.asD1(), {
      friendId, messageType: 'text', content: '割り込みで残る本文', source: 'user',
      lineMessageId: 'm-41', webhookEventId: 'ev-41', createdAt: 'now',
    });
    expect(inserted).toBe(true);
    expect(rows("SELECT content FROM messages_log WHERE direction = 'incoming'")).toEqual([{ content: UNSENT_PLACEHOLDER }]);
  }, 10_000);
});

describe('[review2-2] follow/unfollow は原子的・未登録 unfollow も記録', () => {
  test('follow のプロフィール取得中に新しい unfollow が完了 → 最終状態はブロック', async () => {
    let injected = false;
    lineMocks.getProfile.mockImplementation(async () => {
      if (!injected) {
        injected = true;
        await post([unfollow(3000)]);
      }
      return { displayName: 'テスト太郎', userId: USER };
    });
    await post([follow(1000)]);
    expect(rows('SELECT is_following FROM friends WHERE line_user_id = ?', USER)).toEqual([{ is_following: 0 }]);
  }, 10_000);

  test('友だち未登録で unfollow(3000) → 古い follow(1000) が後着 → フォロー扱いにしない', async () => {
    await post([unfollow(3000)]);
    await post([follow(1000)]);
    const r = rows<{ is_following: number }>('SELECT is_following FROM friends WHERE line_user_id = ?', USER);
    expect(r.every((x) => x.is_following === 0)).toBe(true);
  }, 10_000);
});

describe('[review2-3] EVENT_BUS_DISABLED=1 でイベントバスと自動応答を止める', () => {
  test('message: fireEvent も auto_reply も動かない（未読化は行う）', async () => {
    db.raw.prepare("INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content) VALUES ('ar1', 'こんにちは', 'exact', 'text', '自動応答')").run();
    const e = env({ EVENT_BUS_DISABLED: '1' });
    await post([follow(1000)], e);
    await post([text('m-50', 'こんにちは')], e);
    await post([postback('こんにちは')], e);
    expect(fireEvent).not.toHaveBeenCalled();
    expect(lineMocks.replyMessage).not.toHaveBeenCalled();
    expect(rows("SELECT * FROM messages_log WHERE direction = 'outgoing'")).toHaveLength(0);
    expect(rows('SELECT * FROM chats')).toHaveLength(1);
  }, 10_000);

  test('未設定なら従来どおり fireEvent が呼ばれる', async () => {
    await seedFriend();
    await post([text('m-51', 'hi')]);
    expect(vi.mocked(fireEvent).mock.calls.some((c) => c[1] === 'message_received')).toBe(true);
  }, 10_000);
});

describe('[review2-4] MIRROR_URL あり・MIRROR_SECRET なし', () => {
  test('mirrored=0・attempts 増やさず保持 → 鍵設定後の Cron で転送', async () => {
    const fetchStub = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    try {
      const e = env({ MIRROR_URL: 'https://mirror.example/x' });
      await post([follow(1000)], e);
      const ev = text('m-60', 'x');
      await post([ev], e);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(rows('SELECT mirrored, mirror_attempts FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId))
        .toEqual([{ mirrored: 0, mirror_attempts: 0 }]);
      const r = await runInboxMaintenance(reprocessDeps({ mirror: { url: 'https://mirror.example/x', secret: 's' } }));
      expect(r.remirrored).toBeGreaterThanOrEqual(1);
      expect(rows('SELECT mirrored FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId)).toEqual([{ mirrored: 1 }]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 10_000);
});

describe('[review2-5] postback 再処理で受信ログが重複しない', () => {
  test('ログ挿入後に完了フラグ更新が失敗 → Cron 再処理でもログ1件', async () => {
    await seedFriend();
    const ev = postback('menu=1');
    db.failOn = /SET processed = 1/;
    await post([ev]);
    db.failOn = null;
    await runInboxMaintenance(reprocessDeps());
    expect(rows("SELECT * FROM messages_log WHERE direction = 'incoming' AND source = 'postback'")).toHaveLength(1);
    expect(rows('SELECT processed FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId)).toEqual([{ processed: 1 }]);
  }, 10_000);
});

describe('[review2-6] テキストの途中失敗は再処理で後続まで完了する', () => {
  test('ログ挿入後に未読化(chats)で失敗 → 再処理で chats が作られる', async () => {
    await seedFriend();
    const ev = text('m-70', '未読にして');
    db.failOn = /INSERT INTO chats/;
    await post([ev]);
    db.failOn = null;
    expect(rows('SELECT * FROM chats')).toHaveLength(0);
    await runInboxMaintenance(reprocessDeps());
    expect(rows('SELECT * FROM chats')).toHaveLength(1);
    expect(rows("SELECT * FROM messages_log WHERE direction = 'incoming'")).toHaveLength(1);
  }, 10_000);
});


// ─── CODEX 再レビュー（review-code3）の残件（落ちる→直る）──────────────────────

describe('[review3-A] unsend の登録は受信箱の同期保存 batch で完結する（非同期処理に頼らない）', () => {
  const save = (events: unknown[]) =>
    saveInboxEvents(db.asD1(), events as never, { lineAccountId: null, mirror: false, now: 1 });

  test('同一リクエストで [message, unsend] → 保存直後（処理前）に生本文が無い', async () => {
    const ev = text('m-80', '同時に取り消す本文');
    await save([ev, unsend('m-80')]);
    const [row] = rows<{ body_json: string }>('SELECT body_json FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId);
    expect(row.body_json).not.toContain('同時に取り消す本文');
    expect(rows('SELECT line_message_id FROM unsent_messages')).toEqual([{ line_message_id: 'm-80' }]);
  });

  test('同一リクエストで [unsend, message] → 保存直後に生本文が無い', async () => {
    const ev = text('m-81', '逆順でも残さない');
    await save([unsend('m-81'), ev]);
    const [row] = rows<{ body_json: string }>('SELECT body_json FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId);
    expect(row.body_json).not.toContain('逆順でも残さない');
  });

  test('別リクエスト（message 保存済み・処理前）→ unsend の保存だけで生本文と受信ログが伏字になる', async () => {
    await seedFriend();
    const ev = text('m-82', '後から取り消す本文');
    await post([ev]); // 処理まで完了して messages_log に本文あり
    await save([unsend('m-82')]); // unsend は保存のみ（処理しない）
    const [row] = rows<{ body_json: string }>('SELECT body_json FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId);
    expect(row.body_json).not.toContain('後から取り消す本文');
    expect(rows("SELECT content FROM messages_log WHERE direction = 'incoming'")).toEqual([{ content: UNSENT_PLACEHOLDER }]);
  }, 10_000);

  test('並行リクエスト（message と unsend を同時に保存）でも生本文が残らない', async () => {
    const ev = text('m-83', '並行で取り消す本文');
    await Promise.all([save([ev]), save([unsend('m-83')])]);
    const [row] = rows<{ body_json: string }>('SELECT body_json FROM webhook_inbox WHERE webhook_event_id = ?', ev.webhookEventId);
    expect(row.body_json).not.toContain('並行で取り消す本文');
  });
});

describe('[review3-B] follow の友だち更新と状態同期は1 batch（途中失敗で friends=1/最新=0 を残さない）', () => {
  test('プロフィール取得中に新しい unfollow → follow の同期だけ失敗しても friends は最新(0)のまま', async () => {
    await post([follow(500)]);
    let injected = false;
    lineMocks.getProfile.mockImplementation(async () => {
      if (!injected) {
        injected = true;
        await post([unfollow(3000)]);
        // この後の follow の同期文だけを失敗させる
        db.failOn = /is_following = \(SELECT s\.is_following FROM friend_follow_state/;
      }
      return { displayName: 'テスト太郎', userId: USER };
    });
    await post([follow(1000)]);
    db.failOn = null;
    expect(rows('SELECT is_following FROM friends WHERE line_user_id = ?', USER)).toEqual([{ is_following: 0 }]);
  }, 10_000);
});

describe('[review3-C] 再処理で対応済みチャットを未読に戻さない', () => {
  test('処理済み更新だけ失敗 → 担当者が対応済みに → Cron 再処理しても resolved のまま・最終受信時刻はイベント時刻', async () => {
    await seedFriend();
    const ev = text('m-90', '対応済みにする', Date.UTC(2026, 8, 27, 0, 0, 0));
    db.failOn = /SET processed = 1/;
    await post([ev]);
    db.failOn = null;
    db.raw.prepare("UPDATE chats SET status = 'resolved'").run();
    await runInboxMaintenance(reprocessDeps());
    const [chat] = rows<{ status: string; last_message_at: string }>('SELECT status, last_message_at FROM chats');
    expect(chat.status).toBe('resolved');
    expect(chat.last_message_at).toBe('2026-09-27T09:00:00.000+09:00');
  }, 10_000);

  test('新しいイベントなら従来どおり resolved → unread に戻す', async () => {
    await seedFriend();
    await post([text('m-91', '1通目', 10_000)]);
    db.raw.prepare("UPDATE chats SET status = 'resolved'").run();
    await post([text('m-92', '2通目', 20_000)]);
    expect(rows('SELECT status FROM chats')).toEqual([{ status: 'unread' }]);
  }, 10_000);
});


// ─── follow を経ていない既存友だち（本番 258 人）からの受信 ───────────────────

describe('[kzn-existing-friend] 受信箱モードで未登録の送信者を友だち登録して記録する', () => {
  const MIRROR = { MIRROR_URL: 'https://mirror.example/api/line-harness-event', MIRROR_SECRET: 'mirror-secret' };

  test('未登録送信者の text → friends 1件・messages_log 1件・ミラーに displayName・friend_add は発火しない', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response('ok', { status: 200 });
    }));
    try {
      const ev = text('m-100', '既存友だちからの相談');
      await post([ev], env(MIRROR));
      expect(rows('SELECT display_name, is_following FROM friends WHERE line_user_id = ?', USER))
        .toEqual([{ display_name: 'テスト太郎', is_following: 1 }]);
      expect(rows("SELECT content FROM messages_log WHERE direction = 'incoming'")).toEqual([{ content: '既存友だちからの相談' }]);
      expect(rows('SELECT * FROM chats')).toHaveLength(1);
      const payload = JSON.parse(bodies.find((b) => JSON.parse(b).webhookEventId === ev.webhookEventId)!);
      expect(payload.displayName).toBe('テスト太郎');
      expect(vi.mocked(fireEvent).mock.calls.some((c) => c[1] === 'friend_add')).toBe(false);
      expect(rows('SELECT * FROM friend_scenarios')).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 10_000);

  test('プロフィール取得に失敗しても登録・記録する（表示名は null）', async () => {
    lineMocks.getProfile.mockRejectedValue(new Error('profile 404'));
    await post([text('m-101', 'プロフィール取れない')]);
    expect(rows('SELECT display_name, is_following FROM friends WHERE line_user_id = ?', USER))
      .toEqual([{ display_name: null, is_following: 1 }]);
    expect(rows("SELECT content FROM messages_log WHERE direction = 'incoming'")).toEqual([{ content: 'プロフィール取れない' }]);
  }, 10_000);

  test('unfollow 済み（friend_follow_state=0）の送信者は is_following=0 のまま登録', async () => {
    await post([unfollow(3000)]); // 未登録のまま状態だけ記録される
    await post([text('m-102', 'ブロック後に届いた')]);
    expect(rows('SELECT is_following FROM friends WHERE line_user_id = ?', USER)).toEqual([{ is_following: 0 }]);
    expect(rows("SELECT * FROM messages_log WHERE direction = 'incoming'")).toHaveLength(1);
  }, 10_000);

  test('未登録送信者の画像・postback も記録する', async () => {
    await post([image('img-100')]);
    await post([{ type: 'postback', webhookEventId: evId(), timestamp: 8000, replyToken: 'rt', source: { type: 'user', userId: USER }, mode: 'active', deliveryContext: { isRedelivery: false }, postback: { data: 'menu=2' } }]);
    expect(rows('SELECT * FROM friends')).toHaveLength(1);
    expect(rows("SELECT source, content FROM messages_log WHERE direction = 'incoming' ORDER BY source")).toEqual([
      { source: 'postback', content: 'menu=2' },
      { source: 'user', content: '[画像]' },
    ]);
  }, 10_000);

  test('env 未設定（従来）では未登録送信者のメッセージは従来どおり記録しない', async () => {
    await post([text('m-103', 'legacy')], env({ WEBHOOK_INBOX: undefined }));
    expect(rows('SELECT * FROM friends')).toHaveLength(0);
    expect(rows('SELECT * FROM messages_log')).toHaveLength(0);
  }, 10_000);
});
