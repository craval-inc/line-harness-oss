/**
 * [Craval kzn] きずな通知 cron の独立監視（K004）のテスト。
 * DB は node:sqlite 上の D1 互換アダプタ（bootstrap + K001〜K004）、heartbeat API と Google Chat は fetch スタブ。
 */
import { describe, expect, test } from 'vitest';
import { createKznTestDb } from '../test-utils/sqlite-d1.js';
import { runKizunaWatchdog, watchdogEnabled, STALE_AFTER_MS, REALERT_AFTER_MS } from './kizuna-watchdog.js';

const T0 = 1_800_000_000_000;
const ENV = { KIZUNA_HEARTBEAT_URL: 'https://k.example/api/ops/heartbeat', KIZUNA_HEARTBEAT_TOKEN: 'tok', WATCHDOG_CHAT_WEBHOOK_URL: 'https://chat.example/hook' };

function stub(opts: { lastOkAt?: number | null; hbStatus?: number; hbThrows?: boolean; chatOk?: boolean }) {
  const chats: string[] = [];
  let hbCalls = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url === ENV.KIZUNA_HEARTBEAT_URL) {
      hbCalls++;
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      if (opts.hbThrows) throw new Error('network');
      const body = { last_ok_at: opts.lastOkAt == null ? null : new Date(opts.lastOkAt).toISOString() };
      return new Response(JSON.stringify(body), { status: opts.hbStatus ?? 200 });
    }
    if (url === ENV.WATCHDOG_CHAT_WEBHOOK_URL) {
      chats.push(JSON.parse(String(init?.body)).text);
      return new Response('{}', { status: opts.chatOk === false ? 500 : 200 });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  return { fetchFn, chats, hbCalls: () => hbCalls };
}

describe('kizuna watchdog', () => {
  test('env が揃わなければ何もしない（heartbeat も読まない）', async () => {
    const db = createKznTestDb();
    const s = stub({ lastOkAt: T0 });
    expect(watchdogEnabled({ KIZUNA_HEARTBEAT_URL: 'x' })).toBe(false);
    expect(await runKizunaWatchdog({ db: db as unknown as D1Database, env: { KIZUNA_HEARTBEAT_URL: 'x', KIZUNA_HEARTBEAT_TOKEN: 't' }, nowMs: T0, fetchFn: s.fetchFn })).toBeNull();
    expect(s.hbCalls()).toBe(0);
  });

  test('30分以内は健全・通知しない', async () => {
    const db = createKznTestDb();
    const s = stub({ lastOkAt: T0 - STALE_AFTER_MS + 60_000 });
    expect(await runKizunaWatchdog({ db: db as unknown as D1Database, env: ENV, nowMs: T0, fetchFn: s.fetchFn })).toBe('healthy');
    expect(s.chats).toHaveLength(0);
  });

  test('30分超の停止で1回通知・1時間以内は再通知しない・1時間後に再通知・復旧で1回', async () => {
    const db = createKznTestDb() as unknown as D1Database;
    const stale = stub({ lastOkAt: T0 - STALE_AFTER_MS - 60_000 });
    expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0, fetchFn: stale.fetchFn })).toBe('alerted');
    expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0 + 5 * 60_000, fetchFn: stale.fetchFn })).toBe('suppressed');
    expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0 + REALERT_AFTER_MS - 1, fetchFn: stale.fetchFn })).toBe('suppressed');
    expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0 + REALERT_AFTER_MS, fetchFn: stale.fetchFn })).toBe('alerted');
    expect(stale.chats).toHaveLength(2);
    expect(stale.chats[0]).toMatch(/止まっている可能性/);
    const ok = stub({ lastOkAt: T0 + REALERT_AFTER_MS + 60_000 });
    expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0 + REALERT_AFTER_MS + 120_000, fetchFn: ok.fetchFn })).toBe('recovered');
    expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0 + REALERT_AFTER_MS + 420_000, fetchFn: ok.fetchFn })).toBe('healthy');
    expect(ok.chats).toEqual([expect.stringMatching(/復旧しました/)]);
  });

  test('heartbeat が読めない（HTTP エラー・例外・記録なし）も停止として通知', async () => {
    for (const o of [{ hbStatus: 503, lastOkAt: T0 }, { hbThrows: true }, { lastOkAt: null }]) {
      const db = createKznTestDb() as unknown as D1Database;
      const s = stub(o);
      expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0, fetchFn: s.fetchFn })).toBe('alerted');
      expect(s.chats).toHaveLength(1);
    }
  });

  test('Chat への送信に失敗したら送信待ちのまま残し、次の tick で送り直す', async () => {
    const db = createKznTestDb() as unknown as D1Database;
    const bad = stub({ lastOkAt: T0 - STALE_AFTER_MS - 60_000, chatOk: false });
    expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0, fetchFn: bad.fetchFn })).toBe('chat_failed');
    const good = stub({ lastOkAt: T0 - STALE_AFTER_MS - 60_000 });
    expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0 + 5 * 60_000, fetchFn: good.fetchFn })).toBe('alerted');
    expect(good.chats).toHaveLength(1);
    expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0 + 10 * 60_000, fetchFn: good.fetchFn })).toBe('suppressed');
    expect(good.chats).toHaveLength(1);
  });

  test('送信権を取った直後に落ちても（送信前）、2分後の tick が送る', async () => {
    const db = createKznTestDb() as unknown as D1Database;
    // 停止通知の送信権だけ取られて送られていない状態
    await db.prepare("INSERT INTO craval_watchdog (name, alerting, last_alert_at, notify_pending, notify_claimed_at) VALUES ('kizuna-notify-cron', 1, ?, 'alert', ?)").bind(T0, T0).run();
    const s = stub({ lastOkAt: T0 - STALE_AFTER_MS - 60_000 });
    expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0 + 60_000, fetchFn: s.fetchFn })).toBe('suppressed');
    expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0 + 3 * 60_000, fetchFn: s.fetchFn })).toBe('alerted');
    expect(s.chats).toEqual([expect.stringMatching(/止まっている可能性/)]);
    // 復旧側も同じ
    await db.prepare("UPDATE craval_watchdog SET alerting=0, notify_pending='recovery', notify_claimed_at=? WHERE name='kizuna-notify-cron'").bind(T0 + 4 * 60_000).run();
    const ok = stub({ lastOkAt: T0 + 5 * 60_000 });
    expect(await runKizunaWatchdog({ db, env: ENV, nowMs: T0 + 7 * 60_000, fetchFn: ok.fetchFn })).toBe('recovered');
    expect(ok.chats).toEqual([expect.stringMatching(/復旧しました/)]);
  });

  test('並行 tick でも停止通知は1通・復旧通知も1通', async () => {
    const db = createKznTestDb() as unknown as D1Database;
    const stale = stub({ lastOkAt: T0 - STALE_AFTER_MS - 60_000 });
    const rs = await Promise.all([1, 2, 3].map(() => runKizunaWatchdog({ db, env: ENV, nowMs: T0, fetchFn: stale.fetchFn })));
    expect(rs.filter((r) => r === 'alerted')).toHaveLength(1);
    expect(stale.chats).toHaveLength(1);
    const ok = stub({ lastOkAt: T0 });
    const rr = await Promise.all([1, 2].map(() => runKizunaWatchdog({ db, env: ENV, nowMs: T0 + 60_000, fetchFn: ok.fetchFn })));
    expect(rr.filter((r) => r === 'recovered')).toHaveLength(1);
    expect(ok.chats).toHaveLength(1);
  });
});
