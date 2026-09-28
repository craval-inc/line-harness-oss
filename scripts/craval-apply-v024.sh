#!/usr/bin/env bash
# [Craval] sbo / fzk 本番 D1 を本家 v0.24 に上げる（packages/db/migrations-craval/APPLY-sbo-fzk-v0.24.md の ②〜⑤）。
# kzn は scripts/kzn-apply-v024.sh（kzn 専用の前後処理・K00x がある）。
# 最初の失敗で全体停止（set -euo pipefail）。途中で止まったら手順書の「失敗時」に従う。
#
# 前提（このスクリプトの外で済ませる）:
#   ① 新 Worker(craval-v0.24) を --var WEBHOOK_MAINTENANCE:1 でデプロイ済み（受信は 503・定期処理停止）
#      直後に export MAINT_STARTED=$(date +%s)（旧版の実行が上限15分で終わるまで退避を待つため）
# 使い方: cd apps/worker && cf-craval && bash ../../scripts/craval-apply-v024.sh <sbo|fzk> [--keep-mileage]
set -euo pipefail

TENANT="${1:-}"
KEEP_MILEAGE=0
[ "${2:-}" = "--keep-mileage" ] && KEEP_MILEAGE=1
case "$TENANT" in
  sbo) DB=line-harness-sbo; DBID=c8a9c07f-ae70-4d3a-8f22-86fa0828238e ;;
  fzk) DB=line-harness-fzk; DBID=d85dd5d0-7bc3-43ea-8f8a-a4eda6d82709 ;;
  *) echo "usage: bash scripts/craval-apply-v024.sh <sbo|fzk> [--keep-mileage]"; exit 1 ;;
esac

cd "$(dirname "$0")/../apps/worker"
CFG=wrangler.$TENANT.toml
M=../../packages/db/migrations
C=../../packages/db/migrations-craval
TS=$(date +%Y%m%d-%H%M%S)
OUT=/c/temp/craval-apply/$TENANT-$TS
mkdir -p "$OUT"

d1() { npx wrangler d1 execute "$DB" --remote -c "$CFG" "$@"; }
step() { echo; echo "=== $* ($(date +%H:%M:%S))"; }

step "0) 取り違え防止チェック"
[ "${CLOUDFLARE_ACCOUNT_ID:-}" = "48cf2f856a84ba4baca7b9e4484b50c1" ] || { echo "NG: cf-craval を先に実行"; exit 1; }
node ../../scripts/check-craval-target.mjs "$TENANT"
grep -q "database_id = \"$DBID\"" "$CFG" || { echo "NG: $CFG の database_id が $DBID ではない"; exit 1; }
# 本家 046 は既存テーブルに ALTER を含むので、既に 046 以降が当たっている DB に再実行すると失敗する＝事前に未適用を確認
if d1 --json --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('affiliate_links','mileage_rules')" | grep -q '"name"'; then
  echo "NG: 046 以降が既に適用済み（affiliate_links / mileage_rules が存在）。手順書の「途中から再開」を参照"; exit 1
fi

step "①' 旧版の実行が終わるまで待つ（Cloudflare の上限: Cron は最長15分・waitUntil は応答後30秒）"
# メンテ用デプロイ直後に MAINT_STARTED=$(date +%s) を export しておく（手順書 1.）。デプロイ前に始まった実行は
# 最長でも15分で終わるので、デプロイから15分（+1分の余裕）経つまで退避しない＝restore で消える書き込みを作らない。
[ -n "${MAINT_STARTED:-}" ] || { echo "NG: MAINT_STARTED が未設定（メンテ用デプロイ直後に export MAINT_STARTED=\$(date +%s)）"; exit 1; }
MIN_WAIT=${MIN_WAIT_SEC:-960}
elapsed=$(( $(date +%s) - MAINT_STARTED ))
if [ "$elapsed" -lt "$MIN_WAIT" ]; then echo "  メンテ開始から ${elapsed}s。あと $((MIN_WAIT - elapsed))s 待つ"; sleep $((MIN_WAIT - elapsed)); fi

