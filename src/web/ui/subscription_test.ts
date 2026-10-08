import { assertEquals } from "@std/assert";
import {
  chatgptSubscription,
  claudeSubscription,
  toIso,
} from "./subscription.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");

// Trimmed from a real `subscription_details` response (Oct 2026).
const claudeActive = {
  plan_ending_before: null,
  plan_ending_at: null,
  next_charge_date: "2026-10-17",
  next_charge_at: "2026-10-17T13:24:14Z",
  status: "active",
  billing_interval: "monthly",
  trial_end_ts: null,
};

Deno.test("toIso: ISO, date-only, unix seconds and ms", () => {
  assertEquals(toIso("2026-10-17T13:24:14Z"), "2026-10-17T13:24:14.000Z");
  assertEquals(toIso("2026-10-17"), "2026-10-17T00:00:00.000Z");
  assertEquals(toIso(1792243454), "2026-10-17T13:24:14.000Z");
  assertEquals(toIso("1792243454000"), "2026-10-17T13:24:14.000Z");
  assertEquals(toIso(null), null);
  assertEquals(toIso("nonsense"), null);
});

Deno.test("claudeSubscription: active plan renews on next charge", () => {
  assertEquals(claudeSubscription(claudeActive, NOW), {
    kind: "renews",
    at: "2026-10-17T13:24:14.000Z",
    interval: "monthly",
    urgency: "calm",
    warning: null,
  });
});

Deno.test("claudeSubscription: cancelled plan ends, urgent when close", () => {
  const v = claudeSubscription({
    ...claudeActive,
    next_charge_at: null,
    plan_ending_at: "2026-10-09T13:24:14Z",
  }, NOW);
  assertEquals(v?.kind, "ends");
  assertEquals(v?.urgency, "urgent");
});

Deno.test("claudeSubscription: past due surfaces a warning", () => {
  const v = claudeSubscription({ ...claudeActive, status: "past_due" }, NOW);
  assertEquals(v?.warning, "Billing status: past due");
});

Deno.test("claudeSubscription: no details → null", () => {
  assertEquals(claudeSubscription(null, NOW), null);
  assertEquals(claudeSubscription({ status: "active" }, NOW), null);
});

// Field set from a real free-account accounts/check entitlement (Oct 2026).
const chatgptFree = {
  entitlement: {
    has_active_subscription: false,
    subscription_plan: "chatgptfreeplan",
    expires_at: null,
    renews_at: null,
    cancels_at: null,
    billing_period: null,
    is_delinquent: false,
    grace_period_end_timestamp: null,
  },
  last_active_subscription: { will_renew: false },
};

Deno.test("chatgptSubscription: free account → null", () => {
  assertEquals(chatgptSubscription(chatgptFree, NOW), null);
});

Deno.test("chatgptSubscription: paid account renews", () => {
  const v = chatgptSubscription({
    entitlement: {
      ...chatgptFree.entitlement,
      has_active_subscription: true,
      renews_at: "2026-11-01T00:00:00Z",
      expires_at: "2026-11-01T00:00:00Z",
      billing_period: "monthly",
    },
    last_active_subscription: { will_renew: true },
  }, NOW);
  assertEquals(v?.kind, "renews");
  assertEquals(v?.at, "2026-11-01T00:00:00.000Z");
  assertEquals(v?.interval, "monthly");
});

Deno.test("chatgptSubscription: won't renew → ends at expiry", () => {
  const v = chatgptSubscription({
    entitlement: {
      ...chatgptFree.entitlement,
      has_active_subscription: true,
      expires_at: "2026-10-13T00:00:00Z",
    },
    last_active_subscription: { will_renew: false },
  }, NOW);
  assertEquals(v?.kind, "ends");
  assertEquals(v?.urgency, "soon");
});

Deno.test("chatgptSubscription: cancels_at wins over renews_at", () => {
  const v = chatgptSubscription({
    entitlement: {
      ...chatgptFree.entitlement,
      has_active_subscription: true,
      renews_at: "2026-11-01T00:00:00Z",
      cancels_at: "2026-11-01T00:00:00Z",
    },
  }, NOW);
  assertEquals(v?.kind, "ends");
});
