/**
 * [Craval security] 本家 v0.24 に載せ直したハードニングの回帰テスト。
 * C-1 meet-callback 無効化 / C-2 は webhook.test.ts / C-5 送信 Webhook の SSRF 拒否 /
 * H-4 Stripe 未設定時 503 / M-2 定数時間比較 / M-5 PII ハッシュ。
 */
import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { isBlockedHost } from './routes/webhooks.js';
import { stripe } from './routes/stripe.js';
import { hashPIIPrefix, safeEqual } from './utils/pii-hash.js';

describe('[C-1] meet-callback は無効化（ルート未マウント）', () => {
  test('index.ts で meetCallback をマウントしていない', async () => {
    const { readFileSync } = await import('node:fs');
    // vitest は apps/worker を cwd として実行する
    const src = readFileSync('src/index.ts', 'utf8');
    expect(src).not.toMatch(/^\s*app\.route\('\/', meetCallback\)/m);
    expect(src).not.toMatch(/^\s*import \{ meetCallback \}/m);
  });
});

describe('[C-5] isBlockedHost', () => {
  test.each(['localhost', 'a.localhost', 'x.local', 'x.internal', 'metadata.google.internal', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '::', 'fd00::1', 'fe80::1'])(
    '%s は拒否',
    (h) => expect(isBlockedHost(h)).toBe(true),
  );
  test.each(['example.com', 'hooks.slack.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.0.1'])('%s は許可', (h) =>
    expect(isBlockedHost(h)).toBe(false),
  );
});

describe('[H-4] Stripe webhook', () => {
  test('STRIPE_WEBHOOK_SECRET 未設定なら 503（未検証で処理しない）', async () => {
    const app = new Hono();
    app.route('/', stripe);
    const res = await app.request(
      '/api/integrations/stripe/webhook',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'evt_x', type: 'x', data: { object: {} } }) },
      { DB: {} } as never,
    );
    expect(res.status).toBe(503);
  });
});

describe('[M-2] safeEqual / [M-5] hashPIIPrefix', () => {
  test('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
  test('hashPIIPrefix は元の値を含まない12桁', async () => {
    const h = await hashPIIPrefix('U1234567890abcdef');
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(await hashPIIPrefix(null)).toBe('null');
  });
});
