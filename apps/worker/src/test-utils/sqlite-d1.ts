/**
 * [Craval kzn] テスト用: node:sqlite（Node 22+ 組み込み）の上に D1 互換の最小アダプタを載せる。
 * prepare().bind().run()/first()/all() と batch()（トランザクション）だけを実装。
 * モックと違い、INSERT OR IGNORE・部分一意インデックス・条件付き UPDATE・json_set を実 SQLite で検証できる。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// vite 5 は node:sqlite を builtin と認識せず解決に失敗するため、実行時 require で読む。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncT = InstanceType<typeof DatabaseSync>;

type Param = string | number | bigint | null | Uint8Array;

function normalize(params: unknown[]): Param[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p as Param;
  });
}

class Stmt {
  constructor(
    private readonly adapter: SqliteD1,
    readonly sql: string,
    readonly params: Param[] = [],
  ) {}

  bind(...params: unknown[]): Stmt {
    return new Stmt(this.adapter, this.sql, normalize(params));
  }

  async run() {
    return this.adapter.execRun(this);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    this.adapter.maybeFail(this.sql);
    const row = this.adapter.raw.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T = Record<string, unknown>>() {
    this.adapter.maybeFail(this.sql);
    const results = this.adapter.raw.prepare(this.sql).all(...this.params) as T[];
    return { results, success: true, meta: {} };
  }
}

export class SqliteD1 {
  readonly raw: DatabaseSyncT;
  /** テスト用の故障注入: SQL がこの正規表現に一致したら例外を投げる。 */
  failOn: RegExp | null = null;

  constructor() {
    this.raw = new DatabaseSync(':memory:');
  }

  maybeFail(sql: string): void {
    if (this.failOn && this.failOn.test(sql)) throw new Error(`injected failure: ${sql.slice(0, 40)}`);
  }

  execRun(stmt: Stmt) {
    this.maybeFail(stmt.sql);
    const r = this.raw.prepare(stmt.sql).run(...stmt.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }

  prepare(sql: string): Stmt {
    return new Stmt(this, sql);
  }

  async batch(stmts: Stmt[]) {
    this.raw.exec('BEGIN');
    try {
      const out = [];
      for (const s of stmts) {
        if (/^\s*select/i.test(s.sql)) out.push(await s.all());
        else out.push(this.execRun(s));
      }
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql: string) {
    this.raw.exec(sql);
    return { count: 0, duration: 0 };
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const dbPkg = join(here, '..', '..', '..', '..', 'packages', 'db');

/** 本家 bootstrap.sql（全 migration 反映済み）+ kzn 専用 migration（migrations-kzn/K001）を適用した DB を作る。 */
export function createKznTestDb(): SqliteD1 {
  const db = new SqliteD1();
  db.raw.exec(readFileSync(join(dbPkg, 'bootstrap.sql'), 'utf8'));
  db.raw.exec(readFileSync(join(dbPkg, 'migrations-kzn', 'K001_webhook_inbox.sql'), 'utf8'));
  return db;
}
