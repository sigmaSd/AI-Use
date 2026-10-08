/**
 * Subscription renewal / end date — DOM-free view model.
 *
 * Paid plans either renew on their own (next charge date) or, once
 * cancelled, run out on a fixed date. Either way the date is worth having in
 * view so a renewal is never a surprise and a lapse is never missed.
 */

import type { ClaudeSubscriptionDetails } from "../providers/claude.ts";
import type { ChatGPTAccountCheck } from "../providers/chatgpt.ts";
import { expiryUrgency, type ResetUrgency } from "./resets.ts";

/** renews = will charge again; ends = cancelled, access stops; trial = trial ends. */
export type SubscriptionKind = "renews" | "ends" | "trial";

export interface SubscriptionView {
  kind: SubscriptionKind;
  /** ISO time of the renewal / end. */
  at: string;
  /** Billing period as reported, e.g. "monthly". */
  interval: string | null;
  /** Renewals are routine; endings get amber/red as they approach. */
  urgency: ResetUrgency;
  /** Billing problem the provider reports, if any. */
  warning: string | null;
}

/** ISO string, date-only string, or unix seconds/ms → ISO, else null. */
export function toIso(v: string | number | null | undefined): string | null {
  if (v == null || v === "") return null;
  let n: number | null = typeof v === "number" ? v : null;
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) n = Number(v);
  const d = n != null ? new Date(n < 1e12 ? n * 1000 : n) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function view(
  kind: SubscriptionKind,
  at: string,
  interval: string | null | undefined,
  warning: string | null,
  now: number,
): SubscriptionView {
  return {
    kind,
    at,
    interval: interval || null,
    urgency: kind === "renews" ? "calm" : expiryUrgency(at, now),
    warning,
  };
}

export function claudeSubscription(
  d: ClaudeSubscriptionDetails | null,
  now = Date.now(),
): SubscriptionView | null {
  if (!d) return null;
  const status = d.status ?? null;
  const warning = status && !["active", "trialing"].includes(status)
    ? "Billing status: " + status.replace(/_/g, " ")
    : null;

  const ends = toIso(d.plan_ending_at) ?? toIso(d.plan_ending_before);
  if (ends) return view("ends", ends, d.billing_interval, warning, now);
  const trial = toIso(d.trial_end_ts);
  if (trial) return view("trial", trial, d.billing_interval, warning, now);
  const next = toIso(d.next_charge_at) ?? toIso(d.next_charge_date);
  if (next) return view("renews", next, d.billing_interval, warning, now);
  return null;
}

export function chatgptSubscription(
  check: ChatGPTAccountCheck | null,
  now = Date.now(),
): SubscriptionView | null {
  const e = check?.entitlement;
  if (!e || !e.has_active_subscription) return null;
  const warning = e.is_delinquent
    ? "Payment overdue" +
      (toIso(e.grace_period_end_timestamp)
        ? " — grace period ends " +
          new Date(toIso(e.grace_period_end_timestamp)!).toLocaleDateString()
        : "")
    : null;

  const cancels = toIso(e.cancels_at);
  if (cancels) return view("ends", cancels, e.billing_period, warning, now);
  const expires = toIso(e.expires_at);
  if (check?.last_active_subscription?.will_renew === false && expires) {
    return view("ends", expires, e.billing_period, warning, now);
  }
  const renews = toIso(e.renews_at) ?? expires;
  if (renews) return view("renews", renews, e.billing_period, warning, now);
  return null;
}

export function subscriptionVerb(kind: SubscriptionKind): string {
  if (kind === "ends") return "Plan ends";
  if (kind === "trial") return "Trial ends";
  return "Renews";
}
