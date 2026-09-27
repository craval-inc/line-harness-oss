/**
 * [Craval kzn] LINE Webhook 受信箱（WEBHOOK_INBOX=1 の環境専用・未設定なら一切呼ばれない）。
 *
 * - 署名検証後、LINE の生イベントを webhook_inbox に同期保存してから 200 を返す（保存失敗は 500＝LINE 再送対象）。
 * - 重複到着（同一 webhookEventId）は INSERT OR IGNORE で弾き、新規行だけ処理する。
 * - 処理(processed)と外部ミラー転送(mirrored)は別フラグ。途中失敗は Cron が再処理・再転送する。
 * - unsend は unsent_messages に記録し、保存済み本文（messages_log / webhook_inbox）を置換する。
 *   取消が元メッセージより先に届いても、後から本文を保存しない。
 * - follow/unfollow は friend_follow_state にイベント時刻付きで原子的に記録し、friends.is_following はそこから同期する
 *   （古いイベント・処理中の割り込み・友だち未登録の unfollow でも状態を巻き戻さない）。
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

/** 転送が「意図されている」か（MIRROR_URL あり）。鍵が無くても true＝行は未転送(mirrored=0)で保持する。 */
export function mirrorEnabled(env: InboxEnv): boolean {
  return inboxEnabled(env) && !!env.MIRROR_URL;
}

/** 実際に転送できるか（URL と鍵の両方あり）。 */
export function mirrorReady(env: InboxEnv): boolean {
  return mirrorEnabled(env) && !!env.MIRROR_SECRET;
}

let mirrorConfigWarned = false;
/** MIRROR_URL あり・MIRROR_SECRET なしの設定不備を isolate ごとに1回だけ警告する。 */
export function warnMirrorMisconfigOnce(env: InboxEnv): void {
  if (mirrorEnabled(env) && !env.MIRROR_SECRET && !mirrorConfigWarned) {
    mirrorConfigWarned = true;
    console.error('[webhook-inbox] MIRROR_URL is set but MIRROR_SECRET is missing — mirror is paused (rows kept with mirrored=0)');
  }
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
  // unsend は保存と同じトランザクションで取消を登録し、既存の本文（受信箱・受信ログ）を伏せる。
  // 並行リクエストでも D1 の batch は直列化されるので、元メッセージの保存と取消のどちらが先でも本文は残らない。
  for (const e of tracked) {
    if ((e as { type: string }).type !== 'unsend') continue;
    const messageId = lineMessageIdOf(e);
    if (messageId) stmts.push(...unsendStatements(db, messageId, opts.now));
  }
  // 取消が先着していたメッセージは、保存と同じトランザクション内で本文を伏せる（処理の成否に依存しない）。
  const ids = tracked.map((e) => webhookEventIdOf(e));
  stmts.push(
    db
      .prepare(
        `UPDATE webhook_inbox
            SET body_json = ${REDACT_BODY_SQL}
          WHERE event_type = 'message'
            AND webhook_event_id IN (${ids.map(() => '?').join(', ')})
            AND line_message_id IN (SELECT line_message_id FROM unsent_messages)`,
      )
      .bind(UNSENT_PLACEHOLDER, ...ids),
  );
  const results = await db.batch(stmts);
  const fresh = tracked.filter((_, i) => (results[i]?.meta?.changes ?? 0) === 1);
  return { fresh, untracked };
}

/** webhook_inbox.body_json の message を id/type/伏字 text だけにする SQL 式（1番目の ? = 伏字）。 */
const REDACT_BODY_SQL =
  "json_set(body_json, '$.message', json_object('id', line_message_id, 'type', json_extract(body_json, '$.message.type'), 'text', ?))";

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
  await db.batch(unsendStatements(db, lineMessageId, now));
}

