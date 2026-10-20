const SESSION_URL = "https://chatgpt.com/api/auth/session";
const SESSION_COOKIE = "__Secure-next-auth.session-token";
const BACKEND_URL = "https://chatgpt.com";
const USAGE_PATH = "/backend-api/wham/usage";
const RESET_CREDITS_PATH = "/backend-api/wham/rate-limit-reset-credits";
const ACCOUNTS_CHECK_PATH = "/backend-api/accounts/check/v4-2023-04-27";
const ACCESS_TOKEN_FALLBACK_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 30_000;
// Stale sessions still redirected to the rotated one. Only the pre-rotation
// copy a single poll holds matters, so a few cover forced refreshes too.
const MAX_ROTATED_FROM = 4;

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

/** Billing state of one account, from accounts/check. */
export interface ChatGPTEntitlement {
  has_active_subscription?: boolean;
  subscription_plan?: string | null;
  /** ISO string or unix seconds; both have been seen in the wild. */
  expires_at?: string | number | null;
  renews_at?: string | number | null;
  cancels_at?: string | number | null;
  billing_period?: string | null;
  is_delinquent?: boolean;
  grace_period_end_timestamp?: string | number | null;
}

export interface ChatGPTAccountCheck {
  entitlement?: ChatGPTEntitlement | null;
  last_active_subscription?: { will_renew?: boolean } | null;
}

interface AccountsCheckResponse {
  accounts?: Record<string, ChatGPTAccountCheck>;
  account_ordering?: string[];
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
    return `${SESSION_COOKIE}=${session.token}`;
  }
  return `${SESSION_COOKIE}.0=${session.token0}; ` +
    `${SESSION_COOKIE}.1=${session.token1}`;
}

export function sessionCacheKey(session: ChatGPTSession): string {
  return session.kind === "single"
    ? `single\u0000${session.token}`
    : `split\u0000${session.token0}\u0000${session.token1}`;
}

/** Whether a Set-Cookie line removes its cookie rather than setting it. */
function isCookieDeletion(value: string, attrs: string[], now: number) {
  if (!value) return true;
  for (const attr of attrs) {
    const eq = attr.indexOf("=");
    if (eq < 0) continue;
    const name = attr.slice(0, eq).trim().toLowerCase();
    const v = attr.slice(eq + 1).trim();
    // Max-Age wins over Expires (RFC 6265 §5.3).
    if (name === "max-age" && /^-?\d+$/.test(v)) return Number(v) <= 0;
  }
  for (const attr of attrs) {
    const eq = attr.indexOf("=");
    if (eq < 0 || attr.slice(0, eq).trim().toLowerCase() !== "expires") {
      continue;
    }
    const at = Date.parse(attr.slice(eq + 1).trim());
    if (!Number.isNaN(at)) return at <= now;
  }
  return false;
}

/**
 * The session that `setCookies` (from /api/auth/session) rotate `current`
 * to, or null when they leave it as it is.
 *
 * ChatGPT re-issues the session cookie on that endpoint, and the copy the
 * user pasted eventually stops yielding usable access tokens, so the newest
 * one must be kept. Either shape can replace either shape. Anything not
 * cleanly one of them — only deletions, a lone chunk, or a third chunk this
 * app cannot store — is ignored rather than risk replacing a working session
 * with a broken one.
 */
export function rotatedSession(
  current: ChatGPTSession,
  setCookies: string[],
  now: number,
): ChatGPTSession | null {
  const live = new Map<string, string>();
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== SESSION_COOKIE && !name.startsWith(`${SESSION_COOKIE}.`)) {
      continue;
    }
    const value = pair.slice(eq + 1).trim();
    if (isCookieDeletion(value, attrs, now)) live.delete(name);
    else live.set(name, value);
  }

  const single = live.get(SESSION_COOKIE);
  const part0 = live.get(`${SESSION_COOKIE}.0`);
  const part1 = live.get(`${SESSION_COOKIE}.1`);
  let next: ChatGPTSession;
  if (single && live.size === 1) {
    next = { kind: "single", token: single };
  } else if (part0 && part1 && live.size === 2) {
    next = { kind: "split", token0: part0, token1: part1 };
  } else {
    return null;
  }
  return sessionCacheKey(next) === sessionCacheKey(current) ? null : next;
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
  /**
   * Called when /api/auth/session re-issues the session cookie, so the
   * caller can persist `to` in place of `from`. The client already uses
   * `to` from then on, even when handed `from` again.
   */
  onSessionRotated?: (from: ChatGPTSession, to: ChatGPTSession) => void;
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
  private readonly onSessionRotated?: (
    from: ChatGPTSession,
    to: ChatGPTSession,
  ) => void;
  private cachedAccessToken: CachedAccessToken | null = null;
  private refreshPromise: Promise<string> | null = null;
  // Callers holding a pre-rotation session (e.g. the rest of one poll) are
  // redirected to the rotated one.
  private rotation: { fromKeys: string[]; to: ChatGPTSession } | null = null;

  constructor(options: ChatGPTClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.deviceId = options.deviceId;
    this.now = options.now ?? Date.now;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.onSessionRotated = options.onSessionRotated;
  }

  private currentSession(session: ChatGPTSession): ChatGPTSession {
    const rotation = this.rotation;
    return rotation?.fromKeys.includes(sessionKey(session))
      ? rotation.to
      : session;
  }

  private recordRotation(fromKey: string, to: ChatGPTSession): void {
    const prev = this.rotation;
    const chained = prev && sessionKey(prev.to) === fromKey
      ? prev.fromKeys
      : [];
    this.rotation = {
      fromKeys: [...chained, fromKey].slice(-MAX_ROTATED_FROM),
      to,
    };
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

    // getSetCookie is missing where a webview proxy cannot pass cookies on.
    const rotated = rotatedSession(
      session,
      res.headers.getSetCookie?.() ?? [],
      this.now(),
    );
    if (rotated) {
      this.recordRotation(key, rotated);
      this.onSessionRotated?.(session, rotated);
    }

    const expiresAt = decodeJwtExpiry(body.accessToken) ??
      (this.now() + ACCESS_TOKEN_FALLBACK_TTL_MS);
    this.cachedAccessToken = {
      sessionKey: rotated ? sessionKey(rotated) : key,
      value: body.accessToken,
      expiresAt,
    };
    return body.accessToken;
  }

  private async resolveAccessToken(
    requested: ChatGPTSession,
    forceRefresh = false,
  ): Promise<string> {
    const session = this.currentSession(requested);
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

  /**
   * Subscription renewal/expiry for `accountId` (wham/usage's
   * `account_id`), falling back to the first account listed.
   */
  async fetchAccountCheck(
    session: ChatGPTSession,
    accountId?: string,
  ): Promise<ChatGPTAccountCheck | null> {
    const body = await this.getBackend<AccountsCheckResponse>(
      session,
      ACCOUNTS_CHECK_PATH,
    );
    const accounts = body.accounts ?? {};
    const id = accountId && accounts[accountId]
      ? accountId
      : body.account_ordering?.[0];
    return (id && accounts[id]) || null;
  }
}
