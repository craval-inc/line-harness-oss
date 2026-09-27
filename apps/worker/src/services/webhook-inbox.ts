/**
 * [Craval kzn] LINE Webhook 受信箱（WEBHOOK_INBOX=1 の環境専用・未設定なら一切呼ばれない）。
 *
 * - 署名検証後、LINE の生イベントを webhook_inbox に同期保存してから 200 を返す（保存失敗は 500＝LINE 再送対象）。
 * - 重複到着（同一 webhookEventId）は INSERT OR IGNORE で弾き、新規行だけ処理する。
 * - 処理(processed)と外部ミラー転送(mirrored)は別フラグ。途中失敗は Cron が再処理・再転送する。
 * - unsend は unsent_messages に記録し、保存済み本文（messages_log / webhook_inbox）を置換する。
 *   取消が元メッセージより先に届いても、後から本文を保存しない。
 * - follow/unfollow はイベント時刻で条件付き更新し、古いイベントで友だち状態を巻き戻さない。
 */
import type { WebhookEvent } from '@line-crm/line-sdk';

export const UNSENT_PLACEHOLDER = '[送信取消]';
export const MAX_ATTEMPTS = 5;
export const RETRY_AFTER_MS = 2 * 60 * 1000;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ERROR_LENGTH = 500;

/** Mirror の対象イベント（それ以外は転送不要＝保存時点で mirrored=1）。 */
const MIRRORABLE_TYPES = new Set(['message', 'unsend', 'follow', 'unfollow']);

export interface InboxEnv {
  WEBHOOK_INBOX?: string;
  MIRROR_URL?: string;
  MIRROR_SECRET?: string;
}

export function inboxEnabled(env: InboxEnv): boolean {
  return env.WEBHOOK_INBOX === '1';
}

export function mirrorEnabled(env: InboxEnv): boolean {
  return inboxEnabled(env) && !!env.MIRROR_URL && !!env.MIRROR_SECRET;
}

type LooseEvent = WebhookEvent & {
  webhookEventId?: string;
  timestamp?: number;
  unsend?: { messageId?: string };
};

export function webhookEventIdOf(event: WebhookEvent): string | null {
  const id = (event as LooseEvent).webhookEventId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function lineMessageIdOf(event: WebhookEvent): string | null {
  const e = event as LooseEvent;
  if (e.type === 'message') {
    const id = (e as { message?: { id?: string } }).message?.id;
    return typeof id === 'string' ? id : null;
  }
  if ((e.type as string) === 'unsend') {
    const id = e.unsend?.messageId;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

export function lineUserIdOf(event: WebhookEvent): string | null {
  const src = (event as { source?: { type?: string; userId?: string } }).source;
  return src?.type === 'user' && typeof src.userId === 'string' ? src.userId : null;
}

export interface SavedInboxEvents {
  /** 今回新規に保存できた（=未処理の）イベント。これだけを処理する。 */
  fresh: WebhookEvent[];
  /** webhookEventId を持たないイベント（受信箱に入れられない）。従来どおり処理する。 */
  untracked: WebhookEvent[];
}

/** 署名検証済みイベントを 1 batch で保存する。例外はそのまま投げる（呼び出し側が 500 を返す）。 */
export async function saveInboxEvents(
  db: D1Database,
  events: WebhookEvent[],
  opts: { lineAccountId: string | null; mirror: boolean; now: number },
): Promise<SavedInboxEvents> {
  const tracked: WebhookEvent[] = [];
  const untracked: WebhookEvent[] = [];
  for (const e of events) (webhookEventIdOf(e) ? tracked : untracked).push(e);
  if (tracked.length === 0) return { fresh: [], untracked };

  const stmts = tracked.map((e) => {
    const type = (e as { type: string }).type;
    const mirrored = opts.mirror && MIRRORABLE_TYPES.has(type) ? 0 : 1;
    const ts = (e as LooseEvent).timestamp;
    return db
      .prepare(
        `INSERT OR IGNORE INTO webhook_inbox
           (webhook_event_id, event_type, line_message_id, line_account_id, event_timestamp, body_json,
            processed, mirrored, attempts, mirror_attempts, received_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?)`,
      )
      .bind(
        webhookEventIdOf(e),
        type,
        lineMessageIdOf(e),
        opts.lineAccountId,
        typeof ts === 'number' ? ts : null,
        JSON.stringify(e),
        mirrored,
        opts.now,
        opts.now,
      );
  });
  const results = await db.batch(stmts);
  const fresh = tracked.filter((_, i) => (results[i]?.meta?.changes ?? 0) === 1);
  return { fresh, untracked };
}

export async function markProcessed(db: D1Database, webhookEventId: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE webhook_inbox SET processed = 1, last_error = NULL, updated_at = ? WHERE webhook_event_id = ?')
    .bind(now, webhookEventId)
    .run();
}

export async function markFailed(db: D1Database, webhookEventId: string, err: unknown, now: number): Promise<void> {
  const message = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, MAX_ERROR_LENGTH);
  await db
    .prepare('UPDATE webhook_inbox SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE webhook_event_id = ?')
    .bind(message, now, webhookEventId)
    .run();
}

/** 送信取消: 取消済み ID を記録し、保存済み本文を置換する。 */
export async function applyUnsend(db: D1Database, lineMessageId: string, now: number): Promise<void> {
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO unsent_messages (line_message_id, unsent_at) VALUES (?, ?)').bind(lineMessageId, now),
    db.prepare('UPDATE messages_log SET content = ? WHERE line_message_id = ?').bind(UNSENT_PLACEHOLDER, lineMessageId),
    db
      .prepare(
        `UPDATE webhook_inbox
            SET body_json = json_set(body_json, '$.message', json_object('id', ?, 'type', json_extract(body_json, '$.message.type'), 'text', ?)),
                updated_at = ?
          WHERE line_message_id = ? AND event_type = 'message'`,
      )
      .bind(lineMessageId, UNSENT_PLACEHOLDER, now, lineMessageId),
  ]);
}

