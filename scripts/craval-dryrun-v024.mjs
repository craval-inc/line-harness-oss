// [Craval] sbo / fzk の本番 D1 export に本家 046〜072（＋任意で後処理）をローカル SQLite で当てる dry-run。本番には触れない。
// 使い方: node scripts/craval-dryrun-v024.mjs <export.sql> [packages/db/migrations-craval/craval-post-v024-mileage-off.sql]
//   export は `npx wrangler d1 export line-harness-<sbo|fzk> --remote -c wrangler.<t>.toml --output <file>`（読み取りのみ）
// D1 export は文の順序が CREATE TABLE と参照でばらばらなので、テーブル作成→その他→INSERT の順に読み込む。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [, , dump, postFile] = process.argv;
const M = join(repoRoot, 'packages', 'db', 'migrations') + '/';
const LIST = ['046_affiliate_links', '046_link_tracking_controls', '047_affiliate_offers', '048_chats_friend_unique', '049_tracked_links_short_code', '050_tracked_links_auto_dedup', '051_booking_recurring_availability_google_calendar', '051_webinars', '055_webinar_ctas', '056_webinar_registrations', '057_webinar_funnel_events', '058_webinar_followups', '059_meet_consultation_reminders', '060_webinar_journey_followups', '061_mileage_foundation', '062_mileage_admin_and_activity_rules', '063_webinar_instagram_mileage', '064_async_mileage_and_tag_policy', '065_following_loyalty_mileage', '066_referral_quality_mileage', '067_mileage_keyword_auto_reply', '068_media_inquiries', '069_rich_menu_selected', '070_admin_sso_jti', '071_quota_alerts', '072_broadcast_last_error', '072_health_logs_composite_index'];

function load(db, file) {
  const sql = readFileSync(file, 'utf8');
  const stmts = sql.split(new RegExp(';\\s*\\n')).map((s) => s.trim()).filter(Boolean);
  const isTable = (s) => /^CREATE TABLE/i.test(s);
  db.exec('PRAGMA foreign_keys=OFF');
  for (const s of stmts.filter(isTable)) db.exec(s + ';');
  for (const s of stmts.filter((s) => !isTable(s) && !/^INSERT/i.test(s) && !/^PRAGMA/i.test(s))) {
    try { db.exec(s + ';'); } catch (e) { console.log('skip', s.slice(0, 60), e.message); }
  }
  for (const s of stmts.filter((s) => /^INSERT/i.test(s))) db.exec(s + ';');
}

const db = new DatabaseSync(':memory:');
load(db, dump);
const TABLES = ['friends', 'messages_log', 'chats', 'scenarios', 'scenario_steps', 'auto_replies', 'tags', 'line_accounts', 'traffic_pools', 'pool_accounts', 'account_health_logs', 'tracked_links'];
const counts = () => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT count(*) n FROM ${t}`).get().n]));
const before = counts();
const t0 = Date.now();
for (const f of LIST) {
  try { db.exec(readFileSync(M + f + '.sql', 'utf8')); } catch (e) { console.log('FAIL', f, e.message); process.exit(1); }
}
if (postFile) db.exec(readFileSync(postFile, 'utf8'));
const after = counts();
const q = (s) => { try { return db.prepare(s).all(); } catch (e) { return 'ERR ' + e.message; } };
console.log(JSON.stringify({
  dump, post: postFile ?? null, ms: Date.now() - t0, before,
  countDiff: Object.keys(before).filter((k) => before[k] !== after[k]).map((k) => `${k}:${before[k]}->${after[k]}`),
  mileageAutoReply: q("SELECT id, is_active FROM auto_replies WHERE id='builtin-mileage-wallet-keyword'"),
  mileageRulesActive: q('SELECT count(*) n FROM mileage_rules WHERE is_active=1'),
  mileageLedger: q("SELECT count(*) n, COALESCE(SUM(CASE WHEN status='available' THEN amount ELSE 0 END),0) avail FROM mileage_ledger"),
  autoReplies: q('SELECT id, keyword, is_active FROM auto_replies'),
}));
const ref = new DatabaseSync(':memory:');
ref.exec(readFileSync(join(repoRoot, 'packages', 'db', 'bootstrap.sql'), 'utf8'));
const cols = (d) => new Set(d.prepare("SELECT m.name||'.'||p.name c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%'").all().map((r) => r.c));
const a = cols(db), b = cols(ref);
console.log('schema missing vs bootstrap:', [...b].filter((x) => !a.has(x)).length, [...b].filter((x) => !a.has(x)).slice(0, 5), 'extra:', [...a].filter((x) => !b.has(x)).slice(0, 5));