/** 取消登録と本文置換の文（冪等）。受信箱の保存 batch にも同じ文を入れる。 */
function unsendStatements(db: D1Database, lineMessageId: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare('INSERT OR IGNORE INTO unsent_messages (line_message_id, unsent_at) VALUES (?, ?)').bind(lineMessageId, now),
    db.prepare('UPDATE messages_log SET content = ? WHERE line_message_id = ?').bind(UNSENT_PLACEHOLDER, lineMessageId),
    db
      .prepare(
        `UPDATE webhook_inbox
            SET body_json = ${REDACT_BODY_SQL},
                updated_at = ?
          WHERE line_message_id = ? AND event_type = 'message'`,
      )
      .bind(UNSENT_PLACEHOLDER, now, lineMessageId),
  ];
}

export async function isUnsent(db: D1Database, lineMessageId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS hit FROM unsent_messages WHERE line_message_id = ?')
    .bind(lineMessageId)
    .first<{ hit: number }>();
  return !!row;
}

/**
 * follow/unfollow を friend_follow_state に原子的に記録する（1文の UPSERT）。
 * このイベントが既存の状態より新しい（同時刻＝同一イベントの再処理も含む）時だけ反映し true を返す。
 * 友だち未登録でも記録されるので、未登録時の unfollow の後に届いた古い follow も弾ける。
 */
export async function claimFollowTransition(
  db: D1Database,
  lineUserId: string,
  following: boolean,
  eventTimestamp: number,
): Promise<boolean> {
  if (following) {
    const res = await db
      .prepare(
        `INSERT INTO friend_follow_state (line_user_id, is_following, state_at) VALUES (?, 1, ?)
         ON CONFLICT(line_user_id) DO UPDATE SET is_following = 1, state_at = excluded.state_at
          WHERE excluded.state_at >= friend_follow_state.state_at`,
      )
      .bind(lineUserId, eventTimestamp)
      .run();
    return (res.meta?.changes ?? 0) >= 1;
  }
  // unfollow: 状態の記録と「友だち行が無い間の解除履歴（K002 保留分）」を1文で行う（間に行作成が割り込む隙を作らない）。
  // 保留の加算は状態時刻が真に新しくなった時だけ＝同じイベントの再処理（同時刻）では二重に数えない。
  // 友だち行がある時は保留に入れない（friends 側の履歴は syncFriendFollowFromState が状態遷移で数える）。
  const noFriend = 'NOT EXISTS (SELECT 1 FROM friends f WHERE f.line_user_id = ?)';
  const res = await db
    .prepare(
      `INSERT INTO friend_follow_state (line_user_id, is_following, state_at, pending_unfollow_count, pending_last_unfollowed_at)
       VALUES (?, 0, ?, CASE WHEN ${noFriend} THEN 1 ELSE 0 END, CASE WHEN ${noFriend} THEN ? ELSE NULL END)
       ON CONFLICT(line_user_id) DO UPDATE SET
         is_following = 0,
         state_at = excluded.state_at,
         pending_unfollow_count = friend_follow_state.pending_unfollow_count
           + CASE WHEN excluded.state_at > friend_follow_state.state_at AND ${noFriend} THEN 1 ELSE 0 END,
         pending_last_unfollowed_at = CASE
           WHEN excluded.state_at > friend_follow_state.state_at AND ${noFriend}
             THEN MAX(COALESCE(friend_follow_state.pending_last_unfollowed_at, 0), excluded.state_at)
           ELSE friend_follow_state.pending_last_unfollowed_at END
        WHERE excluded.state_at >= friend_follow_state.state_at`,
    )
    .bind(lineUserId, eventTimestamp, lineUserId, lineUserId, eventTimestamp, lineUserId, lineUserId)
    .run();
  return (res.meta?.changes ?? 0) >= 1;
}

/**
 * friends.is_following を friend_follow_state の最新状態に合わせる（1文）。
 * 状態が変わる時だけ、本家 065 のフォロー履歴を本家 updateFriendFollowStatus と同じ意味で更新する:
 *   → フォロー:   first_followed_at（空なら）/ current_follow_started_at / last_followed_at ＝ イベント時刻
 *   → ブロック:   current_follow_started_at=NULL / last_unfollowed_at ＝ イベント時刻 / unfollow_count+1
 * 日時は処理時刻ではなく friend_follow_state.state_at（LINE イベント時刻）から作る＝再処理・順序逆転でもずれない。
 * follow 処理中（プロフィール取得〜登録の間）に新しい unfollow が割り込んでも、最後にこれを呼べば最新状態に収束する。
 */
