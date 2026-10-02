import { assertEquals } from "@std/assert";
import {
  findDollarAllowances,
  findResetCredits,
  resetsProbeParams,
} from "./claude.ts";

// Trimmed from a real `/usage?cedar_ember=1` response (Oct 2026).
const usage: Record<string, unknown> = {
  five_hour: { utilization: 30, resets_at: "2026-10-02T20:29:59Z" },
  seven_day: { utilization: 0, resets_at: "2026-10-09T16:59:59Z" },
  seven_day_opus: null,
  nimbus_quill: null,
  iguana_necktie: {
    utilization: 0.0,
    resets_at: "2026-11-05T07:59:00+00:00",
    limit_dollars: 250,
    used_dollars: 0.0,
    remaining_dollars: 250.0,
    locked_reason: null,
  },
  cedar_ember: {
    eligible: true,
    ineligible_reason: null,
    at_limit: false,
    grants: [{
      id: "opus55-launch-promax-20260921",
      resets_total: 1,
      resets_left: 1,
      ends_at: "2026-10-22T16:00:00+00:00",
    }],
    cooldown_until: null,
  },
  limits: [{ kind: "session", percent: 30 }],
  spend: null,
};

Deno.test("findResetCredits: found by shape, not name", () => {
  assertEquals(findResetCredits(usage)?.key, "cedar_ember");
  const renamed = {
    ...usage,
    cedar_ember: null,
    copper_kite: usage.cedar_ember,
  };
  assertEquals(findResetCredits(renamed)?.key, "copper_kite");
});

Deno.test("findResetCredits: eligible account with no grants yet", () => {
  const found = findResetCredits({
    ...usage,
    cedar_ember: { eligible: true, grants: [], cooldown_until: null },
  });
  assertEquals(found?.key, "cedar_ember");
  assertEquals(found?.credits.grants, []);
});

Deno.test("findResetCredits: absent", () => {
  assertEquals(findResetCredits({ ...usage, cedar_ember: null }), null);
});

Deno.test("resetsProbeParams: every null top-level key", () => {
  assertEquals(
    resetsProbeParams({ ...usage, cedar_ember: null }),
    ["seven_day_opus", "nimbus_quill", "cedar_ember", "spend"],
  );
});

Deno.test("findDollarAllowances: found by shape, not name", () => {
  const [a, ...rest] = findDollarAllowances(usage);
  assertEquals(rest, []);
  assertEquals(a.key, "iguana_necktie");
  assertEquals(a.limit_dollars, 250);
  assertEquals(a.remaining_dollars, 250);
  const renamed = {
    ...usage,
    iguana_necktie: null,
    brass_thimble: usage.iguana_necktie,
  };
  assertEquals(findDollarAllowances(renamed)[0].key, "brass_thimble");
});

Deno.test("findDollarAllowances: skips the main windows and non-dollar ones", () => {
  assertEquals(
    findDollarAllowances({
      five_hour: { utilization: 1, resets_at: "x", limit_dollars: 5 },
      seven_day_opus: { utilization: 1, resets_at: "x", limit_dollars: null },
      tangelo: null,
    }),
    [],
  );
});
