/**
 * [Craval kzn] LINE_MEDIA_STORE（受信メディアの非公開保全）のテスト。
 * DB は node:sqlite 上の D1 互換アダプタ（bootstrap + K001〜K003）、R2 はメモリ実装、LINE API は fetch スタブ。
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import type { WebhookEvent } from '@line-crm/line-sdk';
import { createKznTestDb, type SqliteD1 } from '../test-utils/sqlite-d1.js';
import { saveInboxEvents, applyUnsend, buildMirrorPayload } from './webhook-inbox.js';
import {
  setLineMediaEnabled,
  fetchLineMedia,
  purgeUnsentMedia,
  runLineMediaMaintenance,
  mirrorMediaRow,
  getMediaRow,
  mediaMirrorFields,
  userHash,
  MAX_MEDIA_BYTES,
  MEDIA_RETRY_SCHEDULE_MS,
  MEDIA_WAL_GRACE_MS,
  MEDIA_WAL_TOMBSTONE_MS,
} from './line-media.js';

const USER = 'U0000000000000000000000000000media';
const T0 = 1_800_000_000_000;

class MemR2 {
  objects = new Map<string, { body: Uint8Array; contentType?: string }>();
  putFails = false;
  async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
    if (this.putFails) throw new Error('r2 down');
    this.objects.set(key, { body: value, contentType: opts?.httpMetadata?.contentType });
    return {};
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  asR2(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

let db: SqliteD1;
let r2: MemR2;
let seq = 0;
const evId = () => `01MEDIAEVENT${String(++seq).padStart(14, '0')}`;

function media(messageId: string, type = 'image', extra: Record<string, unknown> = {}): WebhookEvent {
  return {
    type: 'message',
    webhookEventId: evId(),
    timestamp: T0,
    source: { type: 'user', userId: USER },
    mode: 'active',
    deliveryContext: { isRedelivery: false },
    message: { id: messageId, type, contentProvider: { type: 'line' }, ...extra },
  } as unknown as WebhookEvent;
}
function textEv(messageId: string): WebhookEvent {
  return {
    type: 'message', webhookEventId: evId(), timestamp: T0, source: { type: 'user', userId: USER },
    message: { id: messageId, type: 'text', text: 'hi' },
  } as unknown as WebhookEvent;
}
function unsendEv(messageId: string): WebhookEvent {
  return { type: 'unsend', webhookEventId: evId(), timestamp: T0 + 1, source: { type: 'user', userId: USER }, unsend: { messageId } } as unknown as WebhookEvent;
}

const q = (sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...(p as never[])) as Record<string, unknown>[];

function contentResponse(bytes: number, contentType = 'image/jpeg', withLength = true) {
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (withLength) headers['Content-Length'] = String(bytes);
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

function deps(fetchFn: typeof fetch, now = () => T0) {
  return { db: db.asD1(), r2: r2.asR2(), tokenFor: () => 'token', fetchFn, now };
}

async function save(events: WebhookEvent[], now = T0) {
  return saveInboxEvents(db.asD1(), events, { lineAccountId: null, mirror: true, now });
}

beforeEach(() => {
  db = createKznTestDb();
  r2 = new MemR2();
  setLineMediaEnabled(true);
});
afterEach(() => {
  setLineMediaEnabled(false);
  vi.unstubAllGlobals();
});

describe('保存時の登録', () => {
  test('画像・動画・音声・ファイルは取得待ち、テキストは対象外', async () => {
    await save([media('m1', 'image'), media('m2', 'video'), media('m3', 'audio'), media('m4', 'file', { fileName: '住民票.pdf' }), textEv('m5')]);
    const rows = q('SELECT line_message_id, status, message_type, file_name FROM line_media ORDER BY line_message_id');
    expect(rows.map((r) => [r.line_message_id, r.status])).toEqual([
      ['m1', 'pending'], ['m2', 'pending'], ['m3', 'pending'], ['m4', 'pending'],
    ]);
    expect(rows[3].file_name).toBe('住民票.pdf');
  });

  test('外部提供（contentProvider=external）は取得不能で確定', async () => {
    await save([media('m1', 'image', { contentProvider: { type: 'external', originalContentUrl: 'https://x' } })]);
    expect(q('SELECT status, reason FROM line_media')[0]).toMatchObject({ status: 'expired', reason: 'external' });
  });

  test('取消が先着していれば unsent で登録（取得しない）', async () => {
    await save([unsendEv('m1')]);
    await save([media('m1')]);
    expect(q('SELECT status FROM line_media')[0].status).toBe('unsent');
    const fetchFn = vi.fn();
    expect(await fetchLineMedia(deps(fetchFn as never), 'm1')).toBe('skipped');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('同一リクエストで message→unsend でも unsent', async () => {
    await save([media('m1'), unsendEv('m1')]);
    expect(q('SELECT status FROM line_media')[0].status).toBe('unsent');
  });

  test('user_hash は userId の SHA-256 先頭16桁（userId そのものは保存しない）', async () => {
    await save([media('m1')]);
    const row = q('SELECT * FROM line_media')[0];
    expect(row.user_hash).toBe(await userHash(USER));
    expect(JSON.stringify(row)).not.toContain(USER);
  });

  test('env 未設定（フラグ off）なら line_media に触れない＝K003 未適用の DB でも従来どおり', async () => {
    setLineMediaEnabled(false);
    db = createKznTestDb({ withMedia: false });
    await expect(save([media('m1'), unsendEv('m1')])).resolves.toBeTruthy();
    await expect(applyUnsend(db.asD1(), 'm1', T0)).resolves.toBeUndefined();
  });
});

describe('取得と保存', () => {
  test('成功: 非公開 R2 に保存・キーに PII なし・状態 done・未転送', async () => {
    await save([media('100001')]);
    const out = await fetchLineMedia(deps(vi.fn(async () => contentResponse(1234)) as never), '100001');
    expect(out).toBe('done');
    const row = await getMediaRow(db.asD1(), '100001');
    expect(row).toMatchObject({ status: 'done', content_type: 'image/jpeg', size: 1234 });
    expect(row!.r2_key).toMatch(/^line-media\/[0-9a-f]{16}\/100001-[0-9a-f]{32}\.jpg$/);
    expect(row!.r2_key).not.toContain(USER);
    expect(r2.objects.get(row!.r2_key!)?.contentType).toBe('image/jpeg');
    expect(q('SELECT mirrored FROM line_media')[0].mirrored).toBe(0);
  });

  test('ファイルは Content-Type が汎用でもファイル名の拡張子を使う', async () => {
    await save([media('100002', 'file', { fileName: 'doc.PDF' })]);
    await fetchLineMedia(deps(vi.fn(async () => contentResponse(10, 'application/octet-stream')) as never), '100002');
    expect((await getMediaRow(db.asD1(), '100002'))!.r2_key).toMatch(/100002-[0-9a-f]{32}\.pdf$/);
  });

  test.each([404, 410])('%s は取得不能で確定（再試行しない）', async (status) => {
    await save([media('m1')]);
    const out = await fetchLineMedia(deps(vi.fn(async () => new Response('', { status })) as never), 'm1');
    expect(out).toBe('expired');
    expect(q('SELECT status, reason FROM line_media')[0]).toMatchObject({ status: 'expired', reason: `gone_${status}` });
  });

  test('Content-Length が 25MB 超は読まずに確定', async () => {
    await save([media('m1', 'video')]);
    const out = await fetchLineMedia(deps(vi.fn(async () => new Response(new Uint8Array(10), {
      status: 200, headers: { 'Content-Length': String(MAX_MEDIA_BYTES + 1), 'Content-Type': 'video/mp4' },
    })) as never), 'm1');
    expect(out).toBe('expired');
    expect(q('SELECT reason FROM line_media')[0].reason).toBe('too_large');
    expect(r2.objects.size).toBe(0);
  });

  test('Content-Length 無しでも読み込み中に 25MB を超えたら打ち切って確定', async () => {
    await save([media('m1', 'video')]);
    const out = await fetchLineMedia(deps(vi.fn(async () => contentResponse(MAX_MEDIA_BYTES + 5, 'video/mp4', false)) as never), 'm1');
    expect(out).toBe('expired');
    expect(r2.objects.size).toBe(0);
  });

  test('一時失敗は受信直後→5分後→60分後の3回で打ち切り（failed）', async () => {
    await save([media('m1')], T0);
    const fail = vi.fn(async () => new Response('', { status: 500 })) as never;
    expect(await fetchLineMedia(deps(fail), 'm1')).toBe('pending');
    expect(q('SELECT attempts, next_attempt_at FROM line_media')[0]).toMatchObject({ attempts: 1, next_attempt_at: T0 + MEDIA_RETRY_SCHEDULE_MS[1] });
    expect(await fetchLineMedia(deps(fail), 'm1')).toBe('pending');
    expect(q('SELECT attempts, next_attempt_at FROM line_media')[0]).toMatchObject({ attempts: 2, next_attempt_at: T0 + MEDIA_RETRY_SCHEDULE_MS[2] });
    expect(await fetchLineMedia(deps(fail), 'm1')).toBe('failed');
    expect(q('SELECT status, reason, mirrored FROM line_media')[0]).toMatchObject({ status: 'failed', reason: 'http_500', mirrored: 0 });
  });

  test('ネットワーク例外・R2 失敗も一時失敗として再試行', async () => {
    await save([media('m1')]);
    expect(await fetchLineMedia(deps(vi.fn(async () => { throw new TypeError('net'); }) as never), 'm1')).toBe('pending');
    r2.putFails = true;
    expect(await fetchLineMedia(deps(vi.fn(async () => contentResponse(5)) as never), 'm1')).toBe('pending');
    expect(q('SELECT attempts FROM line_media')[0].attempts).toBe(2);
  });

  test('Cron は予定時刻に達した行だけ取得する', async () => {
    await save([media('m1')], T0);
    const fail = vi.fn(async () => new Response('', { status: 503 })) as never;
    await fetchLineMedia(deps(fail), 'm1'); // attempts=1, 次は +5分
    const ok = vi.fn(async () => contentResponse(3));
    let r = await runLineMediaMaintenance({ ...deps(ok as never, () => T0 + 60_000), mirror: null });
    expect(r.fetched).toBe(0);
    expect(ok).not.toHaveBeenCalled();
    r = await runLineMediaMaintenance({ ...deps(ok as never, () => T0 + MEDIA_RETRY_SCHEDULE_MS[1]), mirror: null });
    expect(r.fetched).toBe(1);
  });
});

describe('送信取消', () => {
  test('保存済みの後に取消 → unsent・Cron/直後の削除で R2 から消える', async () => {
    await save([media('m1')]);
    await fetchLineMedia(deps(vi.fn(async () => contentResponse(8)) as never), 'm1');
    expect(r2.objects.size).toBe(1);
    await save([unsendEv('m1')]);
    expect(q('SELECT status FROM line_media')[0].status).toBe('unsent');
    expect(await purgeUnsentMedia(db.asD1(), r2.asR2(), T0)).toBe(1);
    expect(r2.objects.size).toBe(0);
    expect(q('SELECT r2_key, r2_deleted FROM line_media')[0]).toMatchObject({ r2_key: null, r2_deleted: 1 });
  });

  test('取得中に取消されたら、書いたオブジェクトを消して unsent', async () => {
    await save([media('m1')]);
    const fetchFn = vi.fn(async () => {
      await applyUnsend(db.asD1(), 'm1', T0 + 1); // 取得の最中に取消が届く
      return contentResponse(8);
    });
    expect(await fetchLineMedia(deps(fetchFn as never), 'm1')).toBe('unsent');
    expect(r2.objects.size).toBe(0);
  });

  test('取消済みメッセージのミラーにはメディア情報を載せない', async () => {
    await save([media('m1')]);
    await fetchLineMedia(deps(vi.fn(async () => contentResponse(8)) as never), 'm1');
    const row = (await getMediaRow(db.asD1(), 'm1'))!;
    const p = buildMirrorPayload(media('m1'), { sentAt: T0, unsent: true, media: mediaMirrorFields(row) });
    expect(p.mediaKey).toBeUndefined();
    expect(p.mediaStatus).toBeUndefined();
  });
});

describe('きずなへの状態転送', () => {
  const MIRROR = { url: 'https://mirror.example/api/line-harness-event', secret: 'mirror-secret' };

  test('done を署名付きで送り mirrored=1・同じ状態は冪等キー media:<id>:<status>', async () => {
    await save([media('m1')]);
    await fetchLineMedia(deps(vi.fn(async () => contentResponse(8)) as never), 'm1');
    const fetchFn = vi.fn(async (_u: string, init: RequestInit) => new Response('ok', { status: 200 }));
    expect(await mirrorMediaRow({ db: db.asD1(), ...MIRROR, fetchFn: fetchFn as never, now: () => T0 }, 'm1')).toBe(true);
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ webhookEventId: 'media:m1:done', eventType: 'media', lineMessageId: 'm1', mediaStatus: 'done', mediaContentType: 'image/jpeg', mediaSize: 8 });
    expect(body.mediaKey).toMatch(/^line-media\//);
    expect(body.lineUserId).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-Mirror-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(q('SELECT mirrored FROM line_media')[0].mirrored).toBe(1);
  });

  test('転送失敗は mirror_attempts++ で Cron が再送', async () => {
    await save([media('m1')]);
    await fetchLineMedia(deps(vi.fn(async () => new Response('', { status: 404 })) as never), 'm1');
    const fetchFn = vi.fn(async () => new Response('x', { status: 500 }));
    expect(await mirrorMediaRow({ db: db.asD1(), ...MIRROR, fetchFn: fetchFn as never }, 'm1')).toBe(false);
    expect(q('SELECT mirrored, mirror_attempts FROM line_media')[0]).toMatchObject({ mirrored: 0, mirror_attempts: 1 });
    const ok = vi.fn(async () => new Response('ok', { status: 200 }));
    const r = await runLineMediaMaintenance({ ...deps(ok as never), mirror: MIRROR });
    expect(r.mirrored).toBe(1);
    expect(JSON.parse((ok.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ mediaStatus: 'expired', mediaReason: 'gone_404' });
  });

  test('鍵が無ければ転送しない（試行回数も進めない）', async () => {
    await save([media('m1')]);
    await fetchLineMedia(deps(vi.fn(async () => contentResponse(8)) as never), 'm1');
    const fetchFn = vi.fn();
    expect(await mirrorMediaRow({ db: db.asD1(), url: MIRROR.url, secret: undefined, fetchFn: fetchFn as never }, 'm1')).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(q('SELECT mirror_attempts FROM line_media')[0].mirror_attempts).toBe(0);
  });
});

describe('CODEX レビュー反映（並行・準備中・取消後の削除失敗）', () => {
  test('202（動画・音声の準備中）は保存せず再試行（done にしない）', async () => {
    await save([media('m1', 'video')]);
    const out = await fetchLineMedia(deps(vi.fn(async () => new Response(null, { status: 202 })) as never), 'm1');
    expect(out).toBe('pending');
    expect(q('SELECT status, reason, attempts FROM line_media')[0]).toMatchObject({ status: 'pending', reason: 'preparing', attempts: 1 });
    expect(r2.objects.size).toBe(0);
  });

  test('取得中（lease 有効）の行は別の実行が取らない＝並行取得でオブジェクトを消さない', async () => {
    await save([media('m1')]);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    const slow = vi.fn(async () => { await gate; return contentResponse(8); });
    const first = fetchLineMedia(deps(slow as never), 'm1');
    await new Promise((r) => setTimeout(r, 0));
    const second = vi.fn(async () => contentResponse(8));
    expect(await fetchLineMedia(deps(second as never), 'm1')).toBe('skipped');
    expect(second).not.toHaveBeenCalled();
    releaseFirst();
    expect(await first).toBe('done');
    const row = (await getMediaRow(db.asD1(), 'm1'))!;
    expect(r2.objects.has(row.r2_key!)).toBe(true);
  });

  test('lease の期限が切れていれば取り直せる（落ちた実行の取り残し）', async () => {
    await save([media('m1')]);
    db.raw.prepare('UPDATE line_media SET lease_until = ? WHERE line_message_id = ?').run(T0 - 1, 'm1');
    expect(await fetchLineMedia(deps(vi.fn(async () => contentResponse(3)) as never), 'm1')).toBe('done');
  });

  test('期限切れ後に別の実行が確定させた → 元の実行は確定できず、自分の書込み（実行ごとに一意なキー）だけを消す', async () => {
    await save([media('m1')]);
    const fetchFn = vi.fn(async () => {
      // 取得中に lease が切れ、別の実行が取り直して確定した（token が変わる）
      db.raw.prepare("UPDATE line_media SET status='done', r2_key='line-media/x/m1-aaaaaaaa.jpg', lease_token=NULL WHERE line_message_id='m1'").run();
      r2.objects.set('line-media/x/m1-aaaaaaaa.jpg', { body: new Uint8Array(1) });
      return contentResponse(8);
    });
    expect(await fetchLineMedia(deps(fetchFn as never), 'm1')).toBe('skipped');
    expect([...r2.objects.keys()]).toEqual(['line-media/x/m1-aaaaaaaa.jpg']); // 他の実行の保存は残し、自分の書込みは消えた
  });

  test('期限切れ後に別の実行が failed で確定 → 元の実行の書込みを消す・削除失敗は先行ログが残り猶予後に Cron が回収', async () => {
    await save([media('m1')]);
    const origDelete = r2.delete.bind(r2);
    let failDelete = true;
    r2.delete = async (k: string) => { if (failDelete) throw new Error('down'); return origDelete(k); };
    const fetchFn = vi.fn(async () => {
      db.raw.prepare("UPDATE line_media SET status='failed', lease_token=NULL WHERE line_message_id='m1'").run();
      return contentResponse(8);
    });
    expect(await fetchLineMedia(deps(fetchFn as never), 'm1')).toBe('skipped');
    expect(r2.objects.size).toBe(1);
    // 自分の put は完了済み＝回収中（2）にしてから消す。削除失敗でも記録は回収中のまま残る
    expect(q('SELECT committed FROM line_media_writes')).toEqual([{ committed: 2 }]);
    failDelete = false;
    expect(await purgeUnsentMedia(db.asD1(), r2.asR2(), T0 + 60_000)).toBe(1); // 回収中は猶予を待たずに消し直す
    expect(r2.objects.size).toBe(0);
    expect(q('SELECT committed FROM line_media_writes')).toEqual([{ committed: 2 }]); // 7日間は記録を残す
  });

  test('取得中に取消 → R2 削除に失敗しても先行ログが残り、猶予後に Cron が回収', async () => {
    await save([media('m1')]);
    const origDelete = r2.delete.bind(r2);
    let failDelete = true;
    r2.delete = async (k: string) => { if (failDelete) throw new Error('r2 delete down'); return origDelete(k); };
    const fetchFn = vi.fn(async () => { await applyUnsend(db.asD1(), 'm1', T0 + 1); return contentResponse(8); });
    expect(await fetchLineMedia(deps(fetchFn as never), 'm1')).toBe('unsent');
    expect(r2.objects.size).toBe(1);
    failDelete = false;
    expect(await purgeUnsentMedia(db.asD1(), r2.asR2(), T0 + MEDIA_WAL_GRACE_MS + 1)).toBe(1);
    expect(r2.objects.size).toBe(0);
  });

  test('R2 書込み後に done 確定が例外（DB 障害・中断）→ 先行ログが残り、猶予後に Cron が R2 から消す', async () => {
    await save([media('m1')]);
    db.failOn = /SET status = 'done'/;
    await expect(fetchLineMedia(deps(vi.fn(async () => contentResponse(8)) as never), 'm1')).rejects.toThrow();
    db.failOn = null;
    expect(r2.objects.size).toBe(1);
    expect(q('SELECT committed FROM line_media_writes')).toEqual([{ committed: 0 }]);
    expect(await purgeUnsentMedia(db.asD1(), r2.asR2(), T0 + MEDIA_WAL_GRACE_MS + 1)).toBe(1);
    expect(r2.objects.size).toBe(0);
    // 行は pending のまま（lease 期限後に再取得される）
    expect(q('SELECT status FROM line_media')[0].status).toBe('pending');
  });

  test('成功時は先行ログが確定済みになり、Cron は消さない', async () => {
    await save([media('m1')]);
    expect(await fetchLineMedia(deps(vi.fn(async () => contentResponse(8)) as never), 'm1')).toBe('done');
    expect(q('SELECT committed FROM line_media_writes')).toEqual([{ committed: 1 }]);
    expect(await purgeUnsentMedia(db.asD1(), r2.asR2(), T0 + MEDIA_WAL_GRACE_MS + 1)).toBe(0);
    expect(r2.objects.size).toBe(1);
  });

  test('実行ごとのキーは取得トークン全体（32桁）', async () => {
    await save([media('m1')]);
    await fetchLineMedia(deps(vi.fn(async () => contentResponse(8)) as never), 'm1');
    expect((await getMediaRow(db.asD1(), 'm1'))!.r2_key).toMatch(/\/m1-[0-9a-f]{32}\.jpg$/);
  });

  test('回収と確定は DB 上で排他: 回収中（2）に切り替わった後の確定は効かず、自分の書込みを消す', async () => {
    await save([media('m1')]);
    const fetchFn = vi.fn(async () => {
      // 取得中に猶予が過ぎ、Cron が先行ログを回収中にした（遅い実行）
      return contentResponse(8);
    });
    // put の直前に Cron が回収に回す状況を作る: r2.put をフックして、書込み直後に回収中へ切り替える
    const origPut = r2.put.bind(r2);
    r2.put = async (k: string, v: Uint8Array, o?: { httpMetadata?: { contentType?: string } }) => {
      await origPut(k, v, o);
      db.raw.prepare('UPDATE line_media_writes SET committed = 2 WHERE r2_key = ?').run(k);
      return {};
    };
    expect(await fetchLineMedia(deps(fetchFn as never), 'm1')).toBe('skipped');
    expect(q('SELECT status FROM line_media')[0].status).toBe('pending'); // done にならない
    expect(r2.objects.size).toBe(0); // 自分の書込みは消した
  });

  test('確定が先なら回収は何もしない（確定済み 1 は回収対象外）', async () => {
    await save([media('m1')]);
    expect(await fetchLineMedia(deps(vi.fn(async () => contentResponse(8)) as never), 'm1')).toBe('done');
    expect(await purgeUnsentMedia(db.asD1(), r2.asR2(), T0 + MEDIA_WAL_GRACE_MS * 10)).toBe(0);
    expect(r2.objects.size).toBe(1);
  });

  test('回収後に遅れて put が完了しても、回収中の記録が残る間は Cron が消し直す・7日後に記録を消す', async () => {
    await save([media('m1')]);
    db.raw.prepare("INSERT INTO line_media_writes (r2_key, line_message_id, committed, created_at) VALUES ('line-media/x/m1-late.jpg', 'm1', 0, ?)").run(T0);
    expect(await purgeUnsentMedia(db.asD1(), r2.asR2(), T0 + MEDIA_WAL_GRACE_MS + 1)).toBe(1); // 回収中へ→削除（まだ無い）
    r2.objects.set('line-media/x/m1-late.jpg', { body: new Uint8Array(1) }); // 遅れて put が完了
    await purgeUnsentMedia(db.asD1(), r2.asR2(), T0 + MEDIA_WAL_GRACE_MS + 10);
    expect(r2.objects.has('line-media/x/m1-late.jpg')).toBe(false);
    expect(q('SELECT count(*) AS n FROM line_media_writes')[0].n).toBe(1);
    await purgeUnsentMedia(db.asD1(), r2.asR2(), T0 + MEDIA_WAL_TOMBSTONE_MS + 1);
    expect(q('SELECT count(*) AS n FROM line_media_writes')[0].n).toBe(0);
  });
});
