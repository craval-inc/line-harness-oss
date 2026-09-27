import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import { createStickerMessageContent } from '@line-crm/shared';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  getScenarios,
  enrollFriendInScenario,
  upsertChatOnMessage,
  getLineAccounts,
  jstNow,
  getEntryRouteByRefCode,
  getMessageTemplateById,
} from '@line-crm/db';
import type { EntryRoute, Friend } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { matchAndReply } from '../services/auto-reply.js';
import { buildMessage } from '../services/step-delivery.js';
import { pushImmediateFirstStep } from '../services/immediate-first-step.js';
import type { Env } from '../index.js';
import { hashPIIPrefix } from '../utils/pii-hash.js';
import {
  inboxEnabled,
  mirrorEnabled,
  mirrorReady,
  warnMirrorMisconfigOnce,
  saveInboxEvents,
  processInboxEvent,
  mirrorInboxRow,
  webhookEventIdOf,
  isUnsent,
  claimFollowTransition,
  syncFriendFollowFromState,
  upsertFriendAndSyncFollow,
  recordPendingUnfollowIfNoFriend,
  touchChatOnIncomingEvent,
  insertIncomingLog,
  registerFriendFromMessage,
  UNSENT_PLACEHOLDER,
} from '../services/webhook-inbox.js';
import { awardActivityMileage } from '../services/activity-mileage.js';
import { replyViaHarnessProxy } from '../services/line-proxy-send.js';
import type { HarnessProxyDispatch } from '../services/line-proxy-send.js';
import { dispatchLineProxyLocally } from '../services/local-line-proxy.js';
import { ensureSchedulerArmed } from '../durable-objects/tenant-scheduler.js';

const webhook = new Hono<Env>();

// LINE webhook bodies are small (events array). Cap defends against unauthenticated
// large-payload DoS before signature verification (#104). 1 MiB leaves room for
// bursty batched deliveries (~100 events × ~5 KB) while still well below the
// 128 MB Cloudflare Workers memory ceiling.
const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024; // 1 MiB

async function ensureFriendFromWebhookUser(
  db: D1Database,
  lineClient: LineClient,
  userId: string,
  lineAccountId: string | null,
  inbox = false,
): Promise<Friend | null> {
  let friend = await getFriendByLineUserId(db, userId);

  if (!friend) {
    let profile: Awaited<ReturnType<LineClient['getProfile']>> | null = null;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      // A signed webhook already proves this user interacted with the bot.
      // If profile lookup is temporarily unavailable, keep the event processable
      // by creating the friend with the LINE userId and filling profile later.
      console.error(`[webhook] Failed to get profile for unknown user userIdHash=${await hashPIIPrefix(userId)}`, err);
    }

    if (inbox) {
      // [Craval kzn] 受信箱モード: 1文で登録（既存行は書き換えない）。is_following は friend_follow_state が
      // あればその値（未登録時の unfollow を尊重）、無ければ 1。
      await registerFriendFromMessage(db, {
        lineUserId: userId,
        displayName: profile?.displayName ?? null,
        pictureUrl: profile?.pictureUrl ?? null,
        statusMessage: profile?.statusMessage ?? null,
      }, jstNow());
      const registered = await getFriendByLineUserId(db, userId);
      if (!registered) throw new Error('friend registration did not return a row');
      friend = registered;
    } else {
      friend = await upsertFriend(db, {
        lineUserId: userId,
        displayName: profile?.displayName ?? null,
        pictureUrl: profile?.pictureUrl ?? null,
        statusMessage: profile?.statusMessage ?? null,
      });
    }
    console.log(`[webhook] auto-registered existing friend userIdHash=${await hashPIIPrefix(userId)} friendId=${friend.id}`);
  }

  if (lineAccountId && friend.line_account_id !== lineAccountId) {
    const now = jstNow();
    if (inbox) {
      // [Craval kzn] 受信箱モードではアカウントだけ更新し is_following は書き換えない（状態と履歴は
      // friend_follow_state からの同期だけが決める。書き換えると同期時に解除回数が誤って増える）。
      await db
        .prepare('UPDATE friends SET line_account_id = ?, updated_at = ? WHERE id = ?')
        .bind(lineAccountId, now, friend.id)
        .run();
      await syncFriendFollowFromState(db, userId, now);
      friend = (await getFriendByLineUserId(db, userId)) ?? friend;
    } else {
      await db
        .prepare('UPDATE friends SET line_account_id = ?, is_following = 1, updated_at = ? WHERE id = ?')
        .bind(lineAccountId, now, friend.id)
        .run();
      friend = { ...friend, line_account_id: lineAccountId, is_following: 1, updated_at: now };
    }
  }

  return friend;
}