export async function isUnsent(db: D1Database, lineMessageId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS hit FROM unsent_messages WHERE line_message_id = ?')
    .bind(lineMessageId)
    .first<{ hit: number }>();
  return !!row;
}

/**
 * follow 反映の可否を判定し、反映するなら follow_state_at を先に進める（claim）。
 * - 'claimed'   : 既存友だちで、このイベントが最新 → 反映してよい
 * - 'stale'     : より新しい follow/unfollow が反映済み → 何もしない
 * - 'no_friend' : 友だち未登録 → 新規登録してよい（登録後に recordFollowState を呼ぶ）
 * 同一イベントの再処理（時刻が等しい）は反映可とする（途中失敗からの再開のため）。
 */
export async function claimFollowState(
  db: D1Database,
  lineUserId: string,
  eventTimestamp: number,
): Promise<'claimed' | 'stale' | 'no_friend'> {
  const res = await db
    .prepare(
      'UPDATE friends SET follow_state_at = ? WHERE line_user_id = ? AND (follow_state_at IS NULL OR follow_state_at <= ?)',
    )
    .bind(eventTimestamp, lineUserId, eventTimestamp)
    .run();
  if ((res.meta?.changes ?? 0) >= 1) return 'claimed';
  const row = await db
    .prepare('SELECT follow_state_at FROM friends WHERE line_user_id = ?')
    .bind(lineUserId)
    .first<{ follow_state_at: number | null }>();
  return row ? 'stale' : 'no_friend';
}

export async function recordFollowState(db: D1Database, lineUserId: string, eventTimestamp: number): Promise<void> {
  await db
    .prepare(
      'UPDATE friends SET follow_state_at = ? WHERE line_user_id = ? AND (follow_state_at IS NULL OR follow_state_at <= ?)',
    )
    .bind(eventTimestamp, lineUserId, eventTimestamp)
    .run();
}

