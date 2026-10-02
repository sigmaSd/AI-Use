/**
 * Usage-limit resets ("Reset for free") — DOM-free view model.
 *
 * Both providers hand out a small number of resets that wipe your current
 * limit windows. They are worth the most when you are near a limit that would
 * otherwise take days to refill, and worth nothing once they expire unused.
 * This module turns the raw API blocks into cards that say how many you have,
 * how close they are to expiring, and whether now is a good moment to spend
 * one.
 */

import type { ClaudeUsageResponse } from "../providers/claude.ts";
import type {
  ChatGPTResetCredit,
  ChatGPTResetCreditsResponse,
  ChatGPTUsageResponse,
  ChatGPTUsageWindow,
} from "../providers/chatgpt.ts";
import { fmtCountdownReal } from "./format.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Expiry closer than this is "urgent" (red). */
export const EXPIRY_URGENT_MS = 2 * DAY;
/** Expiry closer than this is "soon" (amber). */
export const EXPIRY_SOON_MS = 7 * DAY;
/** A limit at or above this percent is "near the limit". */
export const HIGH_USAGE_PCT = 80;
/** A natural refill closer than this isn't worth spending a reset on. */
export const NATURAL_RESET_SOON_MS = DAY;

export type ResetUrgency = "urgent" | "soon" | "calm";
/** go = good moment to use one, hold = better to wait, blocked = can't now. */
export type ResetAdviceTone = "go" | "hold" | "blocked";

export interface ResetCard {
  provider: "claude" | "chatgpt";
  /** Resets still available. */
  left: number;
  /** Total granted, when the provider reports it. */
  total: number | null;
  /** ISO time the unused resets expire, when known. */
  expiresAt: string | null;
  urgency: ResetUrgency;
  advice: string;
  adviceTone: ResetAdviceTone;
  /** Provider's own description of the grant, if any. */
  detail: string | null;
  /** Why some of the card's data is missing, if it is. */
  warning: string | null;
}

/** The window a reset would rescue you from: the fullest one. */
interface Pressure {
  name: string;
  pct: number;
  resetAt: string | null;
}

export function expiryUrgency(
  expiresAt: string | null,
  now: number,
): ResetUrgency {
  if (!expiresAt) return "calm";
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= EXPIRY_URGENT_MS) return "urgent";
  if (ms <= EXPIRY_SOON_MS) return "soon";
  return "calm";
}

function advise(
  pressure: Pressure | null,
  expiresAt: string | null,
  now: number,
): { advice: string; adviceTone: ResetAdviceTone } {
  const refillMs = pressure?.resetAt
    ? new Date(pressure.resetAt).getTime() - now
    : null;
  const high = pressure != null && pressure.pct >= HIGH_USAGE_PCT;
  const refillsSoon = refillMs != null && refillMs <= NATURAL_RESET_SOON_MS;

  if (high && !refillsSoon && pressure) {
    const when = refillMs != null
      ? ", refills on its own in " + fmtCountdownReal(refillMs)
      : "";
    return {
      advice: "Good time to use one: " + pressure.name + " is at " +
        Math.round(pressure.pct) + "%" + when + ".",
      adviceTone: "go",
    };
  }
  if (expiryUrgency(expiresAt, now) === "urgent" && expiresAt) {
    return {
      advice: "Expires in " +
        fmtCountdownReal(new Date(expiresAt).getTime() - now) +
        " — use it before then or lose it.",
      adviceTone: "go",
    };
  }
  if (high && refillsSoon && pressure && refillMs != null) {
    return {
      advice: "Hold: " + pressure.name + " refills on its own in " +
        fmtCountdownReal(refillMs) + ".",
      adviceTone: "hold",
    };
  }
  return {
    advice: "Save it for when you hit a limit.",
    adviceTone: "hold",
  };
}

function claudePressure(usage: ClaudeUsageResponse): Pressure | null {
  const candidates: Pressure[] = [];
  if (usage.seven_day) {
    candidates.push({
      name: "weekly",
      pct: usage.seven_day.utilization,
      resetAt: usage.seven_day.resets_at,
    });
  }
  if (usage.five_hour) {
    candidates.push({
      name: "5-hour session",
      pct: usage.five_hour.utilization,
      resetAt: usage.five_hour.resets_at,
    });
  }
  return fullest(candidates);
}

function chatgptPressure(usage: ChatGPTUsageResponse): Pressure | null {
  const candidates: Pressure[] = [];
  const add = (win: ChatGPTUsageWindow | null | undefined) => {
    if (!win) return;
    let resetAt: string | null = null;
    if (win.reset_at != null) {
      resetAt = new Date(win.reset_at * 1000).toISOString();
    }
    candidates.push({
      name: windowName(win.limit_window_seconds),
      pct: Number(win.used_percent || 0),
      resetAt,
    });
  };
  add(usage.rate_limit?.primary_window);
  add(usage.rate_limit?.secondary_window);
  return fullest(candidates);
}

