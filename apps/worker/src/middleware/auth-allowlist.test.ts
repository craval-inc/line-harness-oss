/**
 * [Craval kzn] PUBLIC_PATHS_ALLOW（認証不要パスの許可リスト）のテスト。
 * 設定時: 許可リスト内だけ無認証で通し、それ以外の非 /api は 404、/api/* は公開例外を無視して Bearer 必須。
 * 未設定時: 従来どおり（公開例外は無認証で通る）。
 */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', () => ({
  getStaffByApiKey: vi.fn().mockResolvedValue(null),
}));

import { authMiddleware, parsePublicPathsAllow } from './auth.js';
import type { Env } from '../index.js';

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.all('*', (c) => c.json({ reached: true, path: new URL(c.req.url).pathname }));
  return a;
}

const KEY = 'k'.repeat(64);
const kzn = { DB: {}, API_KEY: KEY, PUBLIC_PATHS_ALLOW: '/webhook' } as Record<string, unknown>;
const legacy = { DB: {}, API_KEY: KEY } as Record<string, unknown>;

async function status(path: string, env: Record<string, unknown>, auth?: string, method = 'GET') {
  const res = await app().request(path, { method, headers: auth ? { Authorization: `Bearer ${auth}` } : {} }, env);
  return res.status;
}

describe('PUBLIC_PATHS_ALLOW="/webhook"', () => {
  test('/webhook は無認証で到達（署名検証はルート側）', async () => {
    expect(await status('/webhook', kzn, undefined, 'POST')).toBe(200);
  });

  test.each(['/setup', '/auth/callback', '/auth/line', '/images/incoming-x-1.jpg', '/t/abc', '/r/abc', '/pool/main', '/admin/version', '/admin/update/apply', '/docs', '/openapi.json', '/index.html', '/'])(
    '非 /api の %s は 404',
    async (path) => {
      expect(await status(path, kzn)).toBe(404);
    },
  );

  test.each(['/api/liff/profile', '/api/forms/abc/submit', '/api/forms/abc', '/api/integrations/stripe/webhook', '/api/qr', '/api/affiliates/click', '/api/rich-menu-images/x', '/api/meet-callback', '/api/webhooks/incoming/x/receive'])(
    '公開例外だった %s も Bearer 無しなら 401',
    async (path) => {
      expect(await status(path, kzn)).toBe(401);
    },
  );

  test('/api/* は正しい Bearer で到達、誤りは 401', async () => {
    expect(await status('/api/friends', kzn, KEY)).toBe(200);
    expect(await status('/api/friends', kzn, 'wrong')).toBe(401);
    expect(await status('/api/friends', kzn)).toBe(401);
  });

  test('許可リストは完全一致（/webhook/x は通さない）', async () => {
    expect(await status('/webhook/x', kzn)).toBe(404);
  });
});

describe('未設定（sbo/fzk）→ 従来挙動', () => {
  test('公開例外は無認証で通る', async () => {
    expect(await status('/api/liff/profile', legacy)).toBe(200);
    expect(await status('/setup', legacy)).toBe(200);
    expect(await status('/images/x.jpg', legacy)).toBe(200);
    expect(await status('/index.html', legacy)).toBe(200);
  });

  test('/api/* は Bearer 必須のまま', async () => {
    expect(await status('/api/friends', legacy)).toBe(401);
    expect(await status('/api/friends', legacy, KEY)).toBe(200);
  });
});

describe('parsePublicPathsAllow', () => {
  test('未設定・空・空白だけは null（機能オフ）', () => {
    expect(parsePublicPathsAllow(undefined)).toBeNull();
    expect(parsePublicPathsAllow('')).toBeNull();
    expect(parsePublicPathsAllow(' , ')).toBeNull();
  });
  test('カンマ区切りをトリム', () => {
    expect(parsePublicPathsAllow('/webhook, /health')).toEqual(['/webhook', '/health']);
  });
});
