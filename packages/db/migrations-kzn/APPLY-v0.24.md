# kzn 本番 D1 を本家 v0.24（craval-v0.24）に上げる適用手順

対象: bkobu `line-harness-kzn`（database_id `d13fdca6-6e95-4084-8a34-b3709a0a92f7`）
現状: `kzn-bootstrap.sql`（本番 sbo の schema-only export＝本家 045 まで相当）＋ `046_kzn_webhook_inbox.sql`（= 本ディレクトリの `K001_webhook_inbox.sql`）適用済み。
検証: 本番の再現 DB（kzn-bootstrap + K001 + サンプルデータ）に下記手順を通し、データ保持・チャット統合・最終スキーマ＝`bootstrap.sql`+K001 と完全一致を確認済み（2026-09-28）。

## 番号衝突と kzn 専用 migration の扱い

- 本家にも `046_affiliate_links.sql` / `046_link_tracking_controls.sql` があり、旧 `046_kzn_webhook_inbox.sql` と番号が衝突する。
- kzn 専用 migration は `packages/db/migrations-kzn/K001...` に移した（本家の `migrations/`・リリースバンドル・sbo/fzk には混ぜない）。SQL 本文は旧 046 と同一なので **kzn 本番で再実行しない**。
- kzn は wrangler の `d1 migrations` 管理テーブルを使っていない（手動 `d1 execute --file`）。本手順も手動で順に当てる。

## 手順（デプロイより前に D1 を上げる。v0.24 の Worker は新テーブルを参照するため）

```bash
cd /c/dev/line-harness-oss/apps/worker && cf-bkobu   # D1 Edit 権限のトークン（CF-BKO.BU-harness）
DB=line-harness-kzn; W="npx wrangler d1 execute $DB --remote -c wrangler.kzn.toml"

# 0) 退避（どちらか必須）
npx wrangler d1 time-travel info $DB -c wrangler.kzn.toml        # 表示された bookmark を控える（戻す時: time-travel restore --bookmark=...）
npx wrangler d1 export $DB --remote -c wrangler.kzn.toml --output=/c/temp/kzn/kzn-before-v024.sql

# 1) 事前確認（結果を控える）
$W --command "SELECT COUNT(*) AS friends FROM friends; SELECT COUNT(*) AS msgs FROM messages_log; SELECT COUNT(*) AS inbox FROM webhook_inbox;"
$W --command "SELECT friend_id, COUNT(*) FROM chats GROUP BY friend_id HAVING COUNT(*) > 1;"   # 048 で統合される重複（0件想定）
$W --command "SELECT COUNT(*) FROM tracked_links;"                                            # 049/050 の一意化対象（0件想定）

# 2) 本家 046〜072 を順に（048 の直前だけ kzn-pre-048.sql を挟む）
M=../../packages/db/migrations; K=../../packages/db/migrations-kzn
for f in 046_affiliate_links 046_link_tracking_controls 047_affiliate_offers; do $W --file=$M/$f.sql || break; done
$W --file=$K/kzn-pre-048.sql
for f in 048_chats_friend_unique 049_tracked_links_short_code 050_tracked_links_auto_dedup \
         051_booking_recurring_availability_google_calendar 051_webinars 055_webinar_ctas 056_webinar_registrations \
         057_webinar_funnel_events 058_webinar_followups 059_meet_consultation_reminders 060_webinar_journey_followups \
         061_mileage_foundation 062_mileage_admin_and_activity_rules 063_webinar_instagram_mileage \
         064_async_mileage_and_tag_policy 065_following_loyalty_mileage 066_referral_quality_mileage \
         067_mileage_keyword_auto_reply 068_media_inquiries 069_rich_menu_selected 070_admin_sso_jti \
         071_quota_alerts 072_broadcast_last_error 072_health_logs_composite_index; do
  $W --file=$M/$f.sql || { echo "STOP at $f"; break; }
done

# 3) kzn の後処理（067 の自動応答「マイル」無効化・マイレージ付与ルール全停止）
$W --file=$K/kzn-post-v024.sql

# 4) 事後確認
$W --command "SELECT COUNT(*) FROM friends; SELECT COUNT(*) FROM messages_log; SELECT COUNT(*) FROM webhook_inbox;"   # 1) と一致
$W --command "SELECT is_active FROM auto_replies WHERE id='builtin-mileage-wallet-keyword'; SELECT COUNT(*) FROM mileage_rules WHERE is_active=1;"  # 0 / 0
$W --command "SELECT name FROM sqlite_master WHERE name IN ('sso_jti','quota_alerts','mileage_event_queue','idx_chats_friend_unique');"

# 5) その後に Worker を craval-v0.24 でデプロイ（node ../../scripts/check-kzn-target.mjs → line-sdk build → wrangler deploy -c wrangler.kzn.toml）
```

途中で止まった場合: 失敗したファイル以降は当てずに、0) の bookmark で restore してから原因を確認する（各ファイルは IF NOT EXISTS / 追加のみだが、ALTER の途中失敗は再実行で duplicate column になるため）。

## 各ファイルの中身（kzn への影響）

| 範囲 | 内容 | kzn での注意 |
|---|---|---|
| 046〜047 | アフィリエイト・リンク計測設定 | 未使用機能。テーブル追加のみ |
| 048 | chats を friend 1行に統合＋一意インデックス | 事前に `kzn-pre-048.sql` で `last_incoming_event_at` を MAX に揃える |
| 049〜050 | tracked_links の short_code / 重複排除 | kzn は tracked_links 0件想定 |
| 051〜060 | 予約カレンダー・ウェビナー・Meet 相談 | 未使用。テーブル追加のみ |
| 061〜067 | マイレージ（ルール・キュー）＋既定データ | 067 は全アカウント共通の自動応答「マイル」を**有効で**投入 → `kzn-post-v024.sql` で無効化 |
| 068〜072 | 問い合わせ・リッチメニュー選択・SSO jti・通数アラート・配信エラー | テーブル/列/インデックス追加 |
