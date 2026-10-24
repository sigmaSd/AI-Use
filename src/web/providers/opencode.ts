/**
 * OpenCode Go usage parser.
 *
 * Maps the console's `GET /console/api/go/status` JSON onto the
 * rolling/weekly/monthly windows the UI renders. The subscription carries
 * `access.meters.{fiveHour,week,month}`, each with micro-cent usage/limit
 * (serialized as strings) and an ISO `resetsAt`.
 */

export interface OCUsageWindow {
  status: string;
  resetInSec: number;
  usagePercent: number;
}

export interface OCUsageResponse {
  rollingUsage: OCUsageWindow;
  weeklyUsage: OCUsageWindow;
  monthlyUsage: OCUsageWindow;
}

interface OCMeter {
  resetsAt?: string | number | null;
  limitMicroCents?: string | number;
  usedMicroCents?: string | number;
}

function toNumber(v: string | number | undefined): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Convert one meter into a usage window, relative to `now` (ms). */
function meterWindow(meter: OCMeter | undefined, now: number): OCUsageWindow {
  const used = toNumber(meter?.usedMicroCents);
  const limit = toNumber(meter?.limitMicroCents);
  // Same rounding as the console; a full meter always reads 100.
  const usagePercent = limit <= 0
    ? 0
    : used >= limit
    ? 100
    : Math.min(99, Math.round((used * 100) / limit));

  // The five-hour window has no reset until its first request.
  const at = meter?.resetsAt == null ? NaN : new Date(meter.resetsAt).getTime();
  const resetInSec = Number.isFinite(at)
    ? Math.max(0, Math.round((at - now) / 1000))
    : 0;

  return { status: "ok", usagePercent, resetInSec };
}

/**
 * Parse the body of `/console/api/go/status`.
 * Throws when the workspace has no Go subscription or access is paused.
 */
export function parseOpenCodeUsage(
  body: unknown,
  now: number = Date.now(),
): OCUsageResponse {
  if (body === null || typeof body !== "object") {
    throw new Error(
      "no Go subscription found" +
        " — visit opencode.ai/go to subscribe first",
    );
  }
  const access = (body as { access?: unknown }).access as
    | { meters?: Record<string, OCMeter> }
    | null
    | undefined;
  if (!access || typeof access !== "object") {
    throw new Error(
      "Go subscription is paused — open opencode.ai/console to restore access",
    );
  }
  const meters = access.meters ?? {};

  return {
    rollingUsage: meterWindow(meters.fiveHour, now),
    weeklyUsage: meterWindow(meters.week, now),
    monthlyUsage: meterWindow(meters.month, now),
  };
}