webhook.post('/webhook', async (c) => {
  // Pre-read size guard: reject before reading the body if Content-Length is oversized.
  const contentLengthHeader = c.req.header('Content-Length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_SIZE) {
      return c.json({ status: 'too_large' }, 413);
    }
  }

  const rawBody = await c.req.text();

  // Post-read size guard for the case where Content-Length was absent or untrustworthy.
  // Use UTF-8 byte count: `rawBody.length` counts UTF-16 code units, so multibyte
  // payloads (Japanese/emoji) would otherwise bypass the cap.
  const rawBodyByteLength = new TextEncoder().encode(rawBody).byteLength;
  if (rawBodyByteLength > MAX_WEBHOOK_BODY_SIZE) {
    return c.json({ status: 'too_large' }, 413);
  }

  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  // Cheap pre-reject for unsigned / malformed-signature requests. LINE signatures
  // are HMAC-SHA256 + base64 = 44 chars. This avoids D1 lookups and HMAC compute
  // for junk traffic on a public endpoint.
  const LINE_SIGNATURE_LENGTH = 44;
  if (signature.length !== LINE_SIGNATURE_LENGTH) {
    // [Craval security C-2] 不正シグネチャは 401。200 だと CF の status 集計で検知できず LINE の再送機構も無効になる。
    console.error('Missing or malformed LINE signature');
    return c.json({ status: 'invalid_signature' }, 401);
  }

  // Verify signature BEFORE JSON.parse so attacker-controlled bodies never reach the parser.
  // Fast path: try env default secret first so malformed/unauthenticated traffic
  //   fails fast without a D1 lookup. The main account is typically also registered
  //   in line_accounts; on env match we still look it up so matchedAccountId binds
  //   correctly for downstream account-scoped filters.
  // Slow path: iterate DB-registered accounts for genuinely multi-account installs.
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;
  let valid = false;

  const envSecret = c.env.LINE_CHANNEL_SECRET;
  if (envSecret) {
    valid = await verifySignature(envSecret, rawBody, signature);
    if (valid) {
      const accounts = await getLineAccounts(db);
      const main = accounts.find(
        (a) => a.is_active && a.channel_secret === envSecret,
      );
      if (main) {
        channelAccessToken = main.channel_access_token;
        matchedAccountId = main.id;
      }
    }
  }

  if (!valid) {
    const accounts = await getLineAccounts(db);
    for (const account of accounts) {
      if (!account.is_active) continue;
      if (envSecret && account.channel_secret === envSecret) continue; // already tried via fast path
      const isValid = await verifySignature(account.channel_secret, rawBody, signature);
      if (isValid) {
        channelAccessToken = account.channel_access_token;
        matchedAccountId = account.id;
        valid = true;
        break;
      }
    }
  }

  if (!valid) {
    // [Craval security C-2] HMAC 不一致も 401。
    console.error('Invalid LINE signature');
    return c.json({ status: 'invalid_signature' }, 401);
  }

  // [Craval kzn] WEBHOOK_MAINTENANCE=1（D1 migration 中）: 正しい署名の受信も D1 に一切書かずに 503 を返す。
  // 非2xx なので「Webhookの再送」ON の LINE が後で再送する（再送の回数・間隔は LINE 非公開＝メンテは短時間で）。
  // 未設定なら本家どおり。
  if (c.env.WEBHOOK_MAINTENANCE === '1') {
    console.warn('[webhook] maintenance mode: 503 (event will be redelivered by LINE)');
    return c.json({ status: 'maintenance' }, 503);
  }

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    // [Craval security C-2] 署名は正しいがパース不能＝不正ボディ。
    console.error('Failed to parse webhook body');
    return c.json({ status: 'invalid_body' }, 400);
  }

  const lineClient = new LineClient(channelAccessToken);
  const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
  // [Craval kzn] INCOMING_IMAGE_STORE=0 なら受信画像を R2 に保存しない（未設定なら本家どおり IMAGES）。
  const r2 = incomingImageBucket(c.env);
  // [Craval kzn] EVENT_BUS_DISABLED=1: fireEvent・auto_replies・マイレージ・クロスアカウント送信を止める。
  const eventBusDisabled = c.env.EVENT_BUS_DISABLED === '1';
  const proxyDispatch: HarnessProxyDispatch = (request) =>
    dispatchLineProxyLocally(request, c.env, c.executionCtx);

  // [Craval kzn] WEBHOOK_INBOX=1: 生イベントを同期保存してから 200。保存失敗は 500（LINE 再送対象）。
  if (inboxEnabled(c.env)) {
    warnMirrorMisconfigOnce(c.env);
    let saved: Awaited<ReturnType<typeof saveInboxEvents>>;
    try {
      saved = await saveInboxEvents(db, body.events ?? [], {
        lineAccountId: matchedAccountId,
        mirror: mirrorEnabled(c.env),
        now: Date.now(),
      });
    } catch (err) {
      console.error('[webhook-inbox] save failed:', err instanceof Error ? err.message : err);
      return c.json({ status: 'inbox_unavailable' }, 500);
    }

    const process = (event: WebhookEvent) =>
      handleEvent(db, lineClient, event, channelAccessToken, matchedAccountId, workerUrl, c.env.LIFF_URL, r2, proxyDispatch, {
        inbox: true,
        eventBusDisabled,
      });

    const inboxPromise = (async () => {
      for (const event of saved.fresh) {
        await processInboxEvent(db, event, matchedAccountId, (e) => process(e));
        if (mirrorReady(c.env)) {
          const row = await db
            .prepare('SELECT webhook_event_id, body_json, mirrored FROM webhook_inbox WHERE webhook_event_id = ?')
            .bind(webhookEventIdOf(event))
            .first<{ webhook_event_id: string; body_json: string; mirrored: number }>();
          if (row && row.mirrored === 0) {
            await mirrorInboxRow({ db, url: c.env.MIRROR_URL!, secret: c.env.MIRROR_SECRET! }, row);
          }
        }
      }
      for (const event of saved.untracked) {
        try {
          await process(event);
        } catch (err) {
          console.error('Error handling webhook event:', err);
        }
      }
    })();
    c.executionCtx.waitUntil(inboxPromise);
    c.executionCtx.waitUntil(ensureSchedulerArmed(c.env));
    return c.json({ status: 'ok' }, 200);
  }

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(
          db,
          lineClient,
          event,
          channelAccessToken,
          matchedAccountId,
          workerUrl,
          c.env.LIFF_URL,
          r2,
          proxyDispatch,
          { eventBusDisabled },
        );
      } catch (err) {
        console.error('Error handling webhook event:', err);
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  // 定期ジョブ用 DO の自己修復チェック。何らかの理由で alarm チェーンが
  // 切れていても、次に届いた webhook がここで直す。getAlarm() 1回で済む
  // 軽さなので毎リクエストで呼んでよい。応答を遅らせないよう waitUntil に
  // 逃がし、失敗しても webhook 応答（LINE 側の ~1s タイムアウト）には影響しない。
  c.executionCtx.waitUntil(ensureSchedulerArmed(c.env));

  return c.json({ status: 'ok' }, 200);
});

