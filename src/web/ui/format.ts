/**
 * Pure formatting helpers for the dashboard UI (extracted from main.js).
 *
 * Deliberately DOM-free so they stay unit-testable — everything here is a
 * total function of its arguments (fmtAgo reads the clock, like before).
 */

export function colorVar(pct: number): string {
  if (pct >= 90) return "var(--red)";
  if (pct >= 60) return "var(--amber)";
  return "var(--green)";
}

export function statusWord(pct: number): string {
  if (pct >= 90) return "critical";
  if (pct >= 60) return "elevated";
  return "normal";
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtCountdownReal(ms: number): string {
  if (ms <= 0) return "now";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return d + "d " + h + "h " + m + "m";
  if (h > 0) return h + "h " + m + "m " + s + "s";
  if (m > 0) return m + "m " + s + "s";
  return s + "s";
}

export function fmtAgo(iso: string | null): string {
  if (!iso) return "--";
  const sec = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return "updated " + d + "d " + h + "h ago";
  if (h > 0) return "updated " + h + "h " + m + "m ago";
  if (m > 0) return "updated " + m + "m ago";
  return "updated " + sec + "s ago";
}

export function fmtMinor(
  amountMinor: number,
  decimalPlaces?: number | null,
  currency?: string | null,
): string {
  const places = decimalPlaces == null ? 2 : decimalPlaces;
  const symbol = currency === "USD" ? "$" : (currency || "") + " ";
  return symbol + (Number(amountMinor) / Math.pow(10, places)).toFixed(places);
}

export function fmtMoney(
  amount: number,
  decimalPlaces?: number | null,
  currency?: string | null,
): string {
  const symbol = currency === "USD" ? "$" : (currency || "") + " ";
  return symbol +
    Number(amount).toFixed(decimalPlaces == null ? 2 : decimalPlaces);
}

export function fmtWindow(seconds: number): string {
  if (!seconds) return "usage window";
  if (seconds % 604800 === 0) return (seconds / 604800) + "-week window";
  if (seconds % 86400 === 0) return (seconds / 86400) + "-day window";
  if (seconds % 3600 === 0) return (seconds / 3600) + "-hour window";
  return fmtCountdownReal(seconds * 1000) + " window";
}
