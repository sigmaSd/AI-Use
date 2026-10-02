import { assertEquals, assertMatch } from "@std/assert";
import type { ClaudeUsageResponse } from "../providers/claude.ts";
import type {
  ChatGPTResetCreditsResponse,
  ChatGPTUsageResponse,
} from "../providers/chatgpt.ts";
import {
  chatgptResetCards,
  claudeResetCards,
  expiryUrgency,
  findChatGPTCreditList,
} from "./resets.ts";

const NOW = Date.parse("2026-10-02T18:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function claudeUsage(
  opts: { weekly?: number; session?: number; endsIn?: number } = {},
): ClaudeUsageResponse {
  return {
    five_hour: { utilization: opts.session ?? 30, resets_at: iso(2 * HOUR) },
    seven_day: { utilization: opts.weekly ?? 0, resets_at: iso(7 * DAY) },
    reset_credits: {
      eligible: true,
      ineligible_reason: null,
      cooldown_until: null,
      grants: [{
        id: "opus55-launch-promax-20260921",
        label: "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
        resets_total: 1,
        resets_left: 1,
        starts_at: "2026-09-22T16:00:00+00:00",
        ends_at: iso(opts.endsIn ?? 20 * DAY),
        clears: ["five_hour", "seven_day"],
        paused: false,
        usable_now: true,
        use_requires_limit: false,
      }],
    },
  };
}

Deno.test("expiryUrgency thresholds", () => {
  assertEquals(expiryUrgency(null, NOW), "calm");
  assertEquals(expiryUrgency(iso(DAY), NOW), "urgent");
  assertEquals(expiryUrgency(iso(5 * DAY), NOW), "soon");
  assertEquals(expiryUrgency(iso(20 * DAY), NOW), "calm");
});

Deno.test("claude: no reset block means no cards", () => {
  const u = claudeUsage();
  delete u.reset_credits;
  assertEquals(claudeResetCards(u, NOW), []);
  assertEquals(claudeResetCards(null, NOW), []);
});

Deno.test("claude: low usage, far expiry → save it", () => {
  const [card] = claudeResetCards(claudeUsage(), NOW);
  assertEquals(card.left, 1);
  assertEquals(card.total, 1);
  assertEquals(card.urgency, "calm");
  assertEquals(card.adviceTone, "hold");
  assertMatch(card.advice, /Save it/);
});

Deno.test("claude: weekly near limit, days to refill → use it", () => {
  const [card] = claudeResetCards(claudeUsage({ weekly: 92 }), NOW);
  assertEquals(card.adviceTone, "go");
  assertMatch(card.advice, /weekly is at 92%/);
});

Deno.test("claude: session near limit but refills soon → hold", () => {
  const [card] = claudeResetCards(claudeUsage({ session: 95 }), NOW);
  assertEquals(card.adviceTone, "hold");
  assertMatch(card.advice, /refills on its own/);
});

Deno.test("claude: about to expire → urgent, use it", () => {
  const [card] = claudeResetCards(claudeUsage({ endsIn: 10 * HOUR }), NOW);
  assertEquals(card.urgency, "urgent");
  assertEquals(card.adviceTone, "go");
  assertMatch(card.advice, /Expires in 10h/);
});

Deno.test("claude: expired or spent grants are dropped", () => {
  const expired = claudeUsage({ endsIn: -HOUR });
  assertEquals(claudeResetCards(expired, NOW), []);
  const spent = claudeUsage();
  spent.reset_credits!.grants[0].resets_left = 0;
  assertEquals(claudeResetCards(spent, NOW), []);
});

Deno.test("claude: cooldown blocks use", () => {
  const u = claudeUsage({ weekly: 95 });
  u.reset_credits!.cooldown_until = iso(3 * HOUR);
  const [card] = claudeResetCards(u, NOW);
  assertEquals(card.adviceTone, "blocked");
  assertMatch(card.advice, /cooldown/);
});

const chatgpt: ChatGPTUsageResponse = {
  plan_type: "prolite",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 92,
      limit_window_seconds: 604800,
      reset_after_seconds: 84410,
      reset_at: Math.floor((NOW + 84410_000) / 1000),
    },
    secondary_window: null,
  },
  rate_limit_reset_credits: {
    available_count: 3,
    applicable_available_count: 0,
  },
};

