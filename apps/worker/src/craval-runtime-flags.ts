import { setLineSendDisabled } from '@line-crm/line-sdk';
import { setEventBusDisabled } from './services/event-bus.js';

/**
 * [Craval kzn] env からプロセス内フラグを反映する（fetch / scheduled 入口で毎回呼ぶ）。
 * 未設定なら両方 false＝本家と同一挙動。
 */
export function applyCravalRuntimeFlags(env: { LINE_SEND_DISABLED?: string; EVENT_BUS_DISABLED?: string } | undefined): void {
  setLineSendDisabled(env?.LINE_SEND_DISABLED === '1');
  setEventBusDisabled(env?.EVENT_BUS_DISABLED === '1');
}
