-- craval-post-v024-mileage-off.sql — sbo / fzk を本家 046〜072 に上げた直後に1回だけ実行（冪等）。
-- 本家 v0.24 のマイレージ機能（061〜067）は Craval の sbo（セールスキャスト）/ fzk（フゾカテ）では使わない前提で止める。
-- 使う判断になったら、このファイルを実行しない（=本家既定のまま）か、管理画面から個別に有効化する。
-- 1) 067 が全アカウント共通で有効化する自動応答「マイル」（キーワード「マイル」に Flex で残高案内）を無効化。
UPDATE auto_replies SET is_active = 0 WHERE id = 'builtin-mileage-wallet-keyword';
-- 2) 061〜066 が投入するマイレージ付与ルールを全て無効化。
UPDATE mileage_rules SET is_active = 0 WHERE is_active = 1;
-- 3) 062/063 が既存履歴から台帳へ直接入れた「移行由来の付与」を削除（2026-09-28 の dry-run では sbo/fzk とも 0 件）。
DELETE FROM mileage_ledger WHERE id LIKE 'history-mile-%';
DELETE FROM engagement_events
 WHERE id LIKE 'history-%'
   AND NOT EXISTS (SELECT 1 FROM mileage_ledger l WHERE l.engagement_event_id = engagement_events.id)
   AND NOT EXISTS (SELECT 1 FROM mileage_event_queue q WHERE q.engagement_event_id = engagement_events.id);
