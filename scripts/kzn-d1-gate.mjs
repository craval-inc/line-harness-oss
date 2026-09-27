/**
 * [Craval kzn] kzn 本番 D1 を v0.24 に上げた後、Worker をデプロイする前の検証ゲート。
 * 1つでも満たさなければ exit 1（デプロイに進まない）。問い合わせ自体の失敗も exit 1（fail-closed）。
 *
 *   - 期待スキーマ（packages/db/bootstrap.sql + migrations-kzn/K001 + K002）の全テーブル・全列が本番に存在する
 *   - 067 の自動応答「マイル」（builtin-mileage-wallet-keyword）が無効
 *   - 有効なマイル付与ルールが 0 件
 *   - available のマイル残高合計が 0（062/063 の移行由来付与が削除済み）
 *
 * シバン行は置かない（vitest から import するため。autocrlf で CRLF になると vite がシバンを誤解釈する）
 * 使い方（apps/worker で・cf-bkobu 後）:
 *   node ../../scripts/kzn-d1-gate.mjs            # wrangler d1 execute --remote で本番を検査
 * テストからは evaluateGate(snapshot, expectedColumns) を直接使う。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const COLUMNS_SQL =
  "SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%'";
export const CHECKS_SQL =
  "SELECT (SELECT COUNT(*) FROM auto_replies WHERE id = 'builtin-mileage-wallet-keyword' AND is_active = 1) AS mileage_auto_reply_active, " +
  '(SELECT COUNT(*) FROM mileage_rules WHERE is_active = 1) AS mileage_rules_active, ' +
  "(SELECT COALESCE(SUM(amount), 0) FROM mileage_ledger WHERE status = 'available') AS mileage_available";

/**
 * @param {{columns: Array<{t: string, c: string}>, checks: Record<string, number>}} snapshot 本番 D1 の状態
 * @param {Array<{t: string, c: string}>} expectedColumns 期待スキーマの (table, column) 一覧
 */
export function evaluateGate(snapshot, expectedColumns) {
  const errors = [];
  const have = new Map();
  for (const { t, c } of snapshot.columns ?? []) {
    if (!have.has(t)) have.set(t, new Set());
    have.get(t).add(c);
  }
  const missingTables = new Set();
  for (const { t, c } of expectedColumns) {
    if (!have.has(t)) {
      missingTables.add(t);
      continue;
    }
    if (!have.get(t).has(c)) errors.push(`missing column: ${t}.${c}`);
  }
  for (const t of [...missingTables].sort()) errors.push(`missing table: ${t}`);
  const checks = snapshot.checks ?? {};
  for (const key of ['mileage_auto_reply_active', 'mileage_rules_active', 'mileage_available']) {
    const v = Number(checks[key]);
    if (!Number.isFinite(v)) errors.push(`${key}: not returned`);
    else if (v !== 0) errors.push(`${key}: expected 0, got ${v}`);
  }
  return { ok: errors.length === 0, errors };
}

function expectedColumnsFromRepo() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(repoRoot, 'packages', 'db', 'bootstrap.sql'), 'utf8'));
  db.exec(readFileSync(join(repoRoot, 'packages', 'db', 'migrations-kzn', 'K001_webhook_inbox.sql'), 'utf8'));
  db.exec(readFileSync(join(repoRoot, 'packages', 'db', 'migrations-kzn', 'K002_follow_state_pending.sql'), 'utf8'));
  return db.prepare(COLUMNS_SQL).all();
}

/**
 * wrangler を node で直接起動する（シェルを通さない）。Windows で npx(.cmd) を shell:true で呼ぶと
 * cmd.exe が引数を引用せず連結し、SQL が複数引数に割れるため。引数配列はそのまま子プロセスに渡る。
 */
export function wranglerCommand(sql) {
  const workerDir = join(repoRoot, 'apps', 'worker');
  const req = createRequire(join(workerDir, 'package.json'));
  const pkgPath = req.resolve('wrangler/package.json');
  const bin = JSON.parse(readFileSync(pkgPath, 'utf8')).bin.wrangler;
  return {
    file: process.execPath,
    args: [join(dirname(pkgPath), bin), 'd1', 'execute', 'line-harness-kzn', '--remote', '-c', 'wrangler.kzn.toml', '--json', '--command', sql],
    cwd: workerDir,
  };
}

function remoteQuery(sql) {
  const { file, args, cwd } = wranglerCommand(sql);
  const out = execFileSync(file, args, { cwd, encoding: 'utf8' });
  const parsed = JSON.parse(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || first.success === false || !Array.isArray(first.results)) throw new Error(`unexpected D1 response: ${out.slice(0, 300)}`);
  return first.results;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const snapshot = { columns: remoteQuery(COLUMNS_SQL), checks: remoteQuery(CHECKS_SQL)[0] };
    const result = evaluateGate(snapshot, expectedColumnsFromRepo());
    if (!result.ok) {
      for (const e of result.errors) console.error(`[kzn-d1-gate] NG: ${e}`);
      process.exit(1);
    }
    console.log('[kzn-d1-gate] OK — schema matches bootstrap+K001, mileage auto-reply/rules disabled, available=0');
  } catch (err) {
    console.error('[kzn-d1-gate] NG: gate query failed (fail-closed):', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
