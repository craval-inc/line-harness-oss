/**
 * [Craval] sbo / fzk 本番 D1 を v0.24 に上げた後、Worker をデプロイする前の検証ゲート（kzn は kzn-d1-gate.mjs）。
 * 1つでも満たさなければ exit 1（デプロイに進まない）。問い合わせ自体の失敗も exit 1（fail-closed）。
 *
 *   - 期待スキーマ（packages/db/bootstrap.sql＝本家 v0.24）の全テーブル・全列が本番に存在する
 *   - --keep-mileage を付けない場合（既定）: 067 の自動応答「マイル」が無効・有効なマイル付与ルール 0・available 残高 0
 *
 * 使い方（apps/worker で・cf-craval 後）: node ../../scripts/craval-d1-gate.mjs <sbo|fzk> [--keep-mileage]
 * シバン行は置かない（vitest から import するため）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TENANTS = {
  sbo: { db: 'line-harness-sbo', config: 'wrangler.sbo.toml' },
  fzk: { db: 'line-harness-fzk', config: 'wrangler.fzk.toml' },
};

export const COLUMNS_SQL =
  "SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%'";
export const CHECKS_SQL =
  "SELECT (SELECT COUNT(*) FROM auto_replies WHERE id = 'builtin-mileage-wallet-keyword' AND is_active = 1) AS mileage_auto_reply_active, " +
  '(SELECT COUNT(*) FROM mileage_rules WHERE is_active = 1) AS mileage_rules_active, ' +
  "(SELECT COALESCE(SUM(amount), 0) FROM mileage_ledger WHERE status = 'available') AS mileage_available";

export function evaluateGate(snapshot, expectedColumns, { keepMileage = false } = {}) {
  const errors = [];
  const have = new Map();
  for (const { t, c } of snapshot.columns ?? []) {
    if (!have.has(t)) have.set(t, new Set());
    have.get(t).add(c);
  }
  const missingTables = new Set();
  for (const { t, c } of expectedColumns) {
    if (!have.has(t)) { missingTables.add(t); continue; }
    if (!have.get(t).has(c)) errors.push(`missing column: ${t}.${c}`);
  }
  for (const t of [...missingTables].sort()) errors.push(`missing table: ${t}`);
  const checks = snapshot.checks ?? {};
  for (const key of ['mileage_auto_reply_active', 'mileage_rules_active', 'mileage_available']) {
    const v = Number(checks[key]);
    if (!Number.isFinite(v)) errors.push(`${key}: not returned`);
    else if (!keepMileage && v !== 0) errors.push(`${key}: expected 0 (mileage off), got ${v}`);
  }
  return { ok: errors.length === 0, errors };
}

function expectedColumnsFromRepo() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'packages', 'db', 'bootstrap.sql'), 'utf8'));
  return db.prepare(COLUMNS_SQL).all();
}

export function wranglerCommand(tenant, sql) {
  const t = TENANTS[tenant];
  const workerDir = join(repoRoot, 'apps', 'worker');
  const req = createRequire(join(workerDir, 'package.json'));
  const pkgPath = req.resolve('wrangler/package.json');
  const bin = JSON.parse(readFileSync(pkgPath, 'utf8')).bin.wrangler;
  return {
    file: process.execPath,
    args: [join(dirname(pkgPath), bin), 'd1', 'execute', t.db, '--remote', '-c', t.config, '--json', '--command', sql],
    cwd: workerDir,
  };
}

function remoteQuery(tenant, sql) {
  const { file, args, cwd } = wranglerCommand(tenant, sql);
  const out = execFileSync(file, args, { cwd, encoding: 'utf8' });
  const parsed = JSON.parse(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || first.success === false || !Array.isArray(first.results)) throw new Error(`unexpected D1 response: ${out.slice(0, 300)}`);
  return first.results;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const tenant = process.argv[2];
  const keepMileage = process.argv.includes('--keep-mileage');
  if (!TENANTS[tenant]) {
    console.error('usage: node scripts/craval-d1-gate.mjs <sbo|fzk> [--keep-mileage]');
    process.exit(1);
  }
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== '48cf2f856a84ba4baca7b9e4484b50c1') {
    console.error(`[craval-d1-gate:${tenant}] NG: CLOUDFLARE_ACCOUNT_ID is not cf-craval — run cf-craval`);
    process.exit(1);
  }
  try {
    const snapshot = { columns: remoteQuery(tenant, COLUMNS_SQL), checks: remoteQuery(tenant, CHECKS_SQL)[0] };
    const result = evaluateGate(snapshot, expectedColumnsFromRepo(), { keepMileage });
    if (!result.ok) {
      for (const e of result.errors) console.error(`[craval-d1-gate:${tenant}] NG: ${e}`);
      process.exit(1);
    }
    console.log(`[craval-d1-gate:${tenant}] OK — schema matches bootstrap (v0.24)${keepMileage ? '' : ', mileage auto-reply/rules disabled, available=0'}`);
  } catch (err) {
    console.error(`[craval-d1-gate:${tenant}] NG: gate query failed (fail-closed):`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
