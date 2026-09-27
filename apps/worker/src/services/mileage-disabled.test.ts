/**
 * [Craval kzn] EVENT_BUS_DISABLED=1 でのマイレージ停止（CODEX v0.24 レビュー Med #4）。
 * mileage_rules.is_active に依存しない経路（タグ報酬・過去タグ一括投入・台帳直書き）も含め、
 * 投入側（enqueueMileageEvent / enqueueHistoricTagMileage）と実行側（processPendingMileageEvents /
 * enqueueFollowingMileageMilestones / postMileageEntry）の両方が止まることを実 SQLite で確認する。
 */
import { afterEach, describe, expect, test } from 'vitest';
import {
  addTagToFriend,
  enqueueHistoricTagMileage,
  processPendingMileageEvents,
  enqueueFollowingMileageMilestones,
  postMileageEntry,
  isMileageDisabled,
  setMileageDisabled,
  MileageDisabledError,
} from '@line-crm/db';
import { createKznTestDb, type SqliteD1 } from '../test-utils/sqlite-d1.js';
import { applyCravalRuntimeFlags } from '../craval-runtime-flags.js';

afterEach(() => {
  applyCravalRuntimeFlags({});
});

function seed(): SqliteD1 {
  const db = createKznTestDb();
  db.raw.exec(`
    INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at, current_follow_started_at, first_followed_at)
      VALUES ('f1', 'U1', '客A', 1, '2026-01-01T00:00:00.000+09:00', '2026-01-01T00:00:00.000+09:00',
              '2026-01-01T00:00:00.000+09:00', '2026-01-01T00:00:00.000+09:00');
    INSERT INTO tags (id, name, mileage_reward) VALUES ('t-reward', '報酬タグ', 50);
  `);
  return db;
}

const count = (db: SqliteD1, sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;

describe('EVENT_BUS_DISABLED → マイレージ停止', () => {
  test('入口のフラグ反映: EVENT_BUS_DISABLED=1 で ON、未設定で OFF', () => {
    applyCravalRuntimeFlags({ EVENT_BUS_DISABLED: '1' });
    expect(isMileageDisabled()).toBe(true);
    applyCravalRuntimeFlags({});
    expect(isMileageDisabled()).toBe(false);
  });

  test('対照: 停止していなければ報酬タグの付与でキューに1件入る（本家どおり）', async () => {
    const db = seed();
    await addTagToFriend(db.asD1(), 'f1', 't-reward');
    expect(count(db, 'SELECT COUNT(*) AS n FROM mileage_event_queue')).toBe(1);
  });

  test('投入側: 報酬タグの付与（rule に依存しない経路）でもキュー・イベントに入らない／過去タグ一括投入は 0', async () => {
    const db = seed();
    setMileageDisabled(true);
    await addTagToFriend(db.asD1(), 'f1', 't-reward'); // タグ自体は付く（マイル投入の失敗はログのみ）
    expect(count(db, 'SELECT COUNT(*) AS n FROM friend_tags')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM mileage_event_queue')).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM engagement_events WHERE event_type = 'tag_added'")).toBe(0);
    expect(await enqueueHistoricTagMileage(db.asD1(), 't-reward')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM mileage_event_queue')).toBe(0);
  });

  test('実行側: 停止前に溜まったキューは処理されず台帳に何も入らない／継続フォロー生成も 0', async () => {
    const db = seed();
    await addTagToFriend(db.asD1(), 'f1', 't-reward'); // 停止前に1件溜まる
    setMileageDisabled(true);
    expect(await processPendingMileageEvents(db.asD1(), { limit: 100 })).toEqual({ claimed: 0, processed: 0, failed: 0, granted: 0 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM mileage_ledger')).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM mileage_event_queue WHERE status = 'pending'")).toBe(1);
    expect(await enqueueFollowingMileageMilestones(db.asD1(), { now: '2027-01-01T00:00:00.000+09:00' })).toEqual({ eventsCreated: 0, queued: 0 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM engagement_events')).toBe(1); // tag_added の1件だけ
  });

  test('台帳直書き（手動付与・紹介報酬など）も拒否', async () => {
    const db = seed();
    setMileageDisabled(true);
    await expect(postMileageEntry(db.asD1(), {
      beneficiaryFriendId: 'f1', entryType: 'grant', amount: 10, reason: 'test', source: 'admin', idempotencyKey: 'k1',
    })).rejects.toBeInstanceOf(MileageDisabledError);
    expect(count(db, 'SELECT COUNT(*) AS n FROM mileage_ledger')).toBe(0);
  });

  test('対照: 停止解除後はキュー処理が本家どおり台帳に付与する', async () => {
    const db = seed();
    await addTagToFriend(db.asD1(), 'f1', 't-reward');
    const r = await processPendingMileageEvents(db.asD1(), { limit: 100 });
    expect(r.claimed).toBeGreaterThan(0);
  });
});