function windowName(seconds: number): string {
  if (seconds >= 604800) return "weekly";
  if (seconds >= 86400) return "daily";
  if (seconds > 0) return Math.round(seconds / 3600) + "-hour";
  return "usage";
}

function fullest(list: Pressure[]): Pressure | null {
  let best: Pressure | null = null;
  for (const p of list) if (!best || p.pct > best.pct) best = p;
  return best;
}

export function claudeResetCards(
  usage: ClaudeUsageResponse | null,
  now: number = Date.now(),
): ResetCard[] {
  const credits = usage?.reset_credits;
  if (!usage || !credits || !Array.isArray(credits.grants)) return [];
  const pressure = claudePressure(usage);
  const cooldownMs = credits.cooldown_until
    ? new Date(credits.cooldown_until).getTime() - now
    : 0;

  return credits.grants
    .filter((g) => g.resets_left > 0 && new Date(g.ends_at).getTime() > now)
    .sort((a, b) =>
      new Date(a.ends_at).getTime() - new Date(b.ends_at).getTime()
    )
    .map((g) => {
      let tone = advise(pressure, g.ends_at, now);
      if (cooldownMs > 0) {
        tone = {
          advice: "On cooldown for " + fmtCountdownReal(cooldownMs) + ".",
          adviceTone: "blocked",
        };
      } else if (g.paused || !g.usable_now) {
        tone = {
          advice: g.use_requires_limit
            ? "Usable once you hit a limit."
            : "Not usable right now.",
          adviceTone: "blocked",
        };
      }
      return {
        provider: "claude",
        left: g.resets_left,
        total: g.resets_total,
        expiresAt: g.ends_at,
        urgency: expiryUrgency(g.ends_at, now),
        detail: g.label || null,
        warning: null,
        ...tone,
      };
    });
}

function fmtShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * The list of resets in a rate-limit-reset-credits reply: `credits` today,
 * but found by shape (items carrying `expires_at` + `status`) so a renamed
 * or nested list still works.
 */
export function findChatGPTCreditList(
  reply: unknown,
  depth = 0,
): ChatGPTResetCredit[] | null {
  if (!reply || typeof reply !== "object" || depth > 2) return null;
  const isList = (v: unknown) =>
    Array.isArray(v) &&
    v.every((c) =>
      c && typeof c === "object" && "status" in c && "expires_at" in c
    );
  const obj = reply as Record<string, unknown>;
  if (isList(obj.credits)) return obj.credits as ChatGPTResetCredit[];
  for (const v of Object.values(obj)) {
    if (isList(v) && (v as unknown[]).length > 0) {
      return v as ChatGPTResetCredit[];
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const found = findChatGPTCreditList(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * One card for all ChatGPT resets, keyed to the soonest expiry. `credits`
 * (the gift-credits list) supplies expiries; wham/usage's counts are the
 * fallback when that request failed.
 */
export function chatgptResetCards(
  usage: ChatGPTUsageResponse | null,
  credits: ChatGPTResetCreditsResponse | null,
  now: number = Date.now(),
  creditsError: string | null = null,
): ResetCard[] {
  const counts = usage?.rate_limit_reset_credits;
  const list = credits ? findChatGPTCreditList(credits) : null;
  const available = (list ?? []).filter((c) =>
    c.status === "available" && c.is_supported_by_plan !== false &&
    (!c.expires_at || new Date(c.expires_at).getTime() > now)
  );
  const expiries = available
    .flatMap((c) => c.expires_at ? [c.expires_at] : [])
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  const left = list ? available.length : counts?.available_count ?? 0;
  if (left <= 0) return [];
  const usable = counts?.applicable_available_count ?? left;
  const expiresAt = expiries[0] ?? null;

  let tone = advise(usage ? chatgptPressure(usage) : null, expiresAt, now);
  if (usable <= 0) {
    tone = {
      advice: "None usable right now — likely needs a limit to be hit first.",
      adviceTone: "blocked",
    };
  }
  const detail: string[] = [];
  if (usable < left) detail.push(usable + " of " + left + " usable now");
  if (expiries.length > 1) {
    detail.push("then " + expiries.slice(1).map(fmtShortDate).join(", "));
  }
  let warning: string | null = null;
  if (creditsError) {
    warning = "Expiry unavailable: " + creditsError;
  } else if (credits && !list) {
    warning = "Expiry unavailable: unexpected reply (fields: " +
      Object.keys(credits).join(", ") + ")";
  }
  return [{
    provider: "chatgpt",
    left,
    total: null,
    expiresAt,
    urgency: expiryUrgency(expiresAt, now),
    detail: detail.length ? detail.join(" · ") : null,
    warning,
    ...tone,
  }];
}
