/**
 * Claude.ai usage client.
 *
 * Lifted from report.ts unchanged, including the browser-mimicking headers.
 * `Cookie`, `User-Agent`, `Referer` and `Sec-Fetch-*` are forbidden request
 * headers in a browser, but the denapk runtime shim rewrites this call through
 * the host proxy before the browser ever sees it — see host/runtime.js.
 */

import { envOverride, getClaudeOrg, setClaudeOrg } from "../store.ts";

export class AuthError extends Error {}

export interface ClaudeWindow {
  utilization: number;
  resets_at: string;
  limit_dollars?: number | null;
  used_dollars?: number | null;
  remaining_dollars?: number | null;
}
export interface LimitEntry {
  kind: string;
  group: string;
  percent: number;
  severity: string;
  resets_at: string | null;
  scope?: {
    model?: { id: string | null; display_name: string } | null;
    surface?: unknown;
  } | null;
  is_active: boolean;
}
export interface ExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency: string;
  decimal_places: number;
  disabled_reason: string | null;
}
export interface SpendInfo {
  enabled: boolean;
  used?: { amount_minor: number; currency: string; exponent: number } | null;
  limit?: number | null;
  percent?: number;
  disabled_reason?: string | null;
  can_purchase_credits?: boolean;
}
export interface ClaudeUsageResponse {
  five_hour: ClaudeWindow;
  seven_day: ClaudeWindow;
  spend?: SpendInfo;
  extra_usage?: ExtraUsage | null;
  limits?: LimitEntry[];
}
export interface PrepaidCredits {
  amount: number;
  currency: string;
  balance_credits: number;
}

const DEVICE_ID = crypto.randomUUID();
const ANONYMOUS_ID = crypto.randomUUID();
const ACTIVITY_SESSION_ID = crypto.randomUUID();

function claudeHeaders(token: string): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": `sessionKey=${token}`,
    "anthropic-client-platform": "web_claude_ai",
    "anthropic-device-id": DEVICE_ID,
    "anthropic-anonymous-id": ANONYMOUS_ID,
    "x-activity-session-id": ACTIVITY_SESSION_ID,
    "Referer": "https://claude.ai/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Priority": "u=0",
  };
}

async function resolveClaudeOrg(token: string): Promise<string> {
  const override = envOverride("CLAUDE_ORG_ID");
  if (override) return override;
  const cached = getClaudeOrg();
  if (cached) return cached;

  const res = await fetch("https://claude.ai/api/organizations", {
    headers: claudeHeaders(token),
  });
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`auth failed while resolving org id: ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(
      `could not list organizations: ${res.status} ${res.statusText}`,
    );
  }
  const orgs = await res.json() as Array<{ uuid: string; name?: string }>;
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new Error("this session key has no organizations attached");
  }
  const orgId = orgs[0].uuid;
  setClaudeOrg(orgId);
  return orgId;
}

export async function fetchClaudeUsage(
  token: string,
): Promise<ClaudeUsageResponse> {
  const orgId = await resolveClaudeOrg(token);
  const res = await fetch(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    { headers: claudeHeaders(token) },
  );
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`auth failed: ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`request failed: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

export async function fetchClaudePrepaidCredits(
  token: string,
): Promise<PrepaidCredits> {
  const orgId = await resolveClaudeOrg(token);
  const res = await fetch(
    `https://claude.ai/api/organizations/${orgId}/prepaid/credits`,
    { headers: claudeHeaders(token) },
  );
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`auth failed: ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`request failed: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}
