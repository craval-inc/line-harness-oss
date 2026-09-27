#!/usr/bin/env bash
# [Craval kzn] kzn 本番 D1 を本家 v0.24 に上げる（APPLY-v0.24.md の ③〜⑤）。
# 最初の失敗で全体停止（set -euo pipefail）。途中で止まったら APPLY-v0.24.md の「失敗時」に従う。
#
# 前提（このスクリプトの外で済ませる）:
#   ① 新 Worker(craval-v0.24) を --var WEBHOOK_MAINTENANCE:1 でデプロイ済み（受信は 503・定期処理停止）
#   ② bookmark と export を取得済み（このスクリプトでも取るが、先に手で控えておく）
# 使い方: cd apps/worker && cf-bkobu && bash ../../scripts/kzn-apply-v024.sh
set -euo pipefail

cd "$(dirname "$0")/../apps/worker"
DB=line-harness-kzn
CFG=wrangler.kzn.toml
M=../../packages/db/migrations
K=../../packages/db/migrations-kzn
TS=$(date +%Y%m%d-%H%M%S)
OUT=/c/temp/kzn/apply-$TS
mkdir -p "$OUT"

d1() { npx wrangler d1 execute "$DB" --remote -c "$CFG" "$@"; }
step() { echo; echo "=== $* ($(date +%H:%M:%S))"; }

step "0) 取り違え防止チェック"
[ "${CLOUDFLARE_ACCOUNT_ID:-}" = "01547b03881149dd0db10da0da6928c8" ] || { echo "NG: cf-bkobu を先に実行"; exit 1; }
grep -q '^WEBHOOK_MAINTENANCE' "$CFG" && { echo "NG: WEBHOOK_MAINTENANCE は toml に書かず --var で渡す"; exit 1; }

step "② 退避: time-travel bookmark と export"
npx wrangler d1 time-travel info "$DB" -c "$CFG" | tee "$OUT/bookmark.txt"
npx wrangler d1 export "$DB" --remote -c "$CFG" --output="$OUT/kzn-before-v024.sql"

step "事前確認（控え）"
d1 --json --command "SELECT (SELECT COUNT(*) FROM friends) AS friends, (SELECT COUNT(*) FROM messages_log) AS msgs, (SELECT COUNT(*) FROM webhook_inbox) AS inbox, (SELECT COUNT(*) FROM unsent_messages) AS unsent" | tee "$OUT/before-counts.json"
d1 --json --command "SELECT friend_id, COUNT(*) AS n FROM chats GROUP BY friend_id HAVING COUNT(*) > 1" | tee "$OUT/dup-chats.json"

step "③ 本家 046〜072（048 の直前に kzn-pre-048）"
for f in 046_affiliate_links 046_link_tracking_controls 047_affiliate_offers; do
  echo "--- $f"; d1 --file="$M/$f.sql"
done
echo "--- kzn-pre-048"; d1 --file="$K/kzn-pre-048.sql"
for f in 048_chats_friend_unique 049_tracked_links_short_code 050_tracked_links_auto_dedup \
         051_booking_recurring_availability_google_calendar 051_webinars 055_webinar_ctas 056_webinar_registrations \
         057_webinar_funnel_events 058_webinar_followups 059_meet_consultation_reminders 060_webinar_journey_followups \
         061_mileage_foundation 062_mileage_admin_and_activity_rules 063_webinar_instagram_mileage \
         064_async_mileage_and_tag_policy 065_following_loyalty_mileage 066_referral_quality_mileage \
         067_mileage_keyword_auto_reply 068_media_inquiries 069_rich_menu_selected 070_admin_sso_jti \
         071_quota_alerts 072_broadcast_last_error 072_health_logs_composite_index; do
  echo "--- $f"; d1 --file="$M/$f.sql"
done

step "④ kzn 後処理（マイル自動応答・ルール停止・移行由来マイル削除）"
d1 --file="$K/kzn-post-v024.sql"

step "⑤ 検証ゲート（NG なら exit 1＝デプロイに進まない）"
d1 --json --command "SELECT (SELECT COUNT(*) FROM friends) AS friends, (SELECT COUNT(*) FROM messages_log) AS msgs, (SELECT COUNT(*) FROM webhook_inbox) AS inbox, (SELECT COUNT(*) FROM unsent_messages) AS unsent" | tee "$OUT/after-counts.json"
node -e '
const fs = require("fs");
const pick = (f) => { const j = JSON.parse(fs.readFileSync(f, "utf8")); return (Array.isArray(j) ? j[0] : j).results[0]; };
const a = pick(process.argv[1]), b = pick(process.argv[2]);
for (const k of Object.keys(a)) if (Number(a[k]) !== Number(b[k])) { console.error(`NG: ${k} before=${a[k]} after=${b[k]}`); process.exit(1); }
console.log("counts unchanged:", JSON.stringify(b));
' "$OUT/before-counts.json" "$OUT/after-counts.json"
node ../../scripts/kzn-d1-gate.mjs

echo
echo "OK: D1 は v0.24。次は ⑥ WEBHOOK_MAINTENANCE 無しで新 Worker をデプロイ（APPLY-v0.24.md）。"
echo "    記録: $OUT"
