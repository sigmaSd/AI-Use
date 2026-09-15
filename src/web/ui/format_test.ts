import { assertEquals, assertMatch } from "@std/assert";
import {
  colorVar,
  fmtAgo,
  fmtCountdownReal,
  fmtMinor,
  fmtMoney,
  fmtTime,
  fmtWindow,
  statusWord,
} from "./format.ts";

Deno.test("colorVar thresholds", () => {
  assertEquals(colorVar(0), "var(--green)");
  assertEquals(colorVar(59), "var(--green)");
  assertEquals(colorVar(60), "var(--amber)");
  assertEquals(colorVar(89), "var(--amber)");
  assertEquals(colorVar(90), "var(--red)");
  assertEquals(colorVar(100), "var(--red)");
});

Deno.test("statusWord thresholds", () => {
  assertEquals(statusWord(0), "normal");
  assertEquals(statusWord(59), "normal");
  assertEquals(statusWord(60), "elevated");
  assertEquals(statusWord(89), "elevated");
  assertEquals(statusWord(90), "critical");
});

Deno.test("fmtCountdownReal units", () => {
  assertEquals(fmtCountdownReal(0), "now");
  assertEquals(fmtCountdownReal(-100), "now");
  assertEquals(fmtCountdownReal(45_000), "45s");
  assertEquals(fmtCountdownReal(150_000), "2m 30s");
  assertEquals(fmtCountdownReal(3_700_000), "1h 1m 40s");
  assertEquals(fmtCountdownReal(90_000_000), "1d 1h 0m");
});

Deno.test("fmtAgo shapes", () => {
  assertEquals(fmtAgo(null), "--");
  assertMatch(fmtAgo(new Date().toISOString()), /^updated \d+s ago$/);
  assertEquals(
    fmtAgo(new Date(Date.now() - 90_000).toISOString()),
    "updated 1m ago",
  );
  assertEquals(
    fmtAgo(new Date(Date.now() - 3_700_000).toISOString()),
    "updated 1h 1m ago",
  );
});

Deno.test("fmtTime returns a non-empty localized string", () => {
  const s = fmtTime("2026-09-15T07:00:00.000Z");
  assertEquals(typeof s, "string");
  assertEquals(s.length > 0 && s !== "Invalid Date", true);
});

Deno.test("fmtMinor minor-unit conversion", () => {
  assertEquals(fmtMinor(12345, 2, "USD"), "$123.45");
  assertEquals(fmtMinor(500, 0, "EUR"), "EUR 500");
  assertEquals(fmtMinor(100, null, undefined), " 1.00");
});

Deno.test("fmtMoney rounding", () => {
  assertEquals(fmtMoney(10.5, 2, "USD"), "$10.50");
  assertEquals(fmtMoney(10.567, null, "USD"), "$10.57");
  assertEquals(fmtMoney(10.5, 2, "EUR"), "EUR 10.50");
});

Deno.test("fmtWindow labels", () => {
  assertEquals(fmtWindow(0), "usage window");
  assertEquals(fmtWindow(604800), "1-week window");
  assertEquals(fmtWindow(86400), "1-day window");
  assertEquals(fmtWindow(3600), "1-hour window");
  assertEquals(fmtWindow(1800), "30m 0s window");
});
