-- [Craval kzn] K004: きずな通知 cron の独立監視（kizuna-shonin docs/unified-inbox-plan.md Phase D3）。
-- ハーネスの 5 分 Cron が きずな の /api/ops/heartbeat を読み、30 分以上止まっていたら Google Chat へ通知する。
-- 同じ停止で連投しない（1 時間に 1 回まで）・復旧したら 1 回だけ知らせる、のための状態。追加のみ（既存に触れない）。
CREATE TABLE IF NOT EXISTS craval_watchdog (
  name            TEXT PRIMARY KEY,
  alerting        INTEGER NOT NULL DEFAULT 0,   -- 1＝停止を通知済みで復旧待ち
  last_alert_at   INTEGER,                      -- 直近に停止を通知した時刻（ms）
  last_checked_at INTEGER,                      -- 直近に確認した時刻（ms）
  last_detail     TEXT                          -- 直近の判定理由（個人情報なし）
);
