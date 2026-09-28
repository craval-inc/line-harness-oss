import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from './index.js';

// [Craval] WEBHOOK_MAINTENANCE=1 の間は /webhook 以外の全リクエストを 503 で止め、D1 にも外部にも触れない
// （D1 migration の失敗時に bookmark restore しても、成功済みの書き込みが消えない）。
function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    API_KEY: 'test-key',
    WORKER_URL: 'https://api.example.com',
    DB: { prepare: vi.fn(() => { throw new Error('maintenance reached database'); }) },
    ...overrides,
  } as Env['Bindings'];
}

afterEach(() => vi.unstubAllGlobals());

describe('WEBHOOK_MAINTENANCE=1 blocks every non-webhook route', () => {
  it.each([
    ['GET', '/api/friends'],
    ['POST', '/api/broadcasts'],
    ['POST', '/api/auth/login'],
    ['GET', '/api/liff/profile'],
    ['POST', '/api/forms/abc/submit'],
    ['GET', '/r/abc'],
    ['GET', '/'],
    ['OPTIONS', '/api/broadcasts'],
  ])('%s %s → 503 without touching D1 or network', async (method, path) => {
    const fetchSpy = vi.fn(() => { throw new Error('unexpected outbound request'); });
    vi.stubGlobal('fetch', fetchSpy);
    const bindings = env({ WEBHOOK_MAINTENANCE: '1' } as Partial<Env['Bindings']>);
    const res = await worker.fetch(new Request(`https://api.example.com${path}`, {
      method,
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    }), bindings);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'maintenance' });
    expect(bindings.DB.prepare).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not block when the flag is unset (upstream behavior)', async () => {
    const res = await worker.fetch(new Request('https://api.example.com/api/friends'), env());
    expect(res.status).not.toBe(503);
  });
});
