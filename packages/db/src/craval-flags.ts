/**
 * [Craval kzn] マイレージ停止フラグ（EVENT_BUS_DISABLED=1 の環境で Worker 入口から ON にする）。
 * ON の間は投入（enqueueMileageEvent / enqueueHistoricTagMileage）・実行（processPendingMileageEvents /
 * enqueueFollowingMileageMilestones）・台帳書込（postMileageEntry）をすべて止める。
 * mileage_rules.is_active に依存しない経路（タグ報酬・紹介・手動付与）も含めて止めるため、DB 層で判定する。
 * 未設定（OFF）なら本家と同一挙動。
 */
let mileageDisabled = false;

export function setMileageDisabled(disabled: boolean): void {
  mileageDisabled = disabled;
}

export function isMileageDisabled(): boolean {
  return mileageDisabled;
}

export class MileageDisabledError extends Error {
  constructor(what: string) {
    super(`mileage disabled (EVENT_BUS_DISABLED=1): ${what}`);
    this.name = 'MileageDisabledError';
  }
}
