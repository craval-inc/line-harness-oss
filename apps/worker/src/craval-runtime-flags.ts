import { setLineSendDisabled } from '@line-crm/line-sdk';
// ルート '@line-crm/db' ではなくフラグのモジュールを直接読む（多くの既存テストが '@line-crm/db' を丸ごとモックするため）。
// 同じファイルなので db 内部（mileage.ts / tags.ts）の判定と状態を共有する。
import { setMileageDisabled } from '@line-crm/db/src/craval-flags.js';
import { setEventBusDisabled } from './services/event-bus.js';
import { setLineMediaEnabled, lineMediaConfigured } from './services/line-media.js';

/**
 * [Craval kzn] env からプロセス内フラグを反映する（fetch / scheduled 入口で毎回呼ぶ）。
 * 未設定なら全て false＝本家と同一挙動。
 */
export function applyCravalRuntimeFlags(
  env:
    | { LINE_SEND_DISABLED?: string; EVENT_BUS_DISABLED?: string; WEBHOOK_INBOX?: string; LINE_MEDIA_STORE?: string; LINE_MEDIA?: unknown }
    | undefined,
): void {
  setLineSendDisabled(env?.LINE_SEND_DISABLED === '1');
  setEventBusDisabled(env?.EVENT_BUS_DISABLED === '1');
  // マイレージは EVENT_BUS_DISABLED に連動（投入・実行・台帳書込を DB 層で停止）
  setMileageDisabled(env?.EVENT_BUS_DISABLED === '1');
  // 受信メディアの非公開保全（WEBHOOK_INBOX=1・LINE_MEDIA_STORE=1・R2 バインディング LINE_MEDIA が揃った時だけ）
  setLineMediaEnabled(!!env && lineMediaConfigured(env));
}
