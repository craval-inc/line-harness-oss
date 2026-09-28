/**
 * [Craval kzn] LINE 受信メディアの保全（LINE_MEDIA_STORE=1 かつ WEBHOOK_INBOX=1・R2 バインディング LINE_MEDIA がある環境だけ）。
 * 未設定なら一切呼ばれない＝本家と同一挙動。
 *
 * - webhook_inbox に保存するのと同じ batch で line_media に「取得待ち」を登録する（取得は保存の後）。
 * - Content API から取得して **非公開** R2 に保存する（公開 URL は作らない。本家 INCOMING_IMAGE_STORE の公開保存とは別物）。
 * - 再試行は受信直後・5分後・60分後の3回。404/410・外部提供・25MB 超は「取得不能」で確定（再試行しない）。
 * - 送信取消は保存と同じトランザクションで unsent にし、保存済みオブジェクトは削除する（取得中に取消されても消す）。
 * - 状態の変化はきずなへ署名付きで転送する（webhookEventId=`media:<messageId>:<status>` で冪等）。
 *
 * このモジュールは webhook-inbox.ts から読まれるので、逆向きの import はしない（循環を避ける）。
 */
import type { WebhookEvent } from '@line-crm/line-sdk';

export const MEDIA_MESSAGE_TYPES = new Set(['image', 'video', 'audio', 'file']);
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
/** n 回目の試行を受信から何ms後に行うか（0 回目＝受信直後）。長さ＝最大試行回数。 */
export const MEDIA_RETRY_SCHEDULE_MS = [0, 5 * 60 * 1000, 60 * 60 * 1000];
export const MEDIA_MAX_MIRROR_ATTEMPTS = 5;
const LINE_CONTENT_API_BASE = 'https://api-data.line.me/v2/bot/message';
const MAX_REASON = 200;

export type MediaStatus = 'pending' | 'done' | 'failed' | 'expired' | 'unsent';

let enabled = false;
/** fetch / scheduled 入口で env から反映する（applyCravalRuntimeFlags）。 */
export function setLineMediaEnabled(on: boolean): void {
  enabled = on;
}
export function lineMediaEnabled(): boolean {
  return enabled;
}

export function lineMediaConfigured(env: { WEBHOOK_INBOX?: string; LINE_MEDIA_STORE?: string; LINE_MEDIA?: unknown }): boolean {
  return env.WEBHOOK_INBOX === '1' && env.LINE_MEDIA_STORE === '1' && !!env.LINE_MEDIA;
}

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
};

type MediaEvent = WebhookEvent & {
  webhookEventId?: string;
  timestamp?: number;
  source?: { userId?: string };
  message?: { id?: string; type?: string; fileName?: string; contentProvider?: { type?: string } };
};