export async function syncFriendFollowFromState(db: D1Database, lineUserId: string, nowJst: string): Promise<void> {
  await followSyncStatement(db, lineUserId, nowJst).run();
}

const STATE_SQL = 'SELECT s.is_following FROM friend_follow_state s WHERE s.line_user_id = friends.line_user_id';
const STATE_AT_JST_SQL =
  "SELECT strftime('%Y-%m-%dT%H:%M:%f', s.state_at / 1000.0, 'unixepoch', '+9 hours') || '+09:00' FROM friend_follow_state s WHERE s.line_user_id = friends.line_user_id";

function followSyncStatement(db: D1Database, lineUserId: string, nowJst: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE friends
          SET is_following = (${STATE_SQL}),
              first_followed_at = CASE WHEN (${STATE_SQL}) = 1 THEN COALESCE(first_followed_at, (${STATE_AT_JST_SQL})) ELSE first_followed_at END,
              current_follow_started_at = CASE WHEN (${STATE_SQL}) = 1 THEN (${STATE_AT_JST_SQL}) ELSE NULL END,
              last_followed_at = CASE WHEN (${STATE_SQL}) = 1 THEN (${STATE_AT_JST_SQL}) ELSE last_followed_at END,
              last_unfollowed_at = CASE WHEN (${STATE_SQL}) = 0 THEN (${STATE_AT_JST_SQL}) ELSE last_unfollowed_at END,
              unfollow_count = unfollow_count + CASE WHEN (${STATE_SQL}) = 0 THEN 1 ELSE 0 END,
              updated_at = ?
        WHERE line_user_id = ?
          AND EXISTS (SELECT 1 FROM friend_follow_state s WHERE s.line_user_id = friends.line_user_id)
          AND is_following IS NOT (${STATE_SQL})`,
    )
    .bind(nowJst, lineUserId);
}

/** ms → jstNow() と同じ形式の SQL 式（引数は SQL 式文字列）。 */
const jstOfMsSql = (ms: string) => `(strftime('%Y-%m-%dT%H:%M:%f', (${ms}) / 1000.0, 'unixepoch', '+9 hours') || '+09:00')`;

/**
 * 新規の友だち行を「最新状態（friend_follow_state）＋行が無い間の unfollow 保留分（K002）」から作る列の値（SQL 式）。
 * - is_following: 最新状態（無ければ 1＝メッセージを送れている／このフォロー）
 * - current_follow_started_at / last_followed_at: フォロー中なら最新状態の時刻（無ければ fallbackFollowAt）
 * - unfollow_count / last_unfollowed_at: 保留分をそのまま
 * 呼び出し側は同じ batch で clearPendingStatement を実行する。
 */
function newFriendHistorySql(fallbackFollowAtParam: string) {
  const st = (col: string) => `(SELECT s.${col} FROM friend_follow_state s WHERE s.line_user_id = ?)`;
  const following = `COALESCE(${st('is_following')}, 1)`;
  const stateAt = jstOfMsSql(st('state_at'));
  return {
    // バインド順: 下の各式の ? は全て lineUserId、fallbackFollowAtParam は ? 1つ
    isFollowing: following,
    currentFollowStartedAt: `CASE WHEN ${following} = 1 THEN COALESCE(${stateAt}, ${fallbackFollowAtParam}) ELSE NULL END`,
    lastFollowedAt: `COALESCE(CASE WHEN ${following} = 1 THEN ${stateAt} END, ${fallbackFollowAtParam})`,
    lastUnfollowedAt: `CASE WHEN ${st('pending_last_unfollowed_at')} IS NULL THEN NULL ELSE ${jstOfMsSql(st('pending_last_unfollowed_at'))} END`,
    unfollowCount: `COALESCE(${st('pending_unfollow_count')}, 0)`,
  };
}

function clearPendingStatement(db: D1Database, lineUserId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE friend_follow_state SET pending_unfollow_count = 0, pending_last_unfollowed_at = NULL
        WHERE line_user_id = ? AND EXISTS (SELECT 1 FROM friends f WHERE f.line_user_id = ?)`,
    )
    .bind(lineUserId, lineUserId);
}

