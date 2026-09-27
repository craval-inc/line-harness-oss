-- 046_kzn_webhook_inbox.sql
-- [Craval kzn] LINE Webhook 受信箱（WEBHOOK_INBOX=1 の環境だけが使う。未設定の環境では参照されない）。
-- 追加のみ（additive-only）。既存テーブル・既存行の意味は変えない。
--
-- webhook_inbox: 署名検証後に LINE の生イベントを同期保存し、処理(processed)と外部ミラー転送(mirrored)を
--                別フラグで管理する。途中失敗は Cron が再処理する。
-- unsent_messages: 送信取消済みの LINE message id。取消が元メッセージより先に届いても本文を保存しない。
-- messages_log.line_message_id: 受信メッセージの LINE message id（WEBHOOK_INBOX 時のみ入る）。重複挿入防止。
-- friends.follow_state_at: follow/unfollow を最後に反映したイベント時刻(ms)。古いイベントで状態を巻き戻さない。

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

ALTER TABLE messages_log ADD COLUMN line_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_log_line_message_id
  ON messages_log (line_message_id) WHERE line_message_id IS NOT NULL;

ALTER TABLE friends ADD COLUMN follow_state_at INTEGER;
