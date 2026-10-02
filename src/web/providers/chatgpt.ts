const SESSION_URL = "https://chatgpt.com/api/auth/session";
const BACKEND_URL = "https://chatgpt.com";
const USAGE_PATH = "/backend-api/wham/usage";
const RESET_CREDITS_PATH = "/backend-api/wham/rate-limit-reset-credits";
const ACCESS_TOKEN_FALLBACK_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 30_000;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0";

export interface ChatGPTUsageWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

export interface ChatGPTRateLimit {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: ChatGPTUsageWindow | null;
  secondary_window?: ChatGPTUsageWindow | null;
}

export interface ChatGPTUsageResponse {
  account_id?: string;
  plan_type?: string;
  rate_limit?: ChatGPTRateLimit | null;
  code_review_rate_limit?: ChatGPTRateLimit | null;
  additional_rate_limits?: Array<{
    limit_name: string;
    rate_limit: ChatGPTRateLimit;
  }>;
  credits?: {
    has_credits?: boolean;
    balance?: string | number | null;
    unlimited?: boolean;
    overage_limit_reached?: boolean;
  } | null;
  /**
   * Usage-limit resets. `applicable_available_count` is how many of
   * `available_count` can be spent right now.
   */
  rate_limit_reset_credits?: {
    available_count?: number;
    applicable_available_count?: number;
  } | null;
}

/** One usage-limit reset, as listed by wham/rate-limit-reset-credits. */
export interface ChatGPTResetCredit {
  id: string;
  reset_type?: string;
  is_supported_by_plan?: boolean;
  /** "available" until redeemed or expired. */
  status: string;
  granted_at?: string;
  expires_at?: string | null;
  redeemed_at?: string | null;
  title?: string;
  description?: string;
}

export interface ChatGPTResetCreditsResponse {
  credits?: ChatGPTResetCredit[];
  available_count?: number;
}

export class ChatGPTAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGPTAuthError";
  }
}

/**
 * ChatGPT session cookies.
 *
 * ChatGPT chunks `__Secure-next-auth.session-token` into `.0`/`.1` parts
 * when the value grows past the per-cookie size limit, and serves a single
 * un-chunked cookie otherwise; which one you get has flipped back and forth.
 * Both shapes are accepted and stored as pasted.
 */
export type ChatGPTSession =
  | { kind: "single"; token: string }
  | { kind: "split"; token0: string; token1: string };

export function sessionCookieHeader(session: ChatGPTSession): string {
  if (session.kind === "single") {
    return `__Secure-next-auth.session-token=${session.token}`;
  }
  return `__Secure-next-auth.session-token.0=${session.token0}; ` +
    `__Secure-next-auth.session-token.1=${session.token1}`;
}

export function sessionCacheKey(session: ChatGPTSession): string {
  return session.kind === "single"
    ? `single\u0000${session.token}`
    : `split\u0000${session.token0}\u0000${session.token1}`;
}

interface CachedAccessToken {
  sessionKey: string;
  value: string;
  expiresAt: number;
}

export interface ChatGPTClientOptions {
  fetchFn?: typeof fetch;
  deviceId: string;
  now?: () => number;
  userAgent?: string;
}

function sessionKey(session: ChatGPTSession): string {
  return sessionCacheKey(session);
}

function decodeJwtExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;

  try {
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = encoded + "=".repeat((4 - encoded.length % 4) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return null;
    }
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

export class ChatGPTClient {
  private readonly fetchFn: typeof fetch;
  private readonly deviceId: string;
  private readonly now: () => number;
  private readonly userAgent: string;
  private cachedAccessToken: CachedAccessToken | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(options: ChatGPTClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.deviceId = options.deviceId;
    this.now = options.now ?? Date.now;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  clearAccessToken(): void {
    this.cachedAccessToken = null;
  }

  private getCachedAccessToken(key: string): string | null {
    const cached = this.cachedAccessToken;
    if (!cached || cached.sessionKey !== key) return null;
    if (cached.expiresAt - ACCESS_TOKEN_EXPIRY_SKEW_MS <= this.now()) {
      this.cachedAccessToken = null;
      return null;
    }
    return cached.value;
  }

  private async requestAccessToken(
    session: ChatGPTSession,
    key: string,
  ): Promise<string> {
    const cookie = sessionCookieHeader(session);
    const res = await this.fetchFn(SESSION_URL, {
      headers: {
        "Accept": "application/json",
        "Cookie": cookie,
        "User-Agent": this.userAgent,
      },
    });

    if (res.status === 401 || res.status === 403) {
      throw new ChatGPTAuthError(`session refresh failed: ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(
        `session refresh failed: ${res.status} ${res.statusText}`,
      );
    }

    const body = await res.json() as { accessToken?: string };
    if (!body.accessToken) {
      throw new ChatGPTAuthError("session refresh returned no access token");
    }

    const expiresAt = decodeJwtExpiry(body.accessToken) ??
      (this.now() + ACCESS_TOKEN_FALLBACK_TTL_MS);
    this.cachedAccessToken = {
      sessionKey: key,
      value: body.accessToken,
      expiresAt,
    };
    return body.accessToken;
  }

  private async resolveAccessToken(
    session: ChatGPTSession,
    forceRefresh = false,
  ): Promise<string> {
    const key = sessionKey(session);
    if (!forceRefresh) {
      const cached = this.getCachedAccessToken(key);
      if (cached) return cached;
    }

    // Avoid multiple simultaneous session exchanges if a poll and a manual
    // reconnect happen at the same time.
    if (this.refreshPromise) return await this.refreshPromise;

    const refresh = this.requestAccessToken(session, key);
    this.refreshPromise = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshPromise === refresh) this.refreshPromise = null;
    }
  }

  private async requestBackend(
    path: string,
    accessToken: string,
    extraHeaders: Record<string, string>,
  ): Promise<Response> {
    return await this.fetchFn(BACKEND_URL + path, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "oai-device-id": this.deviceId,
        "X-OpenAI-Target-Path": path,
        "X-OpenAI-Target-Route": path,
        "User-Agent": this.userAgent,
        ...extraHeaders,
      },
    });
  }

  private async getBackend<T>(
    session: ChatGPTSession,
    path: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    let accessToken = await this.resolveAccessToken(session);
    let res = await this.requestBackend(path, accessToken, extraHeaders);

    if (res.status === 401 || res.status === 403) {
      // The access token may have been revoked independently of the browser
      // cookies. Refresh once before surfacing an authentication failure.
      this.clearAccessToken();
      accessToken = await this.resolveAccessToken(session, true);
      res = await this.requestBackend(path, accessToken, extraHeaders);
    }

    if (res.status === 401 || res.status === 403) {
      throw new ChatGPTAuthError(`auth failed: ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`request failed: ${res.status} ${res.statusText}`);
    }
    return await res.json() as T;
  }

  async fetchUsage(
    session: ChatGPTSession,
  ): Promise<ChatGPTUsageResponse> {
    return await this.getBackend(session, USAGE_PATH);
  }

  /**
   * Usage-limit resets with per-reset expiry (wham/usage only counts them).
   * Headers mirror what chatgpt.com's Codex page sends; `accountId` is
   * wham/usage's `account_id`.
   */
  async fetchResetCredits(
    session: ChatGPTSession,
    accountId?: string,
  ): Promise<ChatGPTResetCreditsResponse> {
    const headers: Record<string, string> = { "originator": "Codex Browser" };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    return await this.getBackend(session, RESET_CREDITS_PATH, headers);
  }
}