/**
 * follow 時の友だち登録/更新（upsertFriend 相当）と is_following・フォロー履歴の最新状態への同期を1つの batch で行う。
 * どちらかが失敗すれば全てロールバック＝「friends=1 だが最新状態は unfollow」が残らない。
 * - 既存行: プロフィールだけ更新し is_following には触れない（状態遷移と履歴は同期文だけが決める）
 * - 新規行: 最新状態と、行が無い間に受けた unfollow の保留分（K002）から作る。プロフィール取得中に
 *   unfollow → 再 follow が完了していても、解除回数・解除日時・再フォロー開始日時が正しく残る
 * プロフィール取得は呼び出し側で batch の前に済ませる。
 */
export async function upsertFriendAndSyncFollow(
  db: D1Database,
  input: { lineUserId: string; displayName: string | null; pictureUrl: string | null; statusMessage: string | null },
  nowJst: string,
  followEventTimestamp: number,
): Promise<void> {
  const h = newFriendHistorySql('?');
  const u = input.lineUserId;
  const followAt = toJstFromEpoch(followEventTimestamp);
  await db.batch([
    db
      .prepare(
        `INSERT INTO friends
           (id, line_user_id, display_name, picture_url, status_message, is_following,
            first_followed_at, current_follow_started_at, last_followed_at, last_unfollowed_at, unfollow_count,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ${h.isFollowing}, ?, ${h.currentFollowStartedAt}, ${h.lastFollowedAt}, ${h.lastUnfollowedAt}, ${h.unfollowCount}, ?, ?)
         ON CONFLICT(line_user_id) DO UPDATE SET
           display_name = excluded.display_name,
           picture_url = excluded.picture_url,
           status_message = excluded.status_message,
           updated_at = excluded.updated_at`,
      )
      .bind(
        crypto.randomUUID(), u, input.displayName, input.pictureUrl, input.statusMessage,
        u, // is_following
        followAt, // first_followed_at
        u, u, followAt, // current_follow_started_at: following(u) + stateAt(u) + fallback
        u, u, followAt, // last_followed_at: following(u) + stateAt(u) + fallback
        u, u, // last_unfollowed_at
        u, // unfollow_count
        nowJst, nowJst,
      ),
    followSyncStatement(db, u, nowJst),
    clearPendingStatement(db, u),
  ]);
}

/**
 * follow を経ていない送信者（導入前からの既存友だち）を、メッセージ受信時に友だち登録する（1 batch）。
 * - 既に登録済みなら何もしない（ON CONFLICT DO NOTHING＝既存行の状態・表示名を書き換えない）
 * - 状態・履歴は friend_follow_state と保留分（K002）から作る。状態が無ければフォロー中・開始日時＝登録時刻
 *   （本家 #174 の upsertFriend と同じ起点）
 * friend_add イベントは発火しない（既存友だちをあいさつシナリオに入れない）。
 */
