/**
 * [Craval kzn] kzn 本番 D1（kzn-bootstrap + K001）を本家 v0.24 に上げる適用手順の再現テスト。
 * migrations-kzn/APPLY-v0.24.md の順（046〜047 → kzn-pre-048 → 048〜072 → kzn-post-v024）を node:sqlite で通し、
 * - 062 が過去の受信から付けた移行由来マイルが後処理で 0 になる（後処理前は available が残る＝指摘の再現）
 * - 067 の自動応答「マイル」とマイル付与ルールが無効
 * - 既存データ（友だち・受信ログ・受信箱）が残り、重複チャットが統合される
 * - 最終スキーマが「本家 bootstrap.sql + K001」と一致（デプロイ前ゲートと同じ判定）
 */
import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteD1 } from './test-utils/sqlite-d1.js';
// @ts-expect-error — plain ESM script without types
import { evaluateGate } from '../../../scripts/kzn-d1-gate.mjs';

// vitest は apps/worker を cwd として実行する
const DB_PKG = join('..', '..', 'packages', 'db');
const MIG = join(DB_PKG, 'migrations');
const KZN = join(DB_PKG, 'migrations-kzn');
const sql = (p: string) => readFileSync(p, 'utf8');

function kznProductionReplica(): SqliteD1 {
  const db = new SqliteD1();
  db.raw.exec(sql(join(DB_PKG, 'kzn-bootstrap.sql')));
  db.raw.exec(sql(join(KZN, 'K001_webhook_inbox.sql')));
  db.raw.exec(`
    INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
      VALUES ('f1','U1','客A',1,'2026-09-27T10:00:00.000+09:00','2026-09-27T10:00:00.000+09:00'),
             ('f2','U2','客B',0,'2026-09-27T10:00:00.000+09:00','2026-09-27T12:00:00.000+09:00');
    INSERT INTO messages_log (id, friend_id, direction, message_type, content, source, line_message_id, webhook_event_id, created_at)
      VALUES ('l1','f1','incoming','text','相談です','user','m1','ev1','2026-09-27T10:01:00.000+09:00'),
             ('l2','f1','incoming','text','追記です','user','m2','ev2','2026-09-27T10:02:00.000+09:00');
    INSERT INTO webhook_inbox (webhook_event_id, event_type, line_message_id, body_json, processed, mirrored, received_at, updated_at)
      VALUES ('ev1','message','m1','{}',1,1,1,1);
    INSERT INTO chats (id, friend_id, status, last_message_at, last_incoming_event_at, created_at, updated_at)
      VALUES ('c1','f1','resolved','2026-09-27T10:00:00.000+09:00',1000,'2026-09-27T10:00:00.000+09:00','2026-09-27T10:05:00.000+09:00'),
             ('c2','f1','unread','2026-09-27T11:00:00.000+09:00',2000,'2026-09-27T11:00:00.000+09:00','2026-09-27T11:00:00.000+09:00');
  `);
  return db;
}

function applyUpstream(db: SqliteD1, opts: { post: boolean }) {
  const files = readdirSync(MIG).filter((f) => f.endsWith('.sql') && f.slice(0, 3) >= '046').sort();
  for (const f of files) {
    if (f.startsWith('048_')) db.raw.exec(sql(join(KZN, 'kzn-pre-048.sql')));
    db.raw.exec(sql(join(MIG, f)));
  }
  if (opts.post) db.raw.exec(sql(join(KZN, 'kzn-post-v024.sql')));
  return files;
}

function availableMiles(db: SqliteD1): number {
  const row = db.raw.prepare("SELECT COALESCE(SUM(amount), 0) AS v FROM mileage_ledger WHERE status = 'available'").get() as { v: number };
  return Number(row.v);
}

function remoteLikeSnapshot(db: SqliteD1) {
  // デプロイ前ゲートが本番 D1 から取るのと同じ形（テーブル・列一覧＋ゲート用の値）
  const columns = db.raw
    .prepare("SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%'")
    .all() as Array<{ t: string; c: string }>;
  let checks: Record<string, number> = {};
  try {
    checks = db.raw
    .prepare(
      `SELECT (SELECT COUNT(*) FROM auto_replies WHERE id = 'builtin-mileage-wallet-keyword' AND is_active = 1) AS mileage_auto_reply_active,
              (SELECT COUNT(*) FROM mileage_rules WHERE is_active = 1) AS mileage_rules_active,
              (SELECT COALESCE(SUM(amount), 0) FROM mileage_ledger WHERE status = 'available') AS mileage_available`,
    )
    .get() as Record<string, number>;
  } catch {
    // テーブルが無い（migration 未適用）＝本番ゲートでは問い合わせ失敗で fail-closed。ここでは「未取得」として評価させる
  }
  return { columns, checks };
}

function expectedSchema() {
  const ref = new SqliteD1();
  ref.raw.exec(sql(join(DB_PKG, 'bootstrap.sql')));
  ref.raw.exec(sql(join(KZN, 'K001_webhook_inbox.sql')));
  return remoteLikeSnapshot(ref).columns;
}

describe('kzn 本番 D1 の v0.24 適用手順', () => {
  test('後処理前は 062 の移行由来マイルが available で残る（指摘の再現）', () => {
    const db = kznProductionReplica();
    applyUpstream(db, { post: false });
    expect(availableMiles(db)).toBeGreaterThan(0);
  });

  test('手順どおり（後処理込み）: マイル0・自動応答/ルール無効・データ保持・チャット統合', () => {
    const db = kznProductionReplica();
    applyUpstream(db, { post: true });
    expect(availableMiles(db)).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM mileage_ledger WHERE id LIKE 'history-mile-%'").get()).toEqual({ n: 0 });
    expect(db.raw.prepare("SELECT is_active FROM auto_replies WHERE id = 'builtin-mileage-wallet-keyword'").get()).toEqual({ is_active: 0 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM mileage_rules WHERE is_active = 1').get()).toEqual({ n: 0 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM friends').get()).toEqual({ n: 2 });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM messages_log WHERE direction = 'incoming'").get()).toEqual({ n: 2 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM webhook_inbox').get()).toEqual({ n: 1 });
    expect(db.raw.prepare('SELECT friend_id, status, last_incoming_event_at FROM chats').all()).toEqual([
      { friend_id: 'f1', status: 'unread', last_incoming_event_at: 2000 },
    ]);
    // 後処理は冪等
    db.raw.exec(sql(join(KZN, 'kzn-post-v024.sql')));
    expect(availableMiles(db)).toBe(0);
  });

  test('デプロイ前ゲート: 手順どおりなら OK、後処理漏れ・migration 漏れは NG', () => {
    const expected = expectedSchema();

    const ok = kznProductionReplica();
    applyUpstream(ok, { post: true });
    expect(evaluateGate(remoteLikeSnapshot(ok), expected)).toEqual({ ok: true, errors: [] });

    const noPost = kznProductionReplica();
    applyUpstream(noPost, { post: false });
    const r1 = evaluateGate(remoteLikeSnapshot(noPost), expected);
    expect(r1.ok).toBe(false);
    expect(r1.errors.join('\n')).toMatch(/mileage_auto_reply_active|mileage_rules_active|mileage_available/);

    const partial = kznProductionReplica(); // 046〜072 を当てていない
    const r2 = evaluateGate(remoteLikeSnapshot(partial), expected);
    expect(r2.ok).toBe(false);
    expect(r2.errors.join('\n')).toMatch(/missing table/);
  });
});
