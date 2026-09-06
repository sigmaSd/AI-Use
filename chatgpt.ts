const SESSION_URL = "https://chatgpt.com/api/auth/session";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
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
}

export class ChatGPTAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGPTAuthError";
  }
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

function sessionKey(session0: string, session1: string): string {
  return `${session0}\u0000${session1}`;
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
    session0: string,
    session1: string,
    key: string,
  ): Promise<string> {
    const cookie = `__Secure-next-auth.session-token.0=${session0}; ` +
      `__Secure-next-auth.session-token.1=${session1}`;
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
    session0: string,
    session1: string,
    forceRefresh = false,
  ): Promise<string> {
    const key = sessionKey(session0, session1);
    if (!forceRefresh) {
      const cached = this.getCachedAccessToken(key);
      if (cached) return cached;
    }

    // Avoid multiple simultaneous session exchanges if a poll and a manual
    // reconnect happen at the same time.
    if (this.refreshPromise) return await this.refreshPromise;

    const refresh = this.requestAccessToken(session0, session1, key);
    this.refreshPromise = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshPromise === refresh) this.refreshPromise = null;
    }
  }

  private async requestUsage(accessToken: string): Promise<Response> {
    return await this.fetchFn(USAGE_URL, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "oai-device-id": this.deviceId,
        "X-OpenAI-Target-Path": "/backend-api/wham/usage",
        "X-OpenAI-Target-Route": "/backend-api/wham/usage",
        "User-Agent": this.userAgent,
      },
    });
  }

  async fetchUsage(
    session0: string,
    session1: string,
  ): Promise<ChatGPTUsageResponse> {
    let accessToken = await this.resolveAccessToken(session0, session1);
    let res = await this.requestUsage(accessToken);

    if (res.status === 401 || res.status === 403) {
      // The access token may have been revoked independently of the browser
      // cookies. Refresh once before surfacing an authentication failure.
      this.clearAccessToken();
      accessToken = await this.resolveAccessToken(session0, session1, true);
      res = await this.requestUsage(accessToken);
    }

    if (res.status === 401 || res.status === 403) {
      throw new ChatGPTAuthError(`auth failed: ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`request failed: ${res.status} ${res.statusText}`);
    }
    return await res.json() as ChatGPTUsageResponse;
  }
}