export async function registerFriendFromMessage(
  db: D1Database,
  input: { lineUserId: string; displayName: string | null; pictureUrl: string | null; statusMessage: string | null },
  nowJst: string,
): Promise<void> {
  const h = newFriendHistorySql('?');
  const u = input.lineUserId;
  await db.batch([
    db
      .prepare(
        `INSERT INTO friends
           (id, line_user_id, display_name, picture_url, status_message, is_following,
            first_followed_at, current_follow_started_at, last_followed_at, last_unfollowed_at, unfollow_count,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ${h.isFollowing}, ?, ${h.currentFollowStartedAt}, ${h.lastFollowedAt}, ${h.lastUnfollowedAt}, ${h.unfollowCount}, ?, ?)
         ON CONFLICT(line_user_id) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(), u, input.displayName, input.pictureUrl, input.statusMessage,
        u, // is_following
        nowJst, // first_followed_at
        u, u, nowJst, // current_follow_started_at: following(u) + stateAt(u) + fallback
        u, u, nowJst, // last_followed_at
        u, u, // last_unfollowed_at
        u, // unfollow_count
        nowJst, nowJst,
      ),
    clearPendingStatement(db, u),
  ]);
}

/** epoch ms → jstNow() と同じ形式（YYYY-MM-DDTHH:mm:ss.sss+09:00）。 */
export function toJstFromEpoch(ms: number): string {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
}

/**
 * 受信イベントでチャットを未読化・最終受信時刻を更新する（WEBHOOK_INBOX 時の upsertChatOnMessage 置き換え）。
 * イベント時刻で条件付き: 既にこのイベント時刻以上を反映済みなら何もしない＝再処理で対応済みチャットを未読に戻さない。
 * last_message_at は処理時刻ではなくイベント時刻。
 */
export async function touchChatOnIncomingEvent(db: D1Database, friendId: string, eventTimestamp: number, nowJst: string): Promise<void> {
  const eventAt = toJstFromEpoch(eventTimestamp);
  // 本家 048 で chats(friend_id) は一意。未作成なら作る（並行で先に作られていれば無視して UPDATE へ）。
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO chats (id, friend_id, operator_id, last_message_at, last_incoming_event_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), friendId, eventAt, eventTimestamp, nowJst, nowJst)
    .run();
  if ((inserted.meta?.changes ?? 0) >= 1) return;
  await db
    .prepare(
      `UPDATE chats
          SET status = CASE WHEN status = 'resolved' THEN 'unread' ELSE status END,
              last_message_at = ?, last_incoming_event_at = ?, updated_at = ?
        WHERE friend_id = ? AND (last_incoming_event_at IS NULL OR last_incoming_event_at < ?)`,
    )
    .bind(eventAt, eventTimestamp, nowJst, friendId, eventTimestamp)
    .run();
}

/**
 * 受信ログを冪等に挿入する（WEBHOOK_INBOX 時）。
 * - webhook_event_id / line_message_id の部分一意インデックスで重複を無視
 * - 本文は挿入文の中で unsent_messages を参照して決める＝取消判定と挿入が原子的
 * 挿入できたら true（false＝既に記録済み＝再処理）。
 */
export async function insertIncomingLog(
  db: D1Database,
  input: {
    friendId: string;
    messageType: string;
    content: string;
    source: string;
    lineMessageId: string | null;
    webhookEventId: string | null;
    lineAccountId?: string | null;
    createdAt: string;
  },
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO messages_log
         (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_message_id, webhook_event_id, line_account_id, created_at)
       VALUES (?, ?, 'incoming', ?,
               CASE WHEN ? IS NOT NULL AND EXISTS (SELECT 1 FROM unsent_messages WHERE line_message_id = ?) THEN ? ELSE ? END,
               NULL, NULL, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.friendId,
      input.messageType,
      input.lineMessageId,
      input.lineMessageId,
      UNSENT_PLACEHOLDER,
      input.content,
      input.source,
      input.lineMessageId,
      input.webhookEventId,
      input.lineAccountId ?? null,
      input.createdAt,
    )
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
  /** 未設定なら転送せず false（mirror_attempts は増やさない＝鍵設定後に Cron が拾う）。 */
  secret: string | undefined;
  now?: () => number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** 1 行をミラー転送する。2xx なら mirrored=1、それ以外は mirror_attempts++ して false。 */
export async function mirrorInboxRow(deps: MirrorDeps, row: { webhook_event_id: string; body_json: string }): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const { db } = deps;
  if (!deps.secret) {
    warnMirrorMisconfigOnce({ WEBHOOK_INBOX: '1', MIRROR_URL: deps.url });
    return false;
  }
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

  if (deps.mirror && !deps.mirror.secret) {
    warnMirrorMisconfigOnce({ WEBHOOK_INBOX: '1', MIRROR_URL: deps.mirror.url });
  } else if (deps.mirror) {
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
