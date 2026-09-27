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
import { runInboxMaintenance, hmacHex, UNSENT_PLACEHOLDER, RETRY_AFTER_MS } from '../services/webhook-inbox.js';

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
    expect(rows('SELECT is_following, follow_state_at FROM friends WHERE line_user_id = ?', USER))
      .toEqual([{ is_following: 0, follow_state_at: 3000 }]);
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
