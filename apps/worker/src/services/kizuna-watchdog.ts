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

interface State { alerting: number; last_alert_at: number | null; notify_pending: string | null; notify_claimed_at: number | null }
export const RESEND_AFTER_MS = 2 * 60_000;

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

function messageFor(kind: string, detail: string): string {
  return kind === 'recovery'
    ? `【きずな】通知 cron が復旧しました（${detail}）。`
    : `【きずな】通知 cron が止まっている可能性があります（${detail}）。\n` +
      `新着通知・返信期限の通知・日次ヘルスメールが届きません。Cloudflare の kizuna-notify-cron と anami-pat.jp を確認してください。`;
}

/**
 * 送信待ちの通知を送る。送れたら notify_pending を消す。送れなければ残す（次の tick で送り直す）。
 * 取り直しは notify_claimed_at の条件付き UPDATE＝並行 tick でも1つだけが送る。
 */
async function sendPending(db: D1Database, env: WatchdogEnv, kind: string, claimedAt: number, detail: string, fetchFn: typeof fetch): Promise<boolean> {
  const ok = await postChat(env.WATCHDOG_CHAT_WEBHOOK_URL!, messageFor(kind, detail), fetchFn);
  if (ok) {
    await db.prepare('UPDATE craval_watchdog SET notify_pending=NULL, notify_claimed_at=NULL WHERE name=? AND notify_pending=? AND notify_claimed_at=?')
      .bind(WATCHDOG_NAME, kind, claimedAt).run();
  }
  return ok;
}

export async function runKizunaWatchdog(opts: {
  db: D1Database; env: WatchdogEnv; nowMs: number; fetchFn?: typeof fetch;
}): Promise<WatchdogResult | null> {
  const { db, env, nowMs } = opts;
  if (!watchdogEnabled(env)) return null;
  const fetchFn = opts.fetchFn ?? fetch;
  const { healthy, detail } = await checkHeartbeat(env.KIZUNA_HEARTBEAT_URL!, env.KIZUNA_HEARTBEAT_TOKEN!, nowMs, fetchFn);
  await db.prepare('INSERT INTO craval_watchdog (name, alerting) VALUES (?, 0) ON CONFLICT DO NOTHING').bind(WATCHDOG_NAME).run();
  await db.prepare('UPDATE craval_watchdog SET last_checked_at=?, last_detail=? WHERE name=?').bind(nowMs, detail, WATCHDOG_NAME).run();
  const state = await db.prepare('SELECT alerting, last_alert_at, notify_pending, notify_claimed_at FROM craval_watchdog WHERE name=?').bind(WATCHDOG_NAME).first<State>();

  // 前回取った通知が送れていない（送信前に落ちた・Chat が失敗した）→ 2分以上経っていれば取り直して送る。
  if (state?.notify_pending) {
    const prevClaim = Number(state.notify_claimed_at ?? 0);
    if (nowMs - prevClaim < RESEND_AFTER_MS) return 'suppressed';
    const re = await db.prepare('UPDATE craval_watchdog SET notify_claimed_at=? WHERE name=? AND notify_pending=? AND notify_claimed_at IS ?')
      .bind(nowMs, WATCHDOG_NAME, state.notify_pending, state.notify_claimed_at).run();
    if ((re.meta?.changes ?? 0) !== 1) return 'suppressed';
    const ok = await sendPending(db, env, state.notify_pending, nowMs, detail, fetchFn);
    if (!ok) return 'chat_failed';
    return state.notify_pending === 'recovery' ? 'recovered' : 'alerted';
  }

  if (healthy) {
    if (Number(state?.alerting ?? 0) !== 1) return 'healthy';
    // 復旧通知の送信権を条件付き UPDATE で1つだけ取る（並行 tick でも1回）。
    const claim = await db.prepare(
      "UPDATE craval_watchdog SET alerting=0, notify_pending='recovery', notify_claimed_at=? WHERE name=? AND alerting=1 AND notify_pending IS NULL",
    ).bind(nowMs, WATCHDOG_NAME).run();
    if ((claim.meta?.changes ?? 0) !== 1) return 'healthy';
    return (await sendPending(db, env, 'recovery', nowMs, detail, fetchFn)) ? 'recovered' : 'chat_failed';
  }
  // 停止通知の送信権を条件付き UPDATE で1つだけ取る（未通知、または前回から1時間以上）。
  const claim = await db.prepare(
    "UPDATE craval_watchdog SET alerting=1, last_alert_at=?, notify_pending='alert', notify_claimed_at=? " +
      'WHERE name=? AND notify_pending IS NULL AND (alerting=0 OR last_alert_at IS NULL OR last_alert_at <= ?)',
  ).bind(nowMs, nowMs, WATCHDOG_NAME, nowMs - REALERT_AFTER_MS).run();
  if ((claim.meta?.changes ?? 0) !== 1) return 'suppressed';
  return (await sendPending(db, env, 'alert', nowMs, detail, fetchFn)) ? 'alerted' : 'chat_failed';
}