Deno.test("chatgpt: 3 held, none applicable → blocked", () => {
  const [card] = chatgptResetCards(chatgpt, null, NOW);
  assertEquals(card.left, 3);
  assertEquals(card.expiresAt, null);
  assertEquals(card.adviceTone, "blocked");
  assertEquals(card.detail, "0 of 3 usable now");
});

Deno.test("chatgpt: applicable, weekly high, refills in <1d → hold", () => {
  const u = structuredClone(chatgpt);
  u.rate_limit_reset_credits!.applicable_available_count = 3;
  const [card] = chatgptResetCards(u, null, NOW);
  assertEquals(card.adviceTone, "hold");
  assertEquals(card.detail, null);
});

Deno.test("chatgpt: applicable, weekly high, days to refill → use it", () => {
  const u = structuredClone(chatgpt);
  u.rate_limit_reset_credits!.applicable_available_count = 3;
  u.rate_limit!.primary_window!.reset_at = Math.floor((NOW + 4 * DAY) / 1000);
  const [card] = chatgptResetCards(u, null, NOW);
  assertEquals(card.adviceTone, "go");
});

Deno.test("chatgpt: none held → no card", () => {
  const u = structuredClone(chatgpt);
  u.rate_limit_reset_credits = { available_count: 0 };
  assertEquals(chatgptResetCards(u, null, NOW), []);
});

function credit(expiresIn: number, status = "available") {
  return {
    id: "RateLimitResetCredit_" + expiresIn,
    reset_type: "codex_rate_limits",
    is_supported_by_plan: true,
    status,
    expires_at: iso(expiresIn),
    title: "Full reset",
  };
}

Deno.test("chatgpt: gift credits give the soonest expiry", () => {
  const credits: ChatGPTResetCreditsResponse = {
    available_count: 3,
    credits: [credit(20 * DAY), credit(2.4 * DAY), credit(27 * DAY)],
  };
  const [card] = chatgptResetCards(chatgpt, credits, NOW);
  assertEquals(card.left, 3);
  assertEquals(card.expiresAt, iso(2.4 * DAY));
  assertEquals(card.urgency, "soon");
  assertMatch(card.detail ?? "", /^0 of 3 usable now · then /);
});

Deno.test("chatgpt: redeemed and expired credits don't count", () => {
  const credits: ChatGPTResetCreditsResponse = {
    credits: [credit(-HOUR), credit(5 * DAY, "redeemed"), credit(HOUR * 30)],
  };
  const u = structuredClone(chatgpt);
  u.rate_limit_reset_credits!.applicable_available_count = 1;
  const [card] = chatgptResetCards(u, credits, NOW);
  assertEquals(card.left, 1);
  assertEquals(card.urgency, "urgent");
  assertEquals(card.adviceTone, "go");
});

Deno.test("chatgpt: credits without expiry still count", () => {
  const c = credit(0);
  c.expires_at = null as unknown as string;
  const [card] = chatgptResetCards(chatgpt, { credits: [c] }, NOW);
  assertEquals(card.left, 1);
  assertEquals(card.expiresAt, null);
});

Deno.test("chatgpt: a failed expiry lookup says why", () => {
  const [card] = chatgptResetCards(chatgpt, null, NOW, "request failed: 403");
  assertEquals(card.left, 3);
  assertEquals(card.warning, "Expiry unavailable: request failed: 403");
});

Deno.test("findChatGPTCreditList: top-level, renamed, nested, absent", () => {
  const list = [credit(DAY), credit(2 * DAY)];
  assertEquals(findChatGPTCreditList({ credits: list }), list);
  assertEquals(findChatGPTCreditList({ items: list, n: 2 }), list);
  assertEquals(findChatGPTCreditList({ data: { resets: list } }), list);
  assertEquals(findChatGPTCreditList({ credits: [] }), []);
  assertEquals(findChatGPTCreditList({ detail: "nope" }), null);
});

Deno.test("chatgpt: unexpected reply names its fields", () => {
  const credits = { detail: "nope" } as unknown as ChatGPTResetCreditsResponse;
  const [card] = chatgptResetCards(chatgpt, credits, NOW);
  assertEquals(card.left, 3);
  assertEquals(
    card.warning,
    "Expiry unavailable: unexpected reply (fields: detail)",
  );
});