/** userId の SHA-256 先頭16桁（R2 キーの分散用。PII をキーに入れない）。 */
export async function userHash(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export function extFor(contentType: string | null, fileName: string | null | undefined): string {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (CONTENT_TYPE_TO_EXT[ct]) return CONTENT_TYPE_TO_EXT[ct];
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(fileName ?? '')?.[1]?.toLowerCase();
  return fromName ?? 'bin';
}

/** 実行（取得権）ごとに一意なキー。別の実行と同じキーを書かない＝所有権を失った実行が自分の書込みだけを安全に消せる。 */
export function mediaKey(hash: string, messageId: string, ext: string, attemptTag: string): string {
  const safeId = messageId.replace(/[^0-9A-Za-z]/g, '_');
  const tag = attemptTag.replace(/[^0-9a-f]/gi, '').slice(0, 8).toLowerCase();
  return `line-media/${hash}/${safeId}-${tag}.${ext}`;
}

/** 保存 batch に入れる line_media 登録文。メディアでない・ID 欠落なら null。取消済み・外部提供は即確定。 */
export async function mediaInsertStatement(
  db: D1Database,
  event: WebhookEvent,
  opts: { lineAccountId: string | null; now: number },
): Promise<D1PreparedStatement | null> {
  const e = event as MediaEvent;
  if ((e as { type?: string }).type !== 'message') return null;
  const msg = e.message;
  const messageId = msg?.id;
  const userId = e.source?.userId;
  if (!msg?.type || !MEDIA_MESSAGE_TYPES.has(msg.type) || !messageId || !userId || !e.webhookEventId) return null;
  const external = msg.contentProvider?.type === 'external';
  const hash = await userHash(userId);
  return db
    .prepare(
      `INSERT OR IGNORE INTO line_media
         (line_message_id, webhook_event_id, line_account_id, user_hash, message_type, file_name,
          status, reason, attempts, next_attempt_at, received_at, mirrored, mirror_attempts, r2_deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?,
          CASE WHEN EXISTS (SELECT 1 FROM unsent_messages WHERE line_message_id = ?) THEN 'unsent'
               WHEN ? = 1 THEN 'expired' ELSE 'pending' END,
          CASE WHEN ? = 1 THEN 'external' ELSE NULL END,
          0, ?, ?, 1, 0, 0, ?)`,
    )
    .bind(
      messageId,
      e.webhookEventId,
      opts.lineAccountId,
      hash,
      msg.type,
      typeof msg.fileName === 'string' ? msg.fileName.slice(0, 200) : null,
      messageId,
      external ? 1 : 0,
      external ? 1 : 0,
      opts.now,
      opts.now,
      opts.now,
    );
}

/** 送信取消の文（unsendStatements に足す）。保存済みは Cron/直後処理で R2 から消す。 */
export function mediaUnsendStatement(db: D1Database, lineMessageId: string, now: number): D1PreparedStatement {
  return db
    .prepare(`UPDATE line_media SET status = 'unsent', updated_at = ? WHERE line_message_id = ? AND status <> 'unsent'`)
    .bind(now, lineMessageId);
}

export interface MediaRow {
  line_message_id: string;
  line_account_id: string | null;
  user_hash: string;
  message_type: string;
  file_name: string | null;
  status: MediaStatus;
  reason: string | null;
  r2_key: string | null;
  content_type: string | null;
  size: number | null;
  attempts: number;
  received_at: number;
}

export async function getMediaRow(db: D1Database, lineMessageId: string): Promise<MediaRow | null> {
  return db
    .prepare(
      `SELECT line_message_id, line_account_id, user_hash, message_type, file_name, status, reason, r2_key,
              content_type, size, attempts, received_at
         FROM line_media WHERE line_message_id = ?`,
    )
    .bind(lineMessageId)
    .first<MediaRow>();
}

export interface FetchMediaDeps {
  db: D1Database;
  r2: R2Bucket;
  /** line_account_id → チャネルアクセストークン（無ければ既定トークン）。 */
  tokenFor: (lineAccountId: string | null) => string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

export type FetchOutcome = MediaStatus | 'skipped';

function trimReason(r: string): string {
  return r.slice(0, MAX_REASON);
}

/** 期限切れ・取得不能（確定）。 */
async function markExpired(db: D1Database, id: string, reason: string, now: number, token: string): Promise<void> {
  await db
    .prepare(
      `UPDATE line_media SET status = 'expired', reason = ?, mirrored = 0, mirror_attempts = 0, lease_until = NULL, lease_token = NULL, updated_at = ?
        WHERE line_message_id = ? AND status = 'pending' AND lease_token = ?`,
    )
    .bind(trimReason(reason), now, id, token)
    .run();
}

/** 一時失敗: 試行回数を進め、次の予定時刻を入れる。使い切ったら failed（確定）。 */
async function markRetry(db: D1Database, row: MediaRow, reason: string, now: number, token: string): Promise<MediaStatus> {
  const nextAttempt = row.attempts + 1;
  if (nextAttempt >= MEDIA_RETRY_SCHEDULE_MS.length) {
    await db
      .prepare(
        `UPDATE line_media SET status = 'failed', attempts = ?, reason = ?, mirrored = 0, mirror_attempts = 0, lease_until = NULL, lease_token = NULL, updated_at = ?
          WHERE line_message_id = ? AND status = 'pending' AND lease_token = ?`,
      )
      .bind(nextAttempt, trimReason(reason), now, row.line_message_id, token)
      .run();
    return 'failed';
  }
  await db
    .prepare(
      `UPDATE line_media SET attempts = ?, reason = ?, next_attempt_at = ?, lease_until = NULL, lease_token = NULL, updated_at = ?
        WHERE line_message_id = ? AND status = 'pending' AND lease_token = ?`,
    )
    .bind(nextAttempt, trimReason(reason), row.received_at + MEDIA_RETRY_SCHEDULE_MS[nextAttempt], now, row.line_message_id, token)
    .run();
  return 'pending';
}

/** 本文を上限付きで読む。上限超過は null。 */
async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** 取得の排他期限（Content API 20秒＋R2 書込の余裕）。期限切れなら別の実行が取り直せる。 */
export const MEDIA_LEASE_MS = 2 * 60 * 1000;

/**
 * 1 件取得して保存する。取得待ち（pending）で、他の実行が取得中（lease 有効）でない行だけが対象。
 * 返り値は処理後の状態（pending＝再試行予定）。取消済み・対象外・他が取得中は 'skipped'。
 */
export async function fetchLineMedia(deps: FetchMediaDeps, lineMessageId: string): Promise<FetchOutcome> {
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const { db } = deps;
  // 排他: Webhook 直後の取得と Cron が同じ行を同時に取らない（並行取得で正常なオブジェクトを消す事故の防止）。
  // 状態の確定は lease_token が一致する所有者だけ（期限切れ後に別の実行が取り直したら、元の実行は確定できない）。
  const t0 = now();
  const token = crypto.randomUUID().replace(/-/g, '');
  const claim = await db
    .prepare(
      `UPDATE line_media SET lease_until = ?, lease_token = ?, updated_at = ?
        WHERE line_message_id = ? AND status = 'pending' AND (lease_until IS NULL OR lease_until <= ?)`,
    )
    .bind(t0 + MEDIA_LEASE_MS, token, t0, lineMessageId, t0)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return 'skipped';
  const row = await getMediaRow(db, lineMessageId);
  if (!row || row.status !== 'pending') return 'skipped';

  let res: Response;
  try {
    res = await fetchFn(`${LINE_CONTENT_API_BASE}/${encodeURIComponent(row.line_message_id)}/content`, {
      headers: { Authorization: `Bearer ${deps.tokenFor(row.line_account_id)}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return markRetry(db, row, `fetch: ${err instanceof Error ? err.name : 'error'}`, now(), token);
  }
  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => {});
    await markExpired(db, row.line_message_id, `gone_${res.status}`, now(), token);
    return 'expired';
  }
  // 202 = 動画・音声の変換準備中（本文は空）。保存せず再試行。200 以外は全て一時失敗扱い。
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return markRetry(db, row, res.status === 202 ? 'preparing' : `http_${res.status}`, now(), token);
  }
  const declared = Number(res.headers.get('Content-Length') ?? '0');
  if (declared > MAX_MEDIA_BYTES) {
    await res.body?.cancel().catch(() => {});
    await markExpired(db, row.line_message_id, 'too_large', now(), token);
    return 'expired';
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readLimited(res, MAX_MEDIA_BYTES);
  } catch (err) {
    return markRetry(db, row, `read: ${err instanceof Error ? err.name : 'error'}`, now(), token);
  }
  if (bytes === null) {
    await markExpired(db, row.line_message_id, 'too_large', now(), token);
    return 'expired';
  }

  const contentType = (res.headers.get('Content-Type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const key = mediaKey(row.user_hash, row.line_message_id, extFor(contentType, row.file_name), token);
  try {
    await deps.r2.put(key, bytes, { httpMetadata: { contentType } });
  } catch (err) {
    return markRetry(db, row, `r2: ${err instanceof Error ? err.name : 'error'}`, now(), token);
  }
  const upd = await db
    .prepare(
      `UPDATE line_media SET status = 'done', r2_key = ?, content_type = ?, size = ?, reason = NULL,
              mirrored = 0, mirror_attempts = 0, lease_until = NULL, lease_token = NULL, updated_at = ?
        WHERE line_message_id = ? AND status = 'pending' AND lease_token = ?`,
    )
    .bind(key, contentType, bytes.byteLength, now(), row.line_message_id, token)
    .run();
  if ((upd.meta?.changes ?? 0) === 1) return 'done';

  // 確定できなかった（取消された・期限切れ後に別の実行が取り直した）: このキーは実行ごとに一意で DB のどこからも
  // 参照されない＝自分の書込みを消す。削除に失敗したら orphan_key に記録し、Cron（purgeUnsentMedia）が消す。
  try {
    await deps.r2.delete(key);
  } catch (err) {
    console.error(`[line-media] delete own write failed msg=${row.line_message_id}: ${err instanceof Error ? err.name : 'error'}`);
    const rec = await db
      .prepare(`UPDATE line_media SET orphan_key = ?, updated_at = ? WHERE line_message_id = ? AND orphan_key IS NULL`)
      .bind(key, now(), row.line_message_id)
      .run();
    if ((rec.meta?.changes ?? 0) === 0) console.error(`[line-media] orphan slot busy msg=${row.line_message_id} (manual cleanup needed)`);
  }
  const cur = await getMediaRow(db, row.line_message_id);
  return cur?.status === 'unsent' ? 'unsent' : 'skipped';
}

/** 取消済みで保存済みのオブジェクトと、所有権を失った実行の書き残し（orphan_key）を R2 から消す。 */
export async function purgeUnsentMedia(db: D1Database, r2: R2Bucket, now: number, limit = 20): Promise<number> {
  const rows = await db
    .prepare(`SELECT line_message_id, r2_key FROM line_media WHERE status = 'unsent' AND r2_key IS NOT NULL AND r2_deleted = 0 LIMIT ?`)
    .bind(limit)
    .all<{ line_message_id: string; r2_key: string }>();
  let n = 0;
  const orphans = await db
    .prepare(`SELECT line_message_id, orphan_key FROM line_media WHERE orphan_key IS NOT NULL LIMIT ?`)
    .bind(limit)
    .all<{ line_message_id: string; orphan_key: string }>();
  for (const o of orphans.results ?? []) {
    try {
      await r2.delete(o.orphan_key);
      await db
        .prepare(`UPDATE line_media SET orphan_key = NULL, updated_at = ? WHERE line_message_id = ? AND orphan_key = ?`)
        .bind(now, o.line_message_id, o.orphan_key)
        .run();
      n++;
    } catch (err) {
      console.error(`[line-media] orphan purge failed msg=${o.line_message_id}: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
  for (const r of rows.results ?? []) {
    try {
      await r2.delete(r.r2_key);
      await db
        .prepare(`UPDATE line_media SET r2_deleted = 1, r2_key = NULL, updated_at = ? WHERE line_message_id = ?`)
        .bind(now, r.line_message_id)
        .run();
      n++;
    } catch (err) {
      console.error(`[line-media] purge failed msg=${r.line_message_id}: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
  return n;
}

// ─── きずなへの状態転送 ─────────────────────────────────────────────────────

export interface MediaMirrorFields {
  mediaStatus: MediaStatus;
  mediaKey?: string;
  mediaContentType?: string;
  mediaSize?: number;
  mediaReason?: string;
  mediaFileName?: string;
}

export function mediaMirrorFields(row: MediaRow): MediaMirrorFields {
  const f: MediaMirrorFields = { mediaStatus: row.status };
  if (row.status === 'done' && row.r2_key) {
    f.mediaKey = row.r2_key;
    if (row.content_type) f.mediaContentType = row.content_type;
    if (typeof row.size === 'number') f.mediaSize = row.size;
  }
  if (row.reason && (row.status === 'failed' || row.status === 'expired')) f.mediaReason = row.reason;
  if (row.file_name) f.mediaFileName = row.file_name;
  return f;
}

async function hmacHexLocal(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface MediaMirrorDeps {
  db: D1Database;
  url: string;
  secret: string | undefined;
  now?: () => number;
  fetchFn?: typeof fetch;
}

/**
 * 状態変化 1 件をきずなへ転送する（未転送＝mirrored=0 の行）。取消（unsent）は unsend イベント側で伝わるので転送しない。
 * webhookEventId=`media:<messageId>:<status>`＝同じ状態の再送はきずな側で重複排除される。
 */
export async function mirrorMediaRow(deps: MediaMirrorDeps, lineMessageId: string): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  if (!deps.secret) return false;
  const row = await getMediaRow(deps.db, lineMessageId);
  if (!row) return false;
  if (row.status === 'pending' || row.status === 'unsent') {
    // 読んだ時点の状態のままの時だけ（並行して done 等に変わっていたら未転送のまま残し、Cron が送る）。
    await deps.db
      .prepare(`UPDATE line_media SET mirrored = 1, updated_at = ? WHERE line_message_id = ? AND status = ?`)
      .bind(now(), lineMessageId, row.status)
      .run();
    return true;
  }
  try {
    const sentAt = now();
    const body = JSON.stringify({
      webhookEventId: `media:${row.line_message_id}:${row.status}`,
      eventType: 'media',
      timestamp: sentAt,
      sentAt,
      lineMessageId: row.line_message_id,
      ...mediaMirrorFields(row),
    });
    const res = await fetchFn(deps.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mirror-Signature': await hmacHexLocal(deps.secret, body),
        'X-Mirror-Timestamp': String(sentAt),
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`mirror responded ${res.status}`);
    await deps.db
      .prepare(`UPDATE line_media SET mirrored = 1, updated_at = ? WHERE line_message_id = ? AND status = ?`)
      .bind(now(), row.line_message_id, row.status)
      .run();
    return true;
  } catch (err) {
    console.error(`[line-media] mirror failed msg=${row.line_message_id}: ${err instanceof Error ? err.message : 'error'}`);
    await deps.db
      .prepare(`UPDATE line_media SET mirror_attempts = mirror_attempts + 1, updated_at = ? WHERE line_message_id = ?`)
      .bind(now(), row.line_message_id)
      .run();
    return false;
  }
}

export interface MediaMaintenanceDeps extends FetchMediaDeps {
  mirror: { url: string; secret: string | undefined } | null;
  batchSize?: number;
}

export interface MediaMaintenanceResult {
  fetched: number;
  retried: number;
  finalized: number;
  purged: number;
  mirrored: number;
  mirrorFailed: number;
}

/** Cron: 予定時刻に達した取得待ちの取得・取消済みオブジェクトの削除・未転送の状態転送。 */
export async function runLineMediaMaintenance(deps: MediaMaintenanceDeps): Promise<MediaMaintenanceResult> {
  const now = deps.now ?? Date.now;
  const limit = deps.batchSize ?? 10;
  const { db } = deps;
  const result: MediaMaintenanceResult = { fetched: 0, retried: 0, finalized: 0, purged: 0, mirrored: 0, mirrorFailed: 0 };

  const due = await db
    .prepare(`SELECT line_message_id FROM line_media WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?`)
    .bind(now(), limit)
    .all<{ line_message_id: string }>();
  for (const r of due.results ?? []) {
    const out = await fetchLineMedia(deps, r.line_message_id);
    if (out === 'done') result.fetched++;
    else if (out === 'pending') result.retried++;
    else if (out === 'failed' || out === 'expired') result.finalized++;
  }

  result.purged = await purgeUnsentMedia(db, deps.r2, now());

  if (deps.mirror) {
    const unmirrored = await db
      .prepare(`SELECT line_message_id FROM line_media WHERE mirrored = 0 AND mirror_attempts < ? LIMIT ?`)
      .bind(MEDIA_MAX_MIRROR_ATTEMPTS, limit)
      .all<{ line_message_id: string }>();
    for (const r of unmirrored.results ?? []) {
      const ok = await mirrorMediaRow({ ...deps.mirror, db, now, fetchFn: deps.fetchFn }, r.line_message_id);
      if (ok) result.mirrored++;
      else result.mirrorFailed++;
    }
  }
  return result;
}

/** 管理 API 用の集計。 */
export async function lineMediaStatus(db: D1Database): Promise<Record<string, number>> {
  const rows = await db.prepare(`SELECT status, COUNT(*) AS n FROM line_media GROUP BY status`).all<{ status: string; n: number }>();
  const out: Record<string, number> = { pending: 0, done: 0, failed: 0, expired: 0, unsent: 0 };
  for (const r of rows.results ?? []) out[r.status] = Number(r.n);
  const unm = await db
    .prepare(`SELECT COUNT(*) AS n FROM line_media WHERE mirrored = 0`)
    .first<{ n: number }>();
  out.unmirrored = Number(unm?.n ?? 0);
  return out;
}
