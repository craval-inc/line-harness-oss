import { describe, expect, test } from 'vitest';
import { buildMirrorPayload } from './webhook-inbox.js';

// 計画 E4: ミラーに既読トークン（markAsReadToken）を載せる。取消済み・メッセージ以外は載せない。
const T0 = 1_790_000_000_000;
function msgEvent(extra: Record<string, unknown> = {}) {
  return {
    type: 'message',
    webhookEventId: 'EV1',
    timestamp: T0,
    source: { type: 'user', userId: 'U1' },
    message: { id: 'M1', type: 'text', text: 'hi', ...extra },
  } as never;
}

describe('ミラーの既読トークン', () => {
  test('message イベントのトークンを載せる', () => {
    const p = buildMirrorPayload(msgEvent({ markAsReadToken: 'tok-123' }), { sentAt: T0 });
    expect(p.markAsReadToken).toBe('tok-123');
  });
  test('取消済みには載せない', () => {
    const p = buildMirrorPayload(msgEvent({ markAsReadToken: 'tok-123' }), { sentAt: T0, unsent: true });
    expect(p.markAsReadToken).toBeUndefined();
  });
  test('無い・空・長すぎ・文字列以外は載せない', () => {
    expect(buildMirrorPayload(msgEvent(), { sentAt: T0 }).markAsReadToken).toBeUndefined();
    expect(buildMirrorPayload(msgEvent({ markAsReadToken: '' }), { sentAt: T0 }).markAsReadToken).toBeUndefined();
    expect(buildMirrorPayload(msgEvent({ markAsReadToken: 'x'.repeat(513) }), { sentAt: T0 }).markAsReadToken).toBeUndefined();
    expect(buildMirrorPayload(msgEvent({ markAsReadToken: 42 }), { sentAt: T0 }).markAsReadToken).toBeUndefined();
  });
  test('follow 等メッセージ以外には載せない', () => {
    const follow = { type: 'follow', webhookEventId: 'EV2', timestamp: T0, source: { type: 'user', userId: 'U1' } } as never;
    expect(buildMirrorPayload(follow, { sentAt: T0 }).markAsReadToken).toBeUndefined();
  });
});
