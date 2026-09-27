import { Hono } from 'hono';
import { inboxEnabled, inboxStatus, resetExhausted } from '../services/webhook-inbox.js';
import type { Env } from '../index.js';

/**
 * [Craval kzn] Webhook 受信箱の管理 API（/api/* ＝ Bearer 必須）。WEBHOOK_INBOX=1 以外では 404。
 * - GET  /api/webhook-inbox/status : 件数（未処理・打ち切り・未転送・転送打ち切り）
 * - POST /api/webhook-inbox/retry  : 打ち切り行（5回失敗）を再試行対象に戻す。次の Cron で再処理される
 */
export const webhookInboxAdmin = new Hono<Env>();

webhookInboxAdmin.get('/api/webhook-inbox/status', async (c) => {
  if (!inboxEnabled(c.env)) return c.json({ success: false, error: 'Not Found' }, 404);
  return c.json({ success: true, data: await inboxStatus(c.env.DB) });
});

webhookInboxAdmin.post('/api/webhook-inbox/retry', async (c) => {
  if (!inboxEnabled(c.env)) return c.json({ success: false, error: 'Not Found' }, 404);
  const staff = c.get('staff');
  if (staff?.role !== 'owner') return c.json({ success: false, error: 'Forbidden' }, 403);
  return c.json({ success: true, data: await resetExhausted(c.env.DB, Date.now()) });
});
