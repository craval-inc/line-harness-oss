/**
 * [Craval kzn] 返信予約枠（LINE_REPLY_RESERVE）の送信ガードのテスト。
 * - LineClient の push / multicast は送信前にガードを通り、reply（無料）は通らない
 * - ガードが拒否したら LINE API（fetch）を呼ばない
 * - consumeReplyReserveBudget は同じスナップショットから送った分を差し引く＝1回の Cron で予約枠を割らない
 * - applyCravalRuntimeFlags: 予約0（未設定）ならガード無し＝本家と同一
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LineClient, setLineSendGuard } from '@line-crm/line-sdk';
import { consumeReplyReserveBudget, setLineReplyReserve, LinePlanQuotaError } from './quota-alert.js';
import { applyCravalRuntimeFlags } from '../craval-runtime-flags.js';

afterEach(() => {
  setLineSendGuard(null);
  setLineReplyReserve(0);
  vi.unstubAllGlobals();
});

function stubLine(quotaValue: number, used: number) {
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  const fn = vi.fn(async (url: string) => {
    if (String(url).endsWith('/v2/bot/message/quota')) return json({ type: 'limited', value: quotaValue });
    if (String(url).endsWith('/v2/bot/message/quota/consumption')) return json({ totalUsage: used });
    return json({});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const sends = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.filter((c) => /\/message\/(push|multicast|reply)$/.test(String(c[0]))).length;

describe('LineClient の送信ガード', () => {
  test('push / multicast はガードを通り宛先数を渡す・reply は通らない', async () => {
    stubLine(200, 0);
    const guard = vi.fn(async (_client: LineClient, _recipients: number, _path: string) => {});
    setLineSendGuard(guard);
    const client = new LineClient('t');
    const msg = [{ type: 'text', text: 'hi' }] as never;
    await client.pushMessage('U1', msg);
    await client.multicast(['U1', 'U2', 'U3'], msg);
    await client.replyMessage('rt', msg);
    expect(guard.mock.calls.map((c) => [c[1], c[2]])).toEqual([[1, '/v2/bot/message/push'], [3, '/v2/bot/message/multicast']]);
  });

  test('ガードが拒否したら LINE API を呼ばない', async () => {
    const fn = stubLine(200, 0);
    setLineSendGuard(async () => { throw new Error('reserve'); });
    await expect(new LineClient('t').pushMessage('U1', [{ type: 'text', text: 'x' }] as never)).rejects.toThrow('reserve');
    expect(sends(fn)).toBe(0);
  });
});

describe('consumeReplyReserveBudget', () => {
  test('残り52・予約50: 2通まで通り、3通目で LinePlanQuotaError（同じ tick で差し引く）', async () => {
    const fn = stubLine(200, 148);
    setLineReplyReserve(50);
    const client = new LineClient('t-consume');
    await consumeReplyReserveBudget(client, 1);
    await consumeReplyReserveBudget(client, 1);
    await expect(consumeReplyReserveBudget(client, 1)).rejects.toBeInstanceOf(LinePlanQuotaError);
    // quota API は TTL キャッシュで1回だけ（2本）
    expect(fn.mock.calls.filter((c) => String(c[0]).includes('/quota')).length).toBe(2);
  });

  test('予約0（未設定）は何もしない（API も呼ばない）', async () => {
    const fn = stubLine(200, 200);
    await consumeReplyReserveBudget(new LineClient('t-zero'), 5);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('applyCravalRuntimeFlags と送信ガード', () => {
  test('LINE_REPLY_RESERVE=50 でガードが入り、予約を割る push を止める／未設定なら止めない', async () => {
    const fn = stubLine(200, 150); // 残り 50 = 予約ちょうど → 1通も配信させない
    applyCravalRuntimeFlags({ LINE_REPLY_RESERVE: '50' });
    await expect(new LineClient('t-flags').pushMessage('U1', [{ type: 'text', text: 'x' }] as never)).rejects.toBeInstanceOf(LinePlanQuotaError);
    expect(sends(fn)).toBe(0);
    applyCravalRuntimeFlags({});
    await new LineClient('t-flags').pushMessage('U1', [{ type: 'text', text: 'x' }] as never);
    expect(sends(fn)).toBe(1);
  });
});
