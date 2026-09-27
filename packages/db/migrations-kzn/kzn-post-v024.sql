-- kzn-post-v024.sql — 本家 046〜072 を当てた直後に1回だけ実行（kzn 専用・冪等）。
-- 本家 migration が kzn に持ち込む「顧客向けに動き得る既定データ」を止める。
-- 1) 067 が全アカウント共通で有効化する自動応答「マイル」（Harness マイル案内 Flex・LIFF 前提）を無効化。
--    kzn は LIFF もマイレージも使わない。EVENT_BUS_DISABLED/LINE_SEND_DISABLED を外した後に誤応答しないため。
UPDATE auto_replies SET is_active = 0 WHERE id = 'builtin-mileage-wallet-keyword';
-- 2) 061〜066 が投入するマイレージ付与ルールを全て無効化（付与は mileage_rules.is_active で判定される）。
UPDATE mileage_rules SET is_active = 0 WHERE is_active = 1;
