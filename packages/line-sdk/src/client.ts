import type {
  BroadcastRequest,
  FlexContainer,
  Message,
  MulticastRequest,
  PushMessageRequest,
  ReplyMessageRequest,
  RichMenuObject,
  UserProfile,
} from './types.js';

const LINE_API_BASE = 'https://api.line.me';

// [Craval kzn] LINE_SEND_DISABLED=1 の環境では、メッセージ送信系 API（reply/push/multicast/
// broadcast/narrowcast 等 = POST /v2/bot/message/*）を例外で拒否する。GET（プロフィール・通数照会）は許可。
// isolate 内の全 LineClient に効かせるためモジュールスコープのフラグにし、Worker の fetch/scheduled
// 入口で env から毎回セットする。未設定なら false＝本家と同一挙動。
let lineSendDisabled = false;

export function setLineSendDisabled(disabled: boolean): void {
  lineSendDisabled = disabled;
}

export function isLineSendDisabled(): boolean {
  return lineSendDisabled;
}

/** POST /v2/bot/message/* ＝メッセージ送信か（プロキシ側のガードでも使う）。 */
export function isLineMessageSendRequest(method: string, path: string): boolean {
  return method.toUpperCase() !== 'GET' && path.startsWith('/v2/bot/message/');
}

// [Craval kzn] 通数ガード（返信予約枠）。push / multicast の直前に呼ぶ（宛先数を渡す）。例外を投げたら送らない。
// reply（無料）は対象外。broadcast / narrowcast は呼び出し側の配信前ガード（getLinePlanQuotaShortfall）が担う。
// 未設定（null）なら本家と同一挙動。Worker の fetch/scheduled 入口で env から毎回セットする。
export type LineSendGuard = (client: LineClient, recipients: number, path: string) => Promise<void>;
let lineSendGuard: LineSendGuard | null = null;
export function setLineSendGuard(guard: LineSendGuard | null): void {
  lineSendGuard = guard;
}

export class LineSendDisabledError extends Error {
  constructor(path: string) {
    super(`LINE send disabled (LINE_SEND_DISABLED=1): ${path}`);
    this.name = 'LineSendDisabledError';
  }
}

export interface FollowersInsight {
  status: string;
  followers?: number;
  targetedReaches?: number;
  blocks?: number;
}

export interface FollowerIdsPage {
  userIds: string[];
  next?: string;
}

export interface MessageQuota {
  /** 'limited' (value holds the plan's monthly cap) or 'none' (no cap). */
  type: string;
  value?: number;
}

export interface MessageQuotaConsumption {
  totalUsage: number;
}

/**
 * LINE API が非 2xx を返したときの typed error。status とレスポンス本文を
 * 機械可読に保持する — 呼び出し元が「429 かつ月間上限超過」のような判別を
 * message 文字列のパースなしで行えるようにする。
 */
export class LineApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly responseBody: string,
  ) {
    super(`LINE API error: ${status} ${statusText} — ${responseBody}`);
    this.name = 'LineApiError';
  }
}

export class LineClient {
  constructor(private readonly channelAccessToken: string) {}

  // ─── Core request helper ──────────────────────────────────────────────────

