-- K003_line_media.sql — [Craval kzn] kzn 専用・追記 migration（K002 の後）。追加のみ。
-- LINE の受信メディア（画像・動画・音声・ファイル）を受信時点で保全する（LINE_MEDIA_STORE=1 の環境だけが使う）。
-- LINE Content API は保存期間の保証がないため、webhook_inbox に永続化した直後に取得し、非公開 R2 に保存する。
-- webhook_inbox（30日で削除）とは独立して状態を持つ。PII は持たない（送信者は userId の SHA-256 先頭16桁のみ）。
--
-- status: pending（取得待ち・再試行中）/ done（R2 保存済み）/ failed（再試行を使い切った）
--         / expired（404・410・外部提供・サイズ超過＝取得不能が確定）/ unsent（送信取消＝取得しない・保存済みは削除）
-- mirrored: 状態の変更をきずなへ転送済みか（0＝未転送。Cron が再転送する）
-- lease_until / lease_token: 取得中の排他（Webhook 直後の取得と Cron が同じ行を同時に取らない）。期限切れなら取り直せる。
--   状態の確定（done/再試行/確定失敗）は lease_token が一致する所有者だけが行える。
-- orphan_key: 所有権を失った実行が書いてしまい、削除にも失敗したオブジェクト（Cron が削除して NULL に戻す）。
-- ※ 未適用の段階で lease_until を追加済み（2026-09-28 CODEX レビュー）。以後は追記 migration（K004〜）のみ。
CREATE TABLE IF NOT EXISTS line_media (
  line_message_id  TEXT PRIMARY KEY,
  webhook_event_id TEXT NOT NULL,
  line_account_id  TEXT,
  user_hash        TEXT NOT NULL,
  message_type     TEXT NOT NULL,
  file_name        TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'expired', 'unsent')),
  reason           TEXT,
  r2_key           TEXT,
  content_type     TEXT,
  size             INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  received_at      INTEGER NOT NULL,
  mirrored         INTEGER NOT NULL DEFAULT 1,
  mirror_attempts  INTEGER NOT NULL DEFAULT 0,
  r2_deleted       INTEGER NOT NULL DEFAULT 0,
  lease_until      INTEGER,
  lease_token      TEXT,
  orphan_key       TEXT,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_line_media_due ON line_media (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_line_media_unmirrored ON line_media (mirrored, mirror_attempts);
