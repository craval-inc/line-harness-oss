/**
 * [Craval kzn] きずな通知 cron の独立監視（kizuna-shonin docs/unified-inbox-plan.md Phase D3）。
 *
 * きずな側（Pages / notify-cron / 通知メール）が丸ごと止まっても気づけるよう、別 Worker（このハーネス）の
 * 5 分 Cron から きずな の heartbeat API を読み、最終成功が 30 分より古い・読めない時に Google Chat の
 * Incoming Webhook へ直接通知する。同じ停止は 1 時間に 1 回まで・復旧したら 1 回だけ知らせる。
 * env が揃っていなければ何もしない（sbo / fzk は未設定＝本家挙動）。
 */

export const WATCHDOG_NAME = 'kizuna-notify-cron';
export const STALE_AFTER_MS = 30 * 60_000;
export const REALERT_AFTER_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface WatchdogEnv {
  KIZUNA_HEARTBEAT_URL?: string;
  KIZUNA_HEARTBEAT_TOKEN?: string;
  WATCHDOG_CHAT_WEBHOOK_URL?: string;
}

export function watchdogEnabled(env: WatchdogEnv): boolean {
  return !!(env.KIZUNA_HEARTBEAT_URL && env.KIZUNA_HEARTBEAT_TOKEN && env.WATCHDOG_CHAT_WEBHOOK_URL);
}

export type WatchdogResult = 'healthy' | 'alerted' | 'suppressed' | 'recovered' | 'chat_failed';

interface State { alerting: number; last_alert_at: number | null }

/** heartbeat を読み、健全かどうかと理由を返す（例外は投げない）。 */
export async function checkHeartbeat(
  url: string, token: string, nowMs: number, fetchFn: typeof fetch,
): Promise<{ healthy: boolean; detail: string }> {
  try {
    const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { healthy: false, detail: `heartbeat HTTP ${res.status}` };
    const j = (await res.json()) as { last_ok_at?: string | null };
    const okAt = j.last_ok_at ? Date.parse(j.last_ok_at) : NaN;
    if (!Number.isFinite(okAt)) return { healthy: false, detail: '最終成功の記録がありません' };
    const ageMin = Math.floor((nowMs - okAt) / 60_000);
    if (nowMs - okAt > STALE_AFTER_MS) return { healthy: false, detail: `最終成功から ${ageMin} 分経過（${new Date(okAt).toISOString()}）` };
    return { healthy: true, detail: `最終成功から ${ageMin} 分` };
  } catch (e) {
    return { healthy: false, detail: `heartbeat 取得失敗（${e instanceof Error ? e.name : 'error'}）` };
  }
}

async function postChat(webhookUrl: string, text: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runKizunaWatchdog(opts: {
  db: D1Database; env: WatchdogEnv; nowMs: number; fetchFn?: typeof fetch;
}): Promise<WatchdogResult | null> {
  const { db, env, nowMs } = opts;
  if (!watchdogEnabled(env)) return null;
  const fetchFn = opts.fetchFn ?? fetch;
  const { healthy, detail } = await checkHeartbeat(env.KIZUNA_HEARTBEAT_URL!, env.KIZUNA_HEARTBEAT_TOKEN!, nowMs, fetchFn);
  const state = (await db.prepare('SELECT alerting, last_alert_at FROM craval_watchdog WHERE name=?').bind(WATCHDOG_NAME).first<State>())
    ?? { alerting: 0, last_alert_at: null };
  const touch = (alerting: number, lastAlertAt: number | null) =>
    db.prepare(
      'INSERT INTO craval_watchdog (name, alerting, last_alert_at, last_checked_at, last_detail) VALUES (?,?,?,?,?) ' +
        'ON CONFLICT(name) DO UPDATE SET alerting=excluded.alerting, last_alert_at=excluded.last_alert_at, last_checked_at=excluded.last_checked_at, last_detail=excluded.last_detail',
    ).bind(WATCHDOG_NAME, alerting, lastAlertAt, nowMs, detail).run();

  if (healthy) {
    if (Number(state.alerting) === 1) {
      const ok = await postChat(env.WATCHDOG_CHAT_WEBHOOK_URL!, `【きずな】通知 cron が復旧しました（${detail}）。`, fetchFn);
      if (!ok) { await touch(1, state.last_alert_at); return 'chat_failed'; }
      await touch(0, state.last_alert_at);
      return 'recovered';
    }
    await touch(0, state.last_alert_at);
    return 'healthy';
  }
  const last = state.last_alert_at == null ? null : Number(state.last_alert_at);
  if (Number(state.alerting) === 1 && last != null && nowMs - last < REALERT_AFTER_MS) {
    await touch(1, last);
    return 'suppressed';
  }
  const text =
    `【きずな】通知 cron が止まっている可能性があります（${detail}）。\n` +
    `新着通知・返信期限の通知・日次ヘルスメールが届きません。Cloudflare の kizuna-notify-cron と anami-pat.jp を確認してください。`;
  const ok = await postChat(env.WATCHDOG_CHAT_WEBHOOK_URL!, text, fetchFn);
  if (!ok) { await touch(Number(state.alerting), last); return 'chat_failed'; }
  await touch(1, nowMs);
  return 'alerted';
}
