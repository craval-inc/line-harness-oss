-- K001_webhook_inbox.sql（旧名 046_kzn_webhook_inbox.sql）
-- [Craval kzn] LINE Webhook 受信箱（WEBHOOK_INBOX=1 の環境だけが使う。未設定の環境では参照されない）。
-- kzn 専用。本家の migrations/ とは番号体系を分ける（本家にも 046_* があり衝突するため・リリースバンドルに混ぜない）。
-- kzn 本番には 2026-09-27 に「046_kzn_webhook_inbox.sql」として適用済み（内容は本ファイルと同一）。
-- 以後は書き換えず、変更は追記（K002 以降）のみで行う。
-- 追加のみ（additive-only）。既存テーブル・既存行の意味は変えない。
--
-- webhook_inbox: 署名検証後に LINE の生イベントを同期保存し、処理(processed)と外部ミラー転送(mirrored)を
--                別フラグで管理する。途中失敗は Cron が再処理する。
-- unsent_messages: 送信取消済みの LINE message id。取消が元メッセージより先に届いても本文を保存しない。
-- friend_follow_state: follow/unfollow の最新状態とそのイベント時刻(ms)。友だち未登録の unfollow も保持し、
--                      古いイベントで状態を巻き戻さない。friends.is_following はここから同期する。
-- messages_log.line_message_id / webhook_event_id: 受信ログの重複挿入防止（WEBHOOK_INBOX 時のみ入る）。
-- chats.last_incoming_event_at: 未読化・最終受信時刻を反映した受信イベント時刻(ms)。再処理で対応済みを未読に戻さない。

CREATE TABLE IF NOT EXISTS webhook_inbox (
  webhook_event_id TEXT PRIMARY KEY,
  event_type       TEXT NOT NULL,
  line_message_id  TEXT,
  line_account_id  TEXT,
  event_timestamp  INTEGER,
  body_json        TEXT NOT NULL,
  processed        INTEGER NOT NULL DEFAULT 0,
  mirrored         INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  mirror_attempts  INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  received_at      INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_pending ON webhook_inbox (processed, attempts, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_unmirrored ON webhook_inbox (mirrored, mirror_attempts, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_line_message_id ON webhook_inbox (line_message_id);

CREATE TABLE IF NOT EXISTS unsent_messages (
  line_message_id TEXT PRIMARY KEY,
  unsent_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS friend_follow_state (
  line_user_id TEXT PRIMARY KEY,
  is_following INTEGER NOT NULL,
  state_at     INTEGER NOT NULL
);

ALTER TABLE messages_log ADD COLUMN line_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_log_line_message_id
  ON messages_log (line_message_id) WHERE line_message_id IS NOT NULL;

ALTER TABLE messages_log ADD COLUMN webhook_event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_log_webhook_event_id
  ON messages_log (webhook_event_id) WHERE webhook_event_id IS NOT NULL;

ALTER TABLE chats ADD COLUMN last_incoming_event_at INTEGER;
