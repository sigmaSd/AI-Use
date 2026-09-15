/// <reference lib="dom" />
/**
 * Client for the desktop pairing routes (see report.ts + host/pairing.ts).
 *
 * The only module that knows the /api/pair/* paths, the poll cadence, and
 * the TTL — callers (web/src/share/modal.ts) deal in publish/poll/expire,
 * never URLs or timers. These routes are desktop-only: there is no Deno
 * server behind the page on Android, so a same-origin fetch here only
 * ever succeeds on desktop.
 */

/** Matches host/pairing.ts's own TTL — the server is authoritative; this is
 *  only so the UI can show a countdown and stop polling at roughly the same
 *  time the server would actually expire the code. */
export const PAIRING_TTL_MS = 2 * 60_000;

const POLL_INTERVAL_MS = 1500;

function randomCode(): string {
  // 8 bytes (64 bits) is enough entropy for a same-LAN, single-use code
  // with a two-minute lifetime, while keeping the QR easy to scan.
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Store `payload` for one-time phone retrieval; resolves with the QR URL. */
export async function publishShare(
  payload: unknown,
): Promise<{ code: string; url: string }> {
  const code = randomCode();
  const res = await fetch("/api/pair/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, payload }),
  });
  const data = await res.json() as {
    ok?: boolean;
    url?: string;
    error?: string;
  };
  if (!res.ok || !data.ok || typeof data.url !== "string") {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return { code, url: data.url };
}

/**
 * Poll until the phone redeems `code`, then call `onClaimed` once.
 * Returns a stop function for modal teardown (cancel button, expiry).
 */
export function pollShareStatus(
  code: string,
  onClaimed: () => void,
): () => void {
  const timer = setInterval(async () => {
    const s = await fetch(`/api/pair/status/${code}`).then((r) => r.json())
      .catch(() => null) as { status?: string } | null;
    if (s?.status === "claimed-or-unknown") {
      clearInterval(timer);
      onClaimed();
    }
  }, POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}
