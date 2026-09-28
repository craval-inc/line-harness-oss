#!/usr/bin/env node
/**
 * [Craval] sbo / fzk デプロイ前の取り違え防止チェック（kzn は scripts/check-kzn-target.mjs）。
 *
 * 使い方: node scripts/check-craval-target.mjs <sbo|fzk>   （リポジトリ直下 or apps/worker から）
 *
 * 検査内容（1つでも違えば exit 1）:
 *   - apps/worker/wrangler.<tenant>.toml が存在し、account_id が cf-craval（48cf2f…）
 *   - name / D1 database_name / database_id / R2 IMAGES バケット / [vars] D1_DATABASE_ID・WORKER_NAME が
 *     そのテナントの本番値と完全一致（sbo と fzk、kzn の取り違えを防ぐ）
 *   - kzn 専用の env が入っていない（sbo/fzk は本家の受信・配信挙動のまま）
 *   - WEBHOOK_MAINTENANCE が [vars] に無い（移行中だけ --var で渡す）
 *   - packages/line-sdk/dist がビルド済み
 *   - CLOUDFLARE_ACCOUNT_ID が設定されていれば cf-craval と一致
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRAVAL_ACCOUNT_ID = '48cf2f856a84ba4baca7b9e4484b50c1';
const PROFILES = {
  sbo: { name: 'line-harness-sbo', dbName: 'line-harness-sbo', dbId: 'c8a9c07f-ae70-4d3a-8f22-86fa0828238e', images: 'line-harness-sbo-images' },
  fzk: { name: 'line-harness-fzk', dbName: 'line-harness-fzk', dbId: 'd85dd5d0-7bc3-43ea-8f8a-a4eda6d82709', images: 'line-harness-fzk-images' },
};
const KZN_ONLY_VARS = [
  'WEBHOOK_INBOX', 'LINE_SEND_DISABLED', 'EVENT_BUS_DISABLED', 'MIRROR_URL', 'MIRROR_SECRET', 'PUBLIC_PATHS_ALLOW',
  'INCOMING_IMAGE_STORE', 'LINE_MEDIA_STORE', 'LINE_REPLY_RESERVE', 'KIZUNA_HEARTBEAT_URL', 'KIZUNA_HEARTBEAT_TOKEN',
  'WATCHDOG_CHAT_WEBHOOK_URL',
];

const tenant = process.argv[2];
const profile = PROFILES[tenant];
if (!profile) {
  console.error(`usage: node scripts/check-craval-target.mjs <${Object.keys(PROFILES).join('|')}>`);
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tomlPath = join(repoRoot, 'apps', 'worker', `wrangler.${tenant}.toml`);
const sdkDist = join(repoRoot, 'packages', 'line-sdk', 'dist', 'client.js');
const errors = [];

function stripComments(text) {
  return text.split('\n').map((l) => l.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '')).join('\n');
}
function topLevelValue(text, key) {
  const head = text.split(/^\s*\[/m)[0];
  return head.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] ?? null;
}
/** [[name]] / [name] ブロックを行単位で切り出す（次のテーブル見出しまで）。 */
function blocks(text, header) {
  const out = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === header) { cur = []; out.push(cur); continue; }
    if (/^\s*\[/.test(line)) { cur = null; continue; }
    if (cur) cur.push(line);
  }
  return out.map((ls) => ls.join('\n'));
}
function val(block, key) {
  return block.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1] ?? null;
}

if (!existsSync(tomlPath)) {
  errors.push(`not found: ${tomlPath}`);
} else {
  const toml = stripComments(readFileSync(tomlPath, 'utf8'));
  if (topLevelValue(toml, 'account_id') !== CRAVAL_ACCOUNT_ID) errors.push(`account_id must be cf-craval (${CRAVAL_ACCOUNT_ID})`);
  if (topLevelValue(toml, 'name') !== profile.name) errors.push(`name must be ${profile.name}, got ${topLevelValue(toml, 'name')}`);

  const d1 = blocks(toml, '[[d1_databases]]');
  if (d1.length !== 1) errors.push(`exactly one [[d1_databases]] expected, got ${d1.length}`);
  else {
    if (val(d1[0], 'binding') !== 'DB') errors.push('D1 binding must be DB');
    if (val(d1[0], 'database_name') !== profile.dbName) errors.push(`D1 database_name must be ${profile.dbName}, got ${val(d1[0], 'database_name')}`);
    if (val(d1[0], 'database_id') !== profile.dbId) errors.push(`D1 database_id must be ${profile.dbId}, got ${val(d1[0], 'database_id')}`);
  }
  const r2 = blocks(toml, '[[r2_buckets]]');
  if (r2.length !== 1 || val(r2[0], 'binding') !== 'IMAGES' || val(r2[0], 'bucket_name') !== profile.images) {
    errors.push(`R2 must be exactly IMAGES → ${profile.images}`);
  }
  const vars = blocks(toml, '[vars]')[0] ?? '';
  if (val(vars, 'D1_DATABASE_ID') !== profile.dbId) errors.push(`[vars] D1_DATABASE_ID must be ${profile.dbId}`);
  if (val(vars, 'WORKER_NAME') !== profile.name) errors.push(`[vars] WORKER_NAME must be ${profile.name}`);
  for (const k of KZN_ONLY_VARS) if (val(vars, k) !== null) errors.push(`[vars] ${k} is kzn-only and must not be set for ${tenant}`);
  if (val(vars, 'WEBHOOK_MAINTENANCE') !== null) errors.push('WEBHOOK_MAINTENANCE must not be in [vars] — pass it only via `--var WEBHOOK_MAINTENANCE:1` during migration');
}

if (!existsSync(sdkDist)) errors.push(`packages/line-sdk/dist not built (${sdkDist}) — run pnpm --filter @line-crm/line-sdk build`);
const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
if (envAccount && envAccount !== CRAVAL_ACCOUNT_ID) errors.push(`CLOUDFLARE_ACCOUNT_ID is ${envAccount} (must be cf-craval ${CRAVAL_ACCOUNT_ID}) — run cf-craval`);

if (errors.length) {
  for (const e of errors) console.error(`[check-craval-target:${tenant}] NG: ${e}`);
  process.exit(1);
}
console.log(`[check-craval-target:${tenant}] OK — wrangler.${tenant}.toml targets cf-craval / ${profile.name} / D1 ${profile.dbId}`);