  async request(
    method: string,
    path: string,
    body?: unknown,
    requestHeaders: Record<string, string> = {},
  ): Promise<{ data: unknown; headers: Headers }> {
    if (lineSendDisabled && isLineMessageSendRequest(method, path)) {
      throw new LineSendDisabledError(path);
    }
    if (lineSendGuard && method.toUpperCase() === 'POST' && (path === '/v2/bot/message/push' || path === '/v2/bot/message/multicast')) {
      const to = (body as { to?: unknown } | undefined)?.to;
      const recipients = Array.isArray(to) ? to.length : 1;
      await lineSendGuard(this, recipients, path);
    }
    const url = `${LINE_API_BASE}${path}`;

    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.channelAccessToken}`,
        ...requestHeaders,
      },
    };

    if (method !== 'GET' && method !== 'DELETE' && body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);

    // LINE returns 409 when a request with the same X-Line-Retry-Key was
    // already accepted. For a caller retrying the exact same operation this
    // is a successful idempotent outcome, not a delivery failure.
    if (res.status === 409 && requestHeaders['X-Line-Retry-Key']) {
      return { data: { retryAccepted: true }, headers: res.headers };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LineApiError(res.status, res.statusText, text);
    }

    // Some endpoints (e.g. push, reply) return an empty body with 200.
    const contentType = res.headers.get('content-type') ?? '';
    let data: unknown;
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = undefined;
    }

    return { data, headers: res.headers };
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<UserProfile> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/profile/${encodeURIComponent(userId)}`,
    );
    return data as UserProfile;
  }

  // ─── Messaging ───────────────────────────────────────────────────────────

  async pushMessage(
    to: string,
    messages: Message[],
    retryKey?: string,
    customAggregationUnits?: string[],
  ): Promise<unknown> {
    const body: PushMessageRequest = { to, messages, customAggregationUnits };
    const { data } = await this.request(
      'POST',
      '/v2/bot/message/push',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return data;
  }

  async multicast(
    to: string[],
    messages: Message[],
    customAggregationUnits?: string[],
    retryKey?: string,
  ): Promise<{ data: unknown; requestId: string | null }> {
    const body: Record<string, unknown> = { to, messages };
    if (customAggregationUnits) {
      body.customAggregationUnits = customAggregationUnits;
    }
    const { data, headers } = await this.request(
      'POST',
      '/v2/bot/message/multicast',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return { data, requestId: headers.get('x-line-request-id') };
  }

  async broadcast(
    messages: Message[],
    retryKey?: string,
  ): Promise<{ data: unknown; requestId: string | null }> {
    const body: BroadcastRequest = { messages };
    const { data, headers } = await this.request(
      'POST',
      '/v2/bot/message/broadcast',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return { data, requestId: headers.get('x-line-request-id') };
  }

  async replyMessage(
    replyToken: string,
    messages: Message[],
  ): Promise<unknown> {
    const body: ReplyMessageRequest = { replyToken, messages };
    const { data } = await this.request('POST', '/v2/bot/message/reply', body);
    return data;
  }

  // ─── Rich Menu ────────────────────────────────────────────────────────────

  async getRichMenuList(): Promise<{ richmenus: RichMenuObject[] }> {
    const { data } = await this.request('GET', '/v2/bot/richmenu/list');
    return data as { richmenus: RichMenuObject[] };
  }

  async createRichMenu(menu: RichMenuObject): Promise<{ richMenuId: string }> {
    const { data } = await this.request('POST', '/v2/bot/richmenu', menu);
    return data as { richMenuId: string };
  }

  async deleteRichMenu(richMenuId: string): Promise<unknown> {
    const { data } = await this.request(
      'DELETE',
      `/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`,
    );
    return data;
  }

  async setDefaultRichMenu(richMenuId: string): Promise<unknown> {
    const { data } = await this.request(
      'POST',
      `/v2/bot/user/all/richmenu/${encodeURIComponent(richMenuId)}`,
    );
    return data;
  }

  async linkRichMenuToUser(
    userId: string,
    richMenuId: string,
  ): Promise<unknown> {
    const { data } = await this.request(
      'POST',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu/${encodeURIComponent(richMenuId)}`,
    );
    return data;
  }

  async unlinkRichMenuFromUser(userId: string): Promise<unknown> {
    const { data } = await this.request(
      'DELETE',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu`,
    );
    return data;
  }

  async getRichMenuIdOfUser(userId: string): Promise<{ richMenuId: string }> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu`,
    );
    return data as { richMenuId: string };
  }

  async getDefaultRichMenuId(): Promise<string | null> {
    const url = `${LINE_API_BASE}/v2/bot/user/all/richmenu`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.channelAccessToken}`,
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LineApiError(res.status, res.statusText, text);
    }
    const data = (await res.json()) as { richMenuId: string };
    return data.richMenuId;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async pushTextMessage(to: string, text: string): Promise<unknown> {
    return this.pushMessage(to, [{ type: 'text', text }]);
  }

  async pushFlexMessage(
    to: string,
    altText: string,
    contents: FlexContainer,
  ): Promise<unknown> {
    return this.pushMessage(to, [{ type: 'flex', altText, contents }]);
  }

  async pushImageMessage(
    to: string,
    originalContentUrl: string,
    previewImageUrl: string,
  ): Promise<unknown> {
    return this.pushMessage(to, [{ type: 'image', originalContentUrl, previewImageUrl }]);
  }

  // ─── Rich Menu Image Upload ─────────────────────────────────────────────

  /** Upload image to a rich menu. Accepts PNG/JPEG binary (ArrayBuffer or Uint8Array). */
  async uploadRichMenuImage(
    richMenuId: string,
    imageData: ArrayBuffer,
    contentType: 'image/png' | 'image/jpeg' = 'image/png',
  ): Promise<void> {
    const url = `https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: `Bearer ${this.channelAccessToken}`,
      },
      body: imageData,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LineApiError(res.status, res.statusText, text);
    }
  }

  // ─── Insight API ─────────────────────────────────────────────────────────

  /**
   * Get user interaction statistics for a broadcast message.
   * Data becomes available ~3 days after sending.
   * GET only — no messages are sent.
   */
  async getMessageEventInsight(requestId: string): Promise<unknown> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/insight/message/event?requestId=${encodeURIComponent(requestId)}`,
    );
    return data;
  }

  /**
   * Get statistics per unit for multicast messages.
   * GET only — no messages are sent.
   */
  async getUnitInsight(
    customAggregationUnit: string,
    from: string,
    to: string,
  ): Promise<unknown> {
    const params = new URLSearchParams({ customAggregationUnit, from, to });
    const { data } = await this.request(
      'GET',
      `/v2/bot/insight/message/event/aggregation?${params.toString()}`,
    );
    return data;
  }

  /**
   * Get the number of followers for a LINE Official Account on a given date.
   * GET only — no messages are sent.
   */
  async getFollowersInsight(date: string): Promise<FollowersInsight> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/insight/followers?date=${encodeURIComponent(date)}`,
    );
    return data as FollowersInsight;
  }

  /**
   * Get the monthly message quota of the LINE Official Account's plan.
   * GET only — no messages are sent.
   */
  async getMessageQuota(): Promise<MessageQuota> {
    const { data } = await this.request('GET', '/v2/bot/message/quota');
    return data as MessageQuota;
  }

  /**
   * Get the number of messages already counted against this month's quota.
   * GET only — no messages are sent.
   */
  async getMessageQuotaConsumption(): Promise<MessageQuotaConsumption> {
    const { data } = await this.request('GET', '/v2/bot/message/quota/consumption');
    return data as MessageQuotaConsumption;
  }

  /**
   * Get one page of users who currently follow the LINE Official Account.
   * Verified/premium accounts only. Pass the returned `next` value as
   * `start` until `next` is absent to retrieve the full audience.
   */
  async getFollowerIds(
    limit = 1000,
    start?: string,
  ): Promise<FollowerIdsPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (start) params.set('start', start);
    const { data } = await this.request(
      'GET',
      `/v2/bot/followers/ids?${params.toString()}`,
    );
    return data as FollowerIdsPage;
  }
}