step "①' 静止確認（念のため・書き込み指標が 60 秒おき3回一致）"
# Worker の実行は最大でも数分で終わる。書き込み指標（主要テーブルの件数と最新時刻）が 60 秒おき 3 回連続で同じになるまで待つ。
QUIET_SQL="SELECT (SELECT COUNT(*) FROM friends)||'/'||(SELECT COUNT(*) FROM messages_log)||'/'||(SELECT COUNT(*) FROM chats)||'/'||(SELECT COUNT(*) FROM friend_scenarios)||'/'||(SELECT COUNT(*) FROM account_health_logs)||'/'||COALESCE((SELECT MAX(created_at) FROM account_health_logs),'')||'/'||COALESCE((SELECT MAX(created_at) FROM messages_log),'')||'/'||COALESCE((SELECT MAX(updated_at) FROM friends),'') AS sig"
prev=""; same=0
for i in $(seq 1 15); do
  sig=$(d1 --json --command "$QUIET_SQL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((Array.isArray(j)?j[0]:j).results[0].sig)})')
  echo "  [$i] $sig"
  if [ "$sig" = "$prev" ]; then same=$((same+1)); else same=0; fi
  prev="$sig"
  [ "$same" -ge 2 ] && break
  sleep 60
done
[ "$same" -ge 2 ] || { echo "NG: 15 分待っても書き込みが止まらない（メンテ前の処理が走り続けている）。退避せず中止"; exit 1; }

step "② 退避: time-travel bookmark と export"
npx wrangler d1 time-travel info "$DB" -c "$CFG" | tee "$OUT/bookmark.txt"
npx wrangler d1 export "$DB" --remote -c "$CFG" --output="$OUT/$TENANT-before-v024.sql"

COUNT_SQL="SELECT (SELECT COUNT(*) FROM friends) AS friends, (SELECT COUNT(*) FROM messages_log) AS msgs, (SELECT COUNT(*) FROM chats) AS chats, (SELECT COUNT(*) FROM scenarios) AS scenarios, (SELECT COUNT(*) FROM scenario_steps) AS steps, (SELECT COUNT(*) FROM friend_scenarios) AS friend_scenarios, (SELECT COUNT(*) FROM tags) AS tags, (SELECT COUNT(*) FROM line_accounts) AS line_accounts, (SELECT COUNT(*) FROM tracked_links) AS tracked_links, (SELECT COUNT(*) FROM broadcasts) AS broadcasts"
step "事前件数（控え）"
d1 --json --command "$COUNT_SQL" | tee "$OUT/before-counts.json"
d1 --json --command "SELECT friend_id, COUNT(*) AS n FROM chats GROUP BY friend_id HAVING COUNT(*) > 1" | tee "$OUT/dup-chats.json"

step "③ 本家 046〜072"
for f in 046_affiliate_links 046_link_tracking_controls 047_affiliate_offers \
         048_chats_friend_unique 049_tracked_links_short_code 050_tracked_links_auto_dedup \
         051_booking_recurring_availability_google_calendar 051_webinars 055_webinar_ctas 056_webinar_registrations \
         057_webinar_funnel_events 058_webinar_followups 059_meet_consultation_reminders 060_webinar_journey_followups \
         061_mileage_foundation 062_mileage_admin_and_activity_rules 063_webinar_instagram_mileage \
         064_async_mileage_and_tag_policy 065_following_loyalty_mileage 066_referral_quality_mileage \
         067_mileage_keyword_auto_reply 068_media_inquiries 069_rich_menu_selected 070_admin_sso_jti \
         071_quota_alerts 072_broadcast_last_error 072_health_logs_composite_index; do
  echo "--- $f"; d1 --file="$M/$f.sql"
done

if [ "$KEEP_MILEAGE" = "0" ]; then
  step "④ 後処理: マイレージ停止（自動応答「マイル」・付与ルール・移行由来付与）"
  d1 --file="$C/craval-post-v024-mileage-off.sql"
else
  step "④ 後処理: --keep-mileage のためマイレージは本家既定のまま（自動応答「マイル」有効）"
fi

step "⑤ 検証ゲート（NG なら exit 1＝デプロイに進まない）"
d1 --json --command "$COUNT_SQL" | tee "$OUT/after-counts.json"
node -e '
const fs = require("fs");
const pick = (f) => { const j = JSON.parse(fs.readFileSync(f, "utf8")); return (Array.isArray(j) ? j[0] : j).results[0]; };
const a = pick(process.argv[1]), b = pick(process.argv[2]);
// 048 は重複チャットを1行に統合するので chats だけは「減ってよい（重複件数分）」。他は完全一致。
const dup = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const dupRows = (Array.isArray(dup) ? dup[0] : dup).results.reduce((s, r) => s + (Number(r.n) - 1), 0);
for (const k of Object.keys(a)) {
  const want = k === "chats" ? Number(a[k]) - dupRows : Number(a[k]);
  if (Number(b[k]) !== want) { console.error(`NG: ${k} before=${a[k]} after=${b[k]} expected=${want}`); process.exit(1); }
}
console.log("counts ok:", JSON.stringify(b));
' "$OUT/before-counts.json" "$OUT/after-counts.json" "$OUT/dup-chats.json"
if [ "$KEEP_MILEAGE" = "0" ]; then node ../../scripts/craval-d1-gate.mjs "$TENANT"; else node ../../scripts/craval-d1-gate.mjs "$TENANT" --keep-mileage; fi

echo
echo "OK: $DB は v0.24。次は ⑥ WEBHOOK_MAINTENANCE 無しで新 Worker をデプロイ（手順書）。"
echo "    記録: $OUT"
