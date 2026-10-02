/**
 * Claude.ai usage client.
 *
 * Lifted from report.ts unchanged, including the browser-mimicking headers.
 * `Cookie`, `User-Agent`, `Referer` and `Sec-Fetch-*` are forbidden request
 * headers in a browser, but the denoapk fetch shim rewrites this call through
 * the host proxy before the browser ever sees it.
 */

import {
  getClaudeOrg,
  getClaudeResetsParam,
  getClaudeResetsProbedAt,
  setClaudeOrg,
  setClaudeResetsParam,
  setClaudeResetsProbedAt,
} from "../store.ts";

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
/** One promotional grant of usage-limit resets ("Reset for free"). */
export interface ResetGrant {
  id: string;
  label: string;
  resets_total: number;
  resets_left: number;
  starts_at: string;
  /** When unused resets in this grant expire. */
  ends_at: string;
  /** Limit windows a reset clears, e.g. "five_hour", "seven_day". */
  clears: string[];
  paused: boolean;
  usable_now: boolean;
  use_requires_limit: boolean;
}
/**
 * Usage-limit resets. claude.ai only includes this block when the usage
 * request opts in with `?<name>=1`, and returns it under that same
 * obfuscated name (`cedar_ember` as of Oct 2026). See fetchClaudeUsage.
 */
export interface ResetCredits {
  eligible: boolean;
  ineligible_reason: string | null;
  grants: ResetGrant[];
  cooldown_until: string | null;
}
export interface ClaudeUsageResponse {
  five_hour: ClaudeWindow;
  seven_day: ClaudeWindow;
  spend?: SpendInfo;
  extra_usage?: ExtraUsage | null;
  limits?: LimitEntry[];
  /** Not sent by claude.ai: attached by fetchClaudeUsage, found by shape. */
  reset_credits?: ResetCredits | null;
  /** Not sent by claude.ai: attached by fetchClaudeUsage, found by shape. */
  dollar_allowances?: DollarAllowance[];
}

/**
 * A spend-capped allowance outside the 5-hour/weekly windows, e.g. a
 * monthly $250 one. claude.ai sends these under obfuscated names
 * (`iguana_necktie` as of Oct 2026), so they are found by shape.
 */
export interface DollarAllowance {
  key: string;
  utilization: number;
  resets_at: string;
  limit_dollars: number;
  used_dollars: number | null;
  remaining_dollars: number | null;
  locked_reason: string | null;
}

/** Windows the dashboard already renders on their own. */
const KNOWN_WINDOWS = new Set(["five_hour", "seven_day"]);

export function findDollarAllowances(
  usage: Record<string, unknown>,
): DollarAllowance[] {
  const out: DollarAllowance[] = [];
  for (const [key, value] of Object.entries(usage)) {
    if (KNOWN_WINDOWS.has(key) || !value || typeof value !== "object") {
      continue;
    }
    const v = value as Record<string, unknown>;
    if (
      typeof v.utilization !== "number" || typeof v.resets_at !== "string" ||
      typeof v.limit_dollars !== "number" || v.limit_dollars <= 0
    ) continue;
    out.push({
      key,
      utilization: v.utilization,
      resets_at: v.resets_at,
      limit_dollars: v.limit_dollars,
      used_dollars: typeof v.used_dollars === "number" ? v.used_dollars : null,
      remaining_dollars: typeof v.remaining_dollars === "number"
        ? v.remaining_dollars
        : null,
      locked_reason: typeof v.locked_reason === "string"
        ? v.locked_reason
        : null,
    });
  }
  return out;
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

/** Last known opt-in parameter for usage-limit resets. */
export const DEFAULT_RESETS_PARAM = "cedar_ember";
const RESETS_PROBE_INTERVAL_MS = 24 * 3_600_000;

function isResetCredits(v: unknown): v is ResetCredits {
  if (!v || typeof v !== "object") return false;
  const grants = (v as { grants?: unknown }).grants;
  if (!Array.isArray(grants)) return false;
  if (grants.length === 0) return "eligible" in v;
  const g = grants[0];
  return !!g && typeof g === "object" && "resets_left" in g &&
    "ends_at" in g;
}

/**
 * Find the usage-limit resets block by its shape rather than its name, since
 * the name is an obfuscated feature flag that can change.
 */
export function findResetCredits(
  usage: Record<string, unknown>,
): { key: string; credits: ResetCredits } | null {
  for (const [key, value] of Object.entries(usage)) {
    if (isResetCredits(value)) return { key, credits: value };
  }
  return null;
}

/**
 * Opt-in parameters to try when the known one stops working. The usage
 * response lists every optional block as a top-level key — null until opted
 * into — so those keys are the candidate names.
 */
export function resetsProbeParams(usage: Record<string, unknown>): string[] {
  return Object.keys(usage).filter((k) =>
    usage[k] === null && /^[a-z0-9_]+$/.test(k)
  );
}

async function requestClaudeUsage(
  token: string,
  orgId: string,
  params: string[],
): Promise<Record<string, unknown>> {
  const query = params.length
    ? "?" + params.map((p) => encodeURIComponent(p) + "=1").join("&")
    : "";
  const res = await fetch(
    `https://claude.ai/api/organizations/${orgId}/usage${query}`,
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

/**
 * Fetch usage, including usage-limit resets when the account has them.
 *
 * If the remembered opt-in parameter no longer yields a resets block, probe
 * once a day with every candidate parameter and remember whichever key comes
 * back holding one. Probing is best-effort: its failures never fail the poll.
 */
export async function fetchClaudeUsage(
  token: string,
): Promise<ClaudeUsageResponse> {
  const orgId = await resolveClaudeOrg(token);
  const param = getClaudeResetsParam() || DEFAULT_RESETS_PARAM;
  let usage = await requestClaudeUsage(token, orgId, [param]);
  let found = findResetCredits(usage);

  if (
    !found && Date.now() - getClaudeResetsProbedAt() > RESETS_PROBE_INTERVAL_MS
  ) {
    setClaudeResetsProbedAt(Date.now());
    const candidates = resetsProbeParams(usage);
    if (candidates.length) {
      try {
        const probed = await requestClaudeUsage(token, orgId, candidates);
        const hit = findResetCredits(probed);
        if (hit) {
          usage = probed;
          found = hit;
        }
      } catch (e) {
        console.warn("[aiuse] claude resets probe failed:", e);
      }
    }
  }
  if (found && found.key !== param) setClaudeResetsParam(found.key);

  return {
    ...(usage as unknown as ClaudeUsageResponse),
    reset_credits: found?.credits ?? null,
    dollar_allowances: findDollarAllowances(usage),
  };
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
