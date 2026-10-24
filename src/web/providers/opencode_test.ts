import { assertEquals, assertThrows } from "@std/assert";
import { parseOpenCodeUsage } from "./opencode.ts";

const NOW = Date.parse("2026-10-24T00:00:00Z");

// ---------- helper: build a /console/api/go/status body ----------
function status(meters: Record<string, unknown>): unknown {
  return {
    subscriberUserId: "usr_test",
    product: "go",
    renewalProduct: "go",
    useBalance: false,
    cancelAtPeriodEnd: false,
    renewalPending: false,
    access: {
      startsAt: "2026-10-01T00:00:00.000Z",
      endsAt: "2026-11-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      meters,
    },
  };
}

function meter(used: string, limit: string, resetsAt: string | null) {
  return { resetsAt, limitMicroCents: limit, usedMicroCents: used };
}

// ---------- tests ----------

Deno.test("maps fiveHour/week/month meters onto windows", () => {
  const r = parseOpenCodeUsage(
    status({
      fiveHour: meter("180000000", "1200000000", "2026-10-24T04:00:00.000Z"),
      week: meter("180000000", "3000000000", "2026-10-26T00:00:00.000Z"),
      month: meter("180000000", "6000000000", "2026-11-01T00:00:00.000Z"),
    }),
    NOW,
  );

  assertEquals(r.rollingUsage.usagePercent, 15);
  assertEquals(r.rollingUsage.resetInSec, 4 * 3600);
  assertEquals(r.weeklyUsage.usagePercent, 6);
  assertEquals(r.weeklyUsage.resetInSec, 2 * 86400);
  assertEquals(r.monthlyUsage.usagePercent, 3);
  assertEquals(r.monthlyUsage.resetInSec, 8 * 86400);
});

Deno.test("five-hour window not started yet has no reset", () => {
  const r = parseOpenCodeUsage(
    status({ fiveHour: meter("0", "1200000000", null) }),
    NOW,
  );

  assertEquals(r.rollingUsage.usagePercent, 0);
  assertEquals(r.rollingUsage.resetInSec, 0);
});

Deno.test("exhausted meter reads 100, nearly full stays below", () => {
  const r = parseOpenCodeUsage(
    status({
      fiveHour: meter("1200000000", "1200000000", "2026-10-24T01:00:00Z"),
      week: meter("2999999999", "3000000000", "2026-10-26T00:00:00Z"),
    }),
    NOW,
  );

  assertEquals(r.rollingUsage.usagePercent, 100);
  assertEquals(r.weeklyUsage.usagePercent, 99);
});

Deno.test("numeric micro-cents and past resets are tolerated", () => {
  const r = parseOpenCodeUsage(
    status({
      month: {
        resetsAt: "2026-10-23T00:00:00Z",
        limitMicroCents: 1000,
        usedMicroCents: 250,
      },
    }),
    NOW,
  );

  assertEquals(r.monthlyUsage.usagePercent, 25);
  assertEquals(r.monthlyUsage.resetInSec, 0);
});

Deno.test("missing meters fall back to 0", () => {
  const r = parseOpenCodeUsage(status({}), NOW);

  assertEquals(r.rollingUsage.usagePercent, 0);
  assertEquals(r.weeklyUsage.resetInSec, 0);
});

Deno.test("throws when there is no subscription", () => {
  assertThrows(
    () => parseOpenCodeUsage(null, NOW),
    Error,
    "no Go subscription found",
  );
});

Deno.test("throws when access is paused", () => {
  assertThrows(
    () => parseOpenCodeUsage({ product: "go", access: null }, NOW),
    Error,
    "paused",
  );
});

Deno.test("carries the paid period end and renewal state", () => {
  const r = parseOpenCodeUsage(status({}), NOW);

  assertEquals(r.subscription, {
    endsAt: "2026-11-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    renewalRetryAt: null,
    renewalAuthorizationRequired: false,
  });
});