/** [Craval kzn] INCOMING_IMAGE_STORE=0 なら undefined（画像はラベル記録のみ）。未設定なら本家どおり IMAGES。 */
export function incomingImageBucket(env: { INCOMING_IMAGE_STORE?: string; IMAGES?: R2Bucket }): R2Bucket | undefined {
  if (env.INCOMING_IMAGE_STORE === '0') return undefined;
  return env.IMAGES;
}

export interface HandleEventOptions {
  /** [Craval kzn] WEBHOOK_INBOX 経由の処理。重複挿入防止・送信取消・follow 時刻条件・チャット冪等化を有効にする。 */
  inbox?: boolean;
  /** [Craval kzn] EVENT_BUS_DISABLED=1。fireEvent・auto_replies・マイレージ・クロスアカウント送信を行わない。 */
  eventBusDisabled?: boolean;
}

/** Cron / DO alarm の受信箱再処理から呼ぶための公開エントリ（handleEvent と同一）。 */
export async function handleWebhookEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null,
  workerUrl: string | undefined,
  liffUrl: string | undefined,
  r2: R2Bucket | undefined,
  options: HandleEventOptions,
  proxyDispatch?: HarnessProxyDispatch,
): Promise<void> {
  return handleEvent(db, lineClient, event, lineAccessToken, lineAccountId, workerUrl, liffUrl, r2, proxyDispatch, options);
}

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  liffUrl?: string,
  r2?: R2Bucket,
  proxyDispatch?: HarnessProxyDispatch,
  options: HandleEventOptions = {},
): Promise<void> {
  const inbox = options.inbox === true;
  const eventBusDisabled = options.eventBusDisabled === true;
  const eventTimestamp = (event as { timestamp?: number }).timestamp;
  const webhookEventId = (event as { webhookEventId?: string }).webhookEventId ?? null;

  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    // [Craval kzn] follow 状態をイベント時刻付きで原子的に記録。より新しい状態があれば何もしない
    // （友だち未登録時の unfollow も friend_follow_state に残っているので、古い follow はここで弾かれる）。
    const followGuard = inbox && typeof eventTimestamp === 'number';
    if (followGuard && !(await claimFollowTransition(db, userId, true, eventTimestamp))) {
      await syncFriendFollowFromState(db, userId, jstNow());
      console.log('[follow] skipped stale follow event (newer state already applied)');
      return;
    }

    // [Craval security M-5] userId(=PII)を hash prefix 化
    console.log(`[follow] userIdHash=${await hashPIIPrefix(userId)} lineAccountId=${lineAccountId}`);

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error(`Failed to get profile for userIdHash=${await hashPIIPrefix(userId)}`, err);
    }

    // [Craval security M-5] displayName は PII なので取得成否のみ
    console.log(`[follow] profile_fetched=${profile ? 'ok' : 'fail'}`);

    let friend: Friend;
    if (followGuard) {
      // [Craval kzn] 友だち登録/更新と is_following の最新状態への同期を1 batch で行う（途中失敗は両方ロールバック）。
      await upsertFriendAndSyncFollow(db, {
        lineUserId: userId,
        displayName: profile?.displayName ?? null,
        pictureUrl: profile?.pictureUrl ?? null,
        statusMessage: profile?.statusMessage ?? null,
      }, jstNow(), eventTimestamp);
      const upserted = await getFriendByLineUserId(db, userId);
      if (!upserted) throw new Error('friend upsert did not return a row');
      friend = upserted;
    } else {
      friend = await upsertFriend(db, {
        lineUserId: userId,
        displayName: profile?.displayName ?? null,
        pictureUrl: profile?.pictureUrl ?? null,
        statusMessage: profile?.statusMessage ?? null,
      });
    }

    console.log(`[follow] friend.id=${friend.id} friend.line_account_id=${(friend as any).line_account_id}`);

    // Set line_account_id for multi-account tracking (always update on follow)
    if (lineAccountId) {
      await db.prepare('UPDATE friends SET line_account_id = ?, updated_at = ? WHERE id = ?')
        .bind(lineAccountId, jstNow(), friend.id).run();
      console.log(`[follow] line_account_id set to ${lineAccountId} for friend ${friend.id}`);
    }

    // 新規・再フォローのどちらでも、最初の友だち登録マイルを同じキーで非同期投入する。
    // first_followed_at を使うため再フォローやWebhook再送では二重加算されない。
    const firstFollowedAt = friend.first_followed_at ?? friend.created_at;
    if (!eventBusDisabled) await awardActivityMileage(db, {
      eventType: 'friend_registered',
      source: 'line_relationship',
      sourceEventId: `${friend.id}:friend_registered:${firstFollowedAt}`,
      friendId: friend.id,
      subjectKey: friend.id,
      metadata: { lineAccountId },
      occurredAt: firstFollowedAt,
    });

    // Resolve referral link (entry_route) for this friend.
    // /auth/callback (OAuth path) writes friends.ref_code in parallel with
    // this follow webhook, so the field can briefly be NULL when LINE
    // delivers the event. Retry a few times (~1s total) before giving up,
    // otherwise override mode and intro pushes silently fall back to the
    // account default whenever the webhook wins the race.
    const { getFriendById } = await import('@line-crm/db');
    let friendRefCode = (friend as { ref_code?: string | null }).ref_code ?? null;
    if (!friendRefCode) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const refreshed = await getFriendById(db, friend.id);
        const refreshedRef = (refreshed as { ref_code?: string | null } | null)?.ref_code ?? null;
        if (refreshedRef) {
          friendRefCode = refreshedRef;
          break;
        }
      }
    }
    const referralRoute: EntryRoute | null = friendRefCode
      ? await getEntryRouteByRefCode(db, friendRefCode)
      : null;
    const runAccountScenarios =
      !referralRoute || referralRoute.run_account_friend_add_scenarios !== 0;

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    // Skip entirely when a referral link explicitly overrides (run_account_friend_add_scenarios=0).
    const scenarios = runAccountScenarios ? await getScenarios(db) : [];
    for (const scenario of scenarios) {
      // Only trigger scenarios belonging to this account (or unassigned for backward compat)
      const scenarioAccountMatch = !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;
      if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
        try {
          // INSERT OR IGNORE handles dedup via UNIQUE(friend_id, scenario_id)
          const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);
          if (!friendScenario) continue; // already enrolled

          // Immediate delivery: step1 が「now 以前」にスケジュールされる場合のみ
          // replyMessage で即時送信する (reply token は無料・push 枠を消費しない)。
          // - relative + delay_minutes=0 → 即時
          // - elapsed + offset_days=0 + offset_minutes=0 → 即時
          // - absolute_time で過去時刻 → computeNextDeliveryAt が now に clamp するので即時
          // reply 失敗時 (2つ目のシナリオで token 消費済み等) は claim が解放され
          // cron が push で配信する。
          // skipCooldown: 60秒以内の再フォロー (前の enrollment が completed 済み)
          // でも必ず welcome を返す — 旧 webhook 実装のセマンティクスを維持。
          const sent = await pushImmediateFirstStep(
            db,
            friend.id,
            scenario.id,
            { defaultAccessToken: lineAccessToken, workerUrl },
            {
              enrollment: friendScenario,
              reply: { client: lineClient, replyToken: event.replyToken },
              skipCooldown: true,
            },
          );
          if (sent) console.log(`Immediate delivery: sent scenario ${scenario.id} step 1 to userIdHash=${await hashPIIPrefix(userId)}`);
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // Referral link side-effects (intro push + dedicated scenario)
    if (referralRoute) {
      // Intro push from referral link
      if (referralRoute.intro_template_id) {
        try {
          const template = await getMessageTemplateById(db, referralRoute.intro_template_id);
          if (template) {
            const message = buildMessage(template.message_type, template.message_content);
            await lineClient.pushMessage(userId, [message]);
            console.log(`[follow] referral intro push sent route=${referralRoute.id}`);
          }
        } catch (err) {
          console.error('[follow] referral intro push failed', err);
        }
      }

      // Dedicated scenario enrollment from referral link. A delay-0 first
      // step is pushed immediately (same instant-welcome semantics as
      // friend_add / tag_added enrollments — previously this path always
      // waited for the next cron tick). pushMessage, not reply: the reply
      // token may already be consumed by an account friend_add scenario
      // above, and the intro push on this path uses pushMessage too.
      if (referralRoute.scenario_id) {
        try {
          const enrollment = await enrollFriendInScenario(db, friend.id, referralRoute.scenario_id);
          console.log(`[follow] referral scenario enrolled scenario=${referralRoute.scenario_id}`);
          if (enrollment) {
            await pushImmediateFirstStep(
              db,
              friend.id,
              referralRoute.scenario_id,
              { defaultAccessToken: lineAccessToken, workerUrl },
              { enrollment },
            );
          }
        } catch (err) {
          console.error('[follow] referral scenario enrollment failed', err);
        }
      }
    }

    // イベントバス発火: friend_add（replyToken は Step 0 で使用済みの可能性あり）
    if (!eventBusDisabled) await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    // [Craval kzn] 受信箱経由はイベント時刻で条件付き更新（友だち未登録でも状態を記録）。
    if (inbox && typeof eventTimestamp === 'number') {
      if (await claimFollowTransition(db, userId, false, eventTimestamp)) {
        // 友だち行がまだ無ければ解除履歴を保留（K002）。行ができる時に畳み込まれる。
        await recordPendingUnfollowIfNoFriend(db, userId, eventTimestamp);
      }
      await syncFriendFollowFromState(db, userId, jstNow());
      return;
    }
    await updateFriendFollowStatus(db, userId, false);
    return;
  }

  // Postback events — triggered by Flex buttons with action.type: "postback"
  // Uses the same auto_replies matching but without displaying text in chat
  if (event.type === 'postback') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId, inbox);
    if (!friend) return;

    const postbackData = (event as unknown as { postback: { data: string } }).postback.data;

    // postback の incoming 自体を messages_log に記録する。Rich Menu のタップで
    // 利用者が "コスト比較" などのアクションを起こした事実を chat 履歴で可視化する。
    // delivery_type='push' は厳密には push ではないが、incoming/non-test として
    // 既存 chat list / 詳細 SQL のフィルタを通すための妥当な値 (auto_reply text 同様)。
    if (inbox) {
      // [Craval kzn] webhookEventId で冪等に記録（再処理で重複しない）。失敗は再処理に回すため投げる。
      await insertIncomingLog(db, {
        friendId: friend.id, messageType: 'text', content: postbackData, source: 'postback',
        lineMessageId: null, webhookEventId, lineAccountId: lineAccountId ?? null, createdAt: jstNow(),
      });
    } else {
      try {
        await db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
             VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'postback', ?, ?)`,
          )
          .bind(crypto.randomUUID(), friend.id, postbackData, lineAccountId ?? null, jstNow())
          .run();
      } catch (err) {
        console.error('Failed to log incoming postback', err);
      }
    }
    // [Craval kzn] EVENT_BUS_DISABLED なら自動応答・イベント発火をしない。
    if (eventBusDisabled) return;

    // postback data を auto_replies にマッチさせて返信 (テキスト経路と共通)。
    // silent + automation で「返信なしでタグだけ付ける」構成もここで成立する。
    const { matched: postbackMatched, replyTokenConsumed: postbackReplyTokenConsumed } =
      await matchAndReply(db, lineClient, friend, postbackData, event.replyToken, {
        inputKind: 'postback',
        lineAccountId,
        workerUrl,
        liffUrl,
        logContext: 'postback',
        replyMessage: workerUrl
          ? (token, messages) => replyViaHarnessProxy(
              workerUrl,
              lineAccessToken,
              token,
              messages,
              proxyDispatch,
            )
          : undefined,
      });

    // イベントバス発火: 専用イベント postback_received。
    // postback.data を text に載せることで、IF-THEN 自動化の keyword /
    // keyword_exact 条件がリッチメニューのタップ（タグ付与等）に効く。
    // message_received を流用しないのは意図的 — 流用すると既存インストールの
    // message_received スコアリング・catch-all 自動化・送信 Webhook 購読者が
    // メニュータップで誤発火し、条件側に source を見る術がないため。
    // なお upsertChatOnMessage は呼ばない: メニュータップは自発メッセージでは
    // ないので、未対応 inbox を汚さないのが正しい (テキスト経路との意図的な差分)。
    await fireEvent(db, 'postback_received', {
      friendId: friend.id,
      eventData: { text: postbackData, matched: postbackMatched },
      replyToken: postbackReplyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);

    return;
  }

  // 非テキストの受信メッセージ（スタンプ/画像/音声/動画/ファイル/位置情報等）もログに残す。
  // ここで早期 return することで、テキスト用の auto_reply / scenario 判定には進まない
  // （スタンプ単体に対するキーワードマッチは意味を持たないため）。inbox 抜けだけ防ぐ。
  if (event.type === 'message' && event.message.type !== 'text') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;
    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId, inbox);
    if (!friend) return;

    const msg = event.message as {
      id: string;
      type: string;
      fileName?: string;
      title?: string;
      packageId?: string | number;
      package_id?: string | number;
      stickerId?: string | number;
      sticker_id?: string | number;
      stickerResourceType?: string | number;
      sticker_resource_type?: string | number;
    };
    const labels: Record<string, string> = {
      sticker: '[スタンプ]',
      image: '[画像]',
      audio: '[音声]',
      video: '[動画]',
      file: msg.fileName ? `[ファイル: ${msg.fileName}]` : '[ファイル]',
      location: msg.title ? `[位置情報: ${msg.title}]` : '[位置情報]',
    };
    const content = labels[msg.type] ?? `[${msg.type}]`;
    // [Craval kzn] 送信取消済みなら本文（ラベル・画像）を保存しない。
    const unsentAlready = inbox && (await isUnsent(db, msg.id));

    // image の場合は LINE Content API でバイナリを取得 → R2 → JSON URL に置換。
    // 失敗時は labels[msg.type] のラベル文字列のまま (フォールバック)。
    let finalContent = unsentAlready ? UNSENT_PLACEHOLDER : content;
    if (msg.type === 'sticker' && !unsentAlready) {
      const stickerContent = createStickerMessageContent(msg);
      if (stickerContent) {
        finalContent = JSON.stringify(stickerContent);
      }
    }
    if (msg.type === 'image' && r2 && workerUrl && !unsentAlready) {
      const lineMessageId = msg.id;
      const { fetchAndStoreIncomingImage } = await import('../services/incoming-image.js');
      const refs = await fetchAndStoreIncomingImage({
        r2,
        workerUrl,
        channelAccessToken: lineAccessToken,
        accountId: lineAccountId ?? 'unknown',
        messageId: lineMessageId,
      });
      if (refs) {
        finalContent = JSON.stringify(refs);
      }
    }

    const logId = crypto.randomUUID();
    if (inbox) {
      // [Craval kzn] webhookEventId / line_message_id で冪等。取消判定は挿入文の中で原子的に行う。
      const inserted = await insertIncomingLog(db, {
        friendId: friend.id, messageType: msg.type, content: finalContent, source: 'user',
        lineMessageId: msg.id, webhookEventId, createdAt: jstNow(),
      });
      if (unsentAlready || (await isUnsent(db, msg.id))) return;
      if (inserted && !eventBusDisabled) {
        await awardActivityMileage(db, {
          eventType: 'message_received',
          source: 'line',
          sourceEventId: webhookEventId ?? logId,
          friendId: friend.id,
          metadata: { messageType: msg.type },
        });
      }
      if (typeof eventTimestamp === 'number') {
        await touchChatOnIncomingEvent(db, friend.id, eventTimestamp, jstNow());
      } else {
        await upsertChatOnMessage(db, friend.id);
      }
      return;
    }
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
         VALUES (?, ?, 'incoming', ?, ?, NULL, NULL, 'user', ?)`,
      )
      .bind(logId, friend.id, msg.type, finalContent, jstNow())
      .run();
    if (!eventBusDisabled) await awardActivityMileage(db, {
      eventType: 'message_received',
      source: 'line',
      sourceEventId: logId,
      friendId: friend.id,
      metadata: { messageType: msg.type },
    });
    // text と同様、非 text の自発メッセージ (画像/スタンプ等) でも chat を unread に戻す。
    // これが無いと resolved 除外 (unanswered-inbox CANDIDATES_SQL) が「解決済み後に
    // 画像だけ送ってきた友だち」をバッジ・未対応一覧から永久に落としてしまう。
    // 非 text は auto_reply keyword にマッチし得ないので常に要対応扱いで正しい。
    await upsertChatOnMessage(db, friend.id);
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId, inbox);
    if (!friend) return;

    const now = jstNow();
    const logId = crypto.randomUUID();
    // [Craval kzn] 送信取消済みなら本文を保存しない（取消が先着したケース）。
    const unsentAlready = inbox && (await isUnsent(db, textMessage.id));
    const incomingText = unsentAlready ? UNSENT_PLACEHOLDER : textMessage.text;

    // 受信メッセージをログに記録
    // [Craval kzn] replay=true は「ログは記録済み（途中失敗からの再処理）」。完了判定は webhook_inbox.processed のみで、
    // ここでは return しない。冪等な後続（未読化）は続行し、外部に出る副作用（応答・クロスアカウント送信・
    // マイレージ・イベント発火）は二重実行を避けるため replay では行わない。
    let replay = false;
    if (inbox) {
      const inserted = await insertIncomingLog(db, {
        friendId: friend.id, messageType: 'text', content: incomingText, source: 'user',
        lineMessageId: textMessage.id, webhookEventId, createdAt: now,
      });
      replay = !inserted;
      // 取消済み（挿入前後どちらで確定したかによらず）なら副作用を一切行わない。
      if (unsentAlready || (await isUnsent(db, textMessage.id))) return;
    } else {
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
           VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'user', ?)`,
        )
        .bind(logId, friend.id, incomingText, now)
        .run();
    }
    const skipSideEffects = eventBusDisabled || replay;

    if (!skipSideEffects) await awardActivityMileage(db, {
      eventType: 'message_received',
      source: 'line',
      sourceEventId: logId,
      friendId: friend.id,
      metadata: { messageType: 'text' },
      occurredAt: now,
    });

    // Cross-account trigger: send message from another account via UUID
    if (!skipSideEffects && incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            'SELECT f.line_user_id, la.channel_access_token FROM friends f INNER JOIN line_accounts la ON la.id = f.line_account_id WHERE f.user_id = ? AND f.line_account_id != ? AND f.is_following = 1'
          ).bind(friendRecord.user_id, lineAccountId).all<{ line_user_id: string; channel_access_token: string }>();

          for (const other of otherFriends.results) {
            const otherClient = new LineClient(other.channel_access_token);
            await otherClient.pushMessage(other.line_user_id, [buildMessage('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(liffUrl ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${liffUrl}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
          }

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）。
    // silent タイプは返信しないが matched=true になり unread / push を抑止する。
    // [Craval kzn] skipSideEffects（EVENT_BUS_DISABLED / 再処理）では自動応答を評価しない＝未読として扱う。
    const { matched, replyTokenConsumed } = skipSideEffects ? { matched: false, replyTokenConsumed: false } : await matchAndReply(
      db,
      lineClient,
      friend,
      incomingText,
      event.replyToken,
      {
        inputKind: 'text',
        lineAccountId,
        workerUrl,
        liffUrl,
        replyMessage: workerUrl
          ? (token, messages) => replyViaHarnessProxy(
              workerUrl,
              lineAccessToken,
              token,
              messages,
              proxyDispatch,
            )
          : undefined,
      },
    );

    // auto_replies にマッチしなかった = 自発メッセージ → unread にする
    if (!matched) {
      if (inbox && typeof eventTimestamp === 'number') {
        // [Craval kzn] イベント時刻で条件付き（再処理で対応済みチャットを未読に戻さない）
        await touchChatOnIncomingEvent(db, friend.id, eventTimestamp, jstNow());
      } else {
        await upsertChatOnMessage(db, friend.id);
      }
    }

    if (skipSideEffects) return;

    // イベントバス発火: message_received
    // Pass replyToken only when auto_reply didn't actually consume it
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
      replyToken: replyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);

    return;
  }
}

export { webhook };
