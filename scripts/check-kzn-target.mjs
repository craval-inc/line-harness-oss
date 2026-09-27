#!/usr/bin/env node
/**
 * [Craval kzn] line-harness-kzn デプロイ前の取り違え防止チェック。
 *
 * 検査内容（1つでも違えば exit 1）:
 *   - apps/worker/wrangler.kzn.toml の account_id が bkobu（01547b03881149dd0db10da0da6928c8）
 *   - name / D1 database_name が "-kzn" で終わる
 *   - database_id がプレースホルダのまま（TBD_）でない
 *   - Phase 1 の安全設定（PUBLIC_PATHS_ALLOW="/webhook" / INCOMING_IMAGE_STORE="0" /
 *     WEBHOOK_INBOX="1" / LINE_SEND_DISABLED="1"）が入っている
 *   - R2 バインディング（[[r2_buckets]]）が無い
 *   - packages/line-sdk/dist に送信禁止ガード（setLineSendDisabled）が含まれている
 *     （wrangler は import 条件で dist を読むため、未ビルドだとガード無しでデプロイされる）
 *   - CLOUDFLARE_ACCOUNT_ID が設定されていれば bkobu と一致
 *
 * 使い方: node scripts/check-kzn-target.mjs   （リポジトリ直下 or apps/worker から）
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BKOBU_ACCOUNT_ID = '01547b03881149dd0db10da0da6928c8';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tomlPath = join(repoRoot, 'apps', 'worker', 'wrangler.kzn.toml');
const sdkDist = join(repoRoot, 'packages', 'line-sdk', 'dist', 'client.js');

const errors = [];

function stripComments(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, ''))
    .join('\n');
}

/** トップレベル（最初のテーブル見出しより前）の key = "value" を読む。 */
function topLevelValue(text, key) {
  const head = text.split(/^\s*\[/m)[0];
  const m = head.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

/** 指定テーブル（[vars] 等）の key = "value" を読む。 */
function tableValue(text, table, key) {
  const re = new RegExp(`^\\s*\\[${table.replace(/[[\]]/g, '\\$&')}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|$(?![\\s\\S]))`, 'm');
  const body = text.match(re)?.[1] ?? '';
  const m = body.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

if (!existsSync(tomlPath)) {
  errors.push(`not found: ${tomlPath}`);
} else {
  const toml = stripComments(readFileSync(tomlPath, 'utf8'));

  const accountId = topLevelValue(toml, 'account_id');
  if (accountId !== BKOBU_ACCOUNT_ID) errors.push(`account_id must be bkobu (${BKOBU_ACCOUNT_ID}), got ${accountId}`);

  const name = topLevelValue(toml, 'name');
  if (!name || !name.endsWith('-kzn')) errors.push(`name must end with -kzn, got ${name}`);

  const d1Block = toml.match(/\[\[d1_databases\]\]([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m)?.[1] ?? '';
  const dbName = d1Block.match(/database_name\s*=\s*"([^"]*)"/)?.[1] ?? null;
  const dbId = d1Block.match(/database_id\s*=\s*"([^"]*)"/)?.[1] ?? null;
  if (!dbName || !dbName.endsWith('-kzn')) errors.push(`D1 database_name must end with -kzn, got ${dbName}`);
  if (!dbId || dbId.startsWith('TBD_')) errors.push(`D1 database_id is a placeholder (${dbId}) — replace with the real id`);

  const expectedVars = {
    PUBLIC_PATHS_ALLOW: '/webhook',
    INCOMING_IMAGE_STORE: '0',
    WEBHOOK_INBOX: '1',
    LINE_SEND_DISABLED: '1',
  };
  for (const [key, want] of Object.entries(expectedVars)) {
    const got = tableValue(toml, 'vars', key);
    if (got !== want) errors.push(`[vars] ${key} must be "${want}", got ${got === null ? '(missing)' : `"${got}"`}`);
  }
  const d1IdVar = tableValue(toml, 'vars', 'D1_DATABASE_ID');
  if (d1IdVar !== dbId) errors.push(`[vars] D1_DATABASE_ID (${d1IdVar}) must equal database_id (${dbId})`);

  if (/^\s*\[\[r2_buckets\]\]/m.test(toml)) errors.push('R2 binding must not exist in kzn (incoming images are not stored)');
}

if (!existsSync(sdkDist)) {
  errors.push('packages/line-sdk/dist/client.js not found — run `pnpm --filter @line-crm/line-sdk build`');
} else if (!readFileSync(sdkDist, 'utf8').includes('setLineSendDisabled')) {
  errors.push('packages/line-sdk/dist is stale (no send-disable guard) — run `pnpm --filter @line-crm/line-sdk build`');
}

const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
if (envAccount && envAccount !== BKOBU_ACCOUNT_ID) {
  errors.push(`CLOUDFLARE_ACCOUNT_ID is ${envAccount} (not bkobu) — run cf-bkobu first`);
}

if (errors.length > 0) {
  for (const e of errors) console.error(`[check-kzn-target] NG: ${e}`);
  process.exit(1);
}
console.log('[check-kzn-target] OK — wrangler.kzn.toml targets bkobu / line-harness-kzn with Phase 1 safety vars');
