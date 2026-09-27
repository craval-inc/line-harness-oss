/**
 * [Craval kzn] LINE_SEND_DISABLED のテスト。
 * フラグ ON: LineClient のメッセージ送信系（reply/push/multicast/broadcast と派生 push*）は
 *           fetch を一切呼ばずに例外。GET（プロフィール）は通る。
 * フラグ OFF（既定）: 従来どおり送信される。
 * Worker 入口（index.ts の fetch/scheduled）が env からフラグを反映することも確認する。
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LineClient, setLineSendDisabled, isLineSendDisabled, LineSendDisabledError } from '@line-crm/line-sdk';

function stubFetch() {
  const fn = vi.fn(async () => new Response(JSON.stringify({ displayName: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  setLineSendDisabled(false);
  vi.unstubAllGlobals();
});

describe('LINE_SEND_DISABLED', () => {
  test('ON: 送信系は fetch を呼ばずに LineSendDisabledError', async () => {
    const fetchFn = stubFetch();
    setLineSendDisabled(true);
    const client = new LineClient('token');
    const msg = [{ type: 'text', text: 'hi' }] as never;
    await expect(client.pushMessage('U1', msg)).rejects.toBeInstanceOf(LineSendDisabledError);
    await expect(client.replyMessage('rt', msg)).rejects.toBeInstanceOf(LineSendDisabledError);
    await expect(client.multicast(['U1'], msg)).rejects.toBeInstanceOf(LineSendDisabledError);
    await expect(client.broadcast(msg)).rejects.toBeInstanceOf(LineSendDisabledError);
    await expect(client.pushTextMessage('U1', 'hi')).rejects.toBeInstanceOf(LineSendDisabledError);
    await expect(client.request('POST', '/v2/bot/message/narrowcast', {})).rejects.toBeInstanceOf(LineSendDisabledError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('ON: GET（プロフィール取得）は許可', async () => {
    const fetchFn = stubFetch();
    setLineSendDisabled(true);
    await expect(new LineClient('token').getProfile('U1')).resolves.toMatchObject({ displayName: 'x' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('OFF（既定）: 従来どおり送信される', async () => {
    const fetchFn = stubFetch();
    expect(isLineSendDisabled()).toBe(false);
    await new LineClient('token').pushMessage('U1', [{ type: 'text', text: 'hi' }] as never);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('Worker 入口: env.LINE_SEND_DISABLED="1" でフラグ ON、未設定で OFF に戻る', async () => {
    const worker = (await import('../index.js')).default;
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
    await worker.fetch(new Request('https://kzn.example/api/health'), { LINE_SEND_DISABLED: '1', DB: {} } as never, ctx);
    expect(isLineSendDisabled()).toBe(true);
    await worker.fetch(new Request('https://kzn.example/api/health'), { DB: {} } as never, ctx);
    expect(isLineSendDisabled()).toBe(false);
  });
});