/** unfollow を時刻条件付きで反映する。より新しい follow が反映済みなら何もしない。 */
export async function applyUnfollowIfNewer(
  db: D1Database,
  lineUserId: string,
  eventTimestamp: number,
  nowJst: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE friends SET is_following = 0, follow_state_at = ?, updated_at = ?
        WHERE line_user_id = ? AND (follow_state_at IS NULL OR follow_state_at <= ?)`,
    )
    .bind(eventTimestamp, nowJst, lineUserId, eventTimestamp)
    .run();
  return (res.meta?.changes ?? 0) >= 1;
}

// ─── Mirror 転送 ────────────────────────────────────────────────────────────

export interface MirrorPayload {
  webhookEventId: string;
  eventType: string;
  timestamp: number | null;
  sentAt: number;
  lineUserId: string | null;
  lineMessageId?: string;
  messageType?: string;
  text?: string;
  displayName?: string;
}

const NON_TEXT_LABELS: Record<string, string> = {
  sticker: '[スタンプ]',
  image: '[画像]',
  audio: '[音声]',
  video: '[動画]',
  file: '[ファイル]',
  location: '[位置情報]',
};

/** 生イベントからミラー本文を組み立てる。replyToken は含めない。 */
export function buildMirrorPayload(
  event: WebhookEvent,
  opts: { sentAt: number; displayName?: string | null; unsent?: boolean },
): MirrorPayload {
  const e = event as LooseEvent;
  const payload: MirrorPayload = {
    webhookEventId: webhookEventIdOf(event) ?? '',
    eventType: e.type as string,
    timestamp: typeof e.timestamp === 'number' ? e.timestamp : null,
    sentAt: opts.sentAt,
    lineUserId: lineUserIdOf(event),
  };
  const messageId = lineMessageIdOf(event);
  if (messageId) payload.lineMessageId = messageId;
  if (e.type === 'message') {
    const msg = (e as { message: { type: string; text?: string } }).message;
    payload.messageType = msg.type;
    if (opts.unsent) payload.text = UNSENT_PLACEHOLDER;
    else if (msg.type === 'text') payload.text = msg.text ?? '';
    else payload.text = NON_TEXT_LABELS[msg.type] ?? `[${msg.type}]`;
  }
  if (opts.displayName) payload.displayName = opts.displayName;
  return payload;
}

export async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface MirrorDeps {
  db: D1Database;
  url: string;
  secret: string;
  now?: () => number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** 1 行をミラー転送する。2xx なら mirrored=1、それ以外は mirror_attempts++ して false。 */
export async function mirrorInboxRow(deps: MirrorDeps, row: { webhook_event_id: string; body_json: string }): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const { db } = deps;
  try {
    const event = JSON.parse(row.body_json) as WebhookEvent;
    const userId = lineUserIdOf(event);
    const messageId = lineMessageIdOf(event);
    const [friend, unsent] = await Promise.all([
      userId
        ? db.prepare('SELECT display_name FROM friends WHERE line_user_id = ?').bind(userId).first<{ display_name: string | null }>()
        : Promise.resolve(null),
      messageId && (event as { type: string }).type === 'message' ? isUnsent(db, messageId) : Promise.resolve(false),
    ]);
    const sentAt = now();
    const body = JSON.stringify(buildMirrorPayload(event, { sentAt, displayName: friend?.display_name ?? null, unsent }));
    const signature = await hmacHex(deps.secret, body);
    const res = await fetchFn(deps.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mirror-Signature': signature,
        'X-Mirror-Timestamp': String(sentAt),
      },
      body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
    });
    if (!res.ok) throw new Error(`mirror responded ${res.status}`);
    await db
      .prepare('UPDATE webhook_inbox SET mirrored = 1, updated_at = ? WHERE webhook_event_id = ?')
      .bind(now(), row.webhook_event_id)
      .run();
    return true;
  } catch (err) {
    const message = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, MAX_ERROR_LENGTH);
    // PII を含まない（URL・ステータス・例外名のみ）
    console.error(`[webhook-inbox] mirror failed event=${row.webhook_event_id}: ${message}`);
    await db
      .prepare('UPDATE webhook_inbox SET mirror_attempts = mirror_attempts + 1, last_error = ?, updated_at = ? WHERE webhook_event_id = ?')
      .bind(`mirror: ${message}`, now(), row.webhook_event_id)
      .run();
    return false;
  }
}

// ─── Cron 保守 ──────────────────────────────────────────────────────────────

export interface InboxRow {
  webhook_event_id: string;
  event_type: string;
  line_account_id: string | null;
  body_json: string;
}

export interface MaintenanceDeps {
  db: D1Database;
  /** 生イベント 1 件を処理する（webhook ルートと同じ処理）。例外で失敗扱い。 */
  process: (event: WebhookEvent, lineAccountId: string | null) => Promise<void>;
  mirror: Omit<MirrorDeps, 'db'> | null;
  now?: () => number;
  batchSize?: number;
}

export interface MaintenanceResult {
  reprocessed: number;
  reprocessFailed: number;
  remirrored: number;
  remirrorFailed: number;
  purged: number;
}

/** 未処理行の再処理・未転送行の再転送・保持期限切れ行の削除。 */
export async function runInboxMaintenance(deps: MaintenanceDeps): Promise<MaintenanceResult> {
  const now = deps.now ?? Date.now;
  const limit = deps.batchSize ?? 20;
  const { db } = deps;
  const result: MaintenanceResult = { reprocessed: 0, reprocessFailed: 0, remirrored: 0, remirrorFailed: 0, purged: 0 };
  const cutoff = now() - RETRY_AFTER_MS;

  const pending = await db
    .prepare(
      `SELECT webhook_event_id, event_type, line_account_id, body_json FROM webhook_inbox
        WHERE processed = 0 AND attempts < ? AND received_at <= ?
        ORDER BY received_at ASC LIMIT ?`,
    )
    .bind(MAX_ATTEMPTS, cutoff, limit)
    .all<InboxRow>();
  for (const row of pending.results ?? []) {
    const ok = await processInboxEvent(db, JSON.parse(row.body_json) as WebhookEvent, row.line_account_id, deps.process, now);
    if (ok) result.reprocessed++;
    else result.reprocessFailed++;
  }

  if (deps.mirror) {
    const unmirrored = await db
      .prepare(
        `SELECT webhook_event_id, event_type, line_account_id, body_json FROM webhook_inbox
          WHERE mirrored = 0 AND mirror_attempts < ? AND received_at <= ?
          ORDER BY received_at ASC LIMIT ?`,
      )
      .bind(MAX_ATTEMPTS, cutoff, limit)
      .all<InboxRow>();
    for (const row of unmirrored.results ?? []) {
      const ok = await mirrorInboxRow({ ...deps.mirror, db, now }, row);
      if (ok) result.remirrored++;
      else result.remirrorFailed++;
    }
  }

  const purge = await db
    .prepare('DELETE FROM webhook_inbox WHERE processed = 1 AND mirrored = 1 AND received_at < ?')
    .bind(now() - RETENTION_MS)
    .run();
  result.purged = purge.meta?.changes ?? 0;
  return result;
}

/**
 * 受信箱の 1 イベントを処理し、成否をフラグに反映する。
 * unsend は受信箱側で完結（本文置換）。それ以外は process（webhook の handleEvent）に委ねる。
 */
export async function processInboxEvent(
  db: D1Database,
  event: WebhookEvent,
  lineAccountId: string | null,
  process: (event: WebhookEvent, lineAccountId: string | null) => Promise<void>,
  now: () => number = Date.now,
): Promise<boolean> {
  const id = webhookEventIdOf(event);
  if (!id) return false;
  try {
    const type = (event as { type: string }).type;
    if (type === 'unsend') {
      const messageId = lineMessageIdOf(event);
      if (messageId) await applyUnsend(db, messageId, now());
    } else {
      await process(event, lineAccountId);
      // 取消が先に届いていた場合、後着メッセージの生イベント本文も伏せる（applyUnsend は冪等）。
      const messageId = type === 'message' ? lineMessageIdOf(event) : null;
      if (messageId && (await isUnsent(db, messageId))) await applyUnsend(db, messageId, now());
    }
    await markProcessed(db, id, now());
    return true;
  } catch (err) {
    console.error(`[webhook-inbox] process failed event=${id}:`, err instanceof Error ? err.message : err);
    try {
      await markFailed(db, id, err, now());
    } catch (e) {
      console.error('[webhook-inbox] markFailed failed', e);
    }
    return false;
  }
}

// ─── 管理 API 用 ────────────────────────────────────────────────────────────

export async function inboxStatus(db: D1Database): Promise<Record<string, number>> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN processed = 0 AND attempts < ${MAX_ATTEMPTS} THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN processed = 0 AND attempts >= ${MAX_ATTEMPTS} THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN mirrored = 0 AND mirror_attempts < ${MAX_ATTEMPTS} THEN 1 ELSE 0 END) AS mirror_pending,
         SUM(CASE WHEN mirrored = 0 AND mirror_attempts >= ${MAX_ATTEMPTS} THEN 1 ELSE 0 END) AS mirror_failed
       FROM webhook_inbox`,
    )
    .first<Record<string, number | null>>();
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row ?? {})) out[k] = Number(v ?? 0);
  return out;
}

/** 打ち切られた行（attempts/mirror_attempts >= MAX）を再試行対象に戻す。 */
export async function resetExhausted(db: D1Database, now: number): Promise<{ process: number; mirror: number }> {
  const [p, m] = await db.batch([
    db
      .prepare(`UPDATE webhook_inbox SET attempts = 0, updated_at = ? WHERE processed = 0 AND attempts >= ${MAX_ATTEMPTS}`)
      .bind(now),
    db
      .prepare(`UPDATE webhook_inbox SET mirror_attempts = 0, updated_at = ? WHERE mirrored = 0 AND mirror_attempts >= ${MAX_ATTEMPTS}`)
      .bind(now),
  ]);
  return { process: p?.meta?.changes ?? 0, mirror: m?.meta?.changes ?? 0 };
}
