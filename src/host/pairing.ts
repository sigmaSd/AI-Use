/**
 * The local pairing server: a second Deno.serve(), separate from the one
 * `deno desktop` auto-wires to the WebView.
 *
 * That auto-wired server is forced to bind loopback-only, no matter what
 * hostname you ask for — confirmed by reading Deno's own network binding
 * code and verified empirically (docs.deno.com/runtime/desktop/serving/).
 * But that restriction turned out to apply only to the *first*, auto-
 * detected `Deno.serve()` call in the process — a second, explicit call
 * (verified live, port 0, bound 0.0.0.0, reached from a phone on the same
 * WiFi) binds normally.
 *
 * It exists to replace the original QR design (the credentials themselves,
 * chunked across dozens of animated QR frames) with something both simpler
 * and more secure: the QR now encodes a URL to this server, and the actual
 * secrets travel over a real HTTP response instead of being photographable
 * off a screen. A screenshot of the QR is useless once the code is consumed
 * or its short TTL expires — unlike a QR that carried the credentials
 * directly, which never expired.
 *
 * The server is strictly on-demand: it binds only while at least one code
 * is outstanding (from `publish` until that code is claimed, expires, or
 * the app exits) and shuts down as soon as the last one resolves. Nothing
 * listens on the LAN the rest of the time. The share-status polling the
 * desktop UI does (`/api/pair/status/<code>`) is answered by the main
 * loopback server from the same in-memory map, so it keeps working whether
 * or not the LAN listener is currently up.
 */

const TTL_MS = 2 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;
// Grace period after the last code resolves before unbinding: the claim
// response is already built by then, but this guarantees it is flushed
// before the listener goes away.
const STOP_GRACE_MS = 1000;

interface Entry {
  payload: string;
  expiresAt: number;
}

const store = new Map<string, Entry>();

/**
 * Interfaces to skip when picking which address to embed in the QR — Docker
 * bridges, veth pairs, and VPN tunnels are all real interfaces with real
 * addresses, just never the one a phone on the same WiFi would use to reach
 * this machine.
 */
const SKIP_INTERFACE = /^(docker|br-|veth|tailscale|tun|tap|vmnet|vbox)/;
const PRIVATE_RANGE = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;

function pickLanAddress(): string | null {
  const candidates = Deno.networkInterfaces().filter((i) =>
    i.family === "IPv4" && i.address !== "127.0.0.1" &&
    !SKIP_INTERFACE.test(i.name)
  );
  // Prefer an actual private-range address (the real LAN interface) over
  // whatever else slipped through the name filter.
  const private_ = candidates.find((i) => PRIVATE_RANGE.test(i.address));
  return (private_ ?? candidates[0])?.address ?? null;
}

export interface PairingServer {
  /**
   * Store `payload` for one-time retrieval and return the full URL a phone
   * on the same network should fetch to redeem `code` — binding the LAN
   * listener first if it isn't up. Returns null when there is no usable LAN
   * interface (e.g. this machine is genuinely offline); nothing is stored
   * in that case.
   */
  publish(code: string, payload: string): string | null;
  /** Has `code` already been consumed or never existed? Lets the sharer poll for success. */
  status(code: string): "waiting" | "claimed-or-unknown";
  /** Stop the sweep timer and shut down the LAN server, if either is up. */
  close(): Promise<void>;
}

let server: Deno.HttpServer<Deno.NetAddr> | null = null;
let lanAddress: string | null = null;
let sweep: ReturnType<typeof setInterval> | undefined;
let stopTimer: ReturnType<typeof setTimeout> | undefined;

function stopIfIdle(): void {
  if (store.size > 0 || !server) return;
  const s = server;
  server = null;
  lanAddress = null;
  if (sweep !== undefined) {
    clearInterval(sweep);
    sweep = undefined;
  }
  void s.shutdown().catch(() => {
    // Already shutting down — nothing to do.
  });
}

function scheduleStop(): void {
  if (stopTimer !== undefined) clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    stopTimer = undefined;
    stopIfIdle();
  }, STOP_GRACE_MS);
}

function ensureStarted(): boolean {
  if (server) return true;
  lanAddress = pickLanAddress();
  if (!lanAddress) return false;
  server = Deno.serve(
    { hostname: "0.0.0.0", port: 0, onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      const m = url.pathname.match(/^\/pair\/([A-Za-z0-9_-]+)$/);
      if (!m) return new Response("not found", { status: 404 });

      const entry = store.get(m[1]);
      if (!entry || entry.expiresAt < Date.now()) {
        return new Response("not found or expired", { status: 404 });
      }
      store.delete(m[1]); // single-use
      // Last code out: the response above is already built, so unbind the
      // listener once it has had a beat to flush.
      if (store.size === 0) scheduleStop();
      return new Response(entry.payload, {
        headers: { "content-type": "application/json" },
      });
    },
  );
  // Sweeps codes nobody ever redeemed, so a dismissed share doesn't leak
  // memory — and unbinds the listener once the last one expires.
  sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of store) {
      if (entry.expiresAt < now) store.delete(code);
    }
    if (store.size === 0) stopIfIdle();
  }, SWEEP_INTERVAL_MS);
  return true;
}

export function startPairingServer(): PairingServer {
  return {
    publish(code: string, payload: string): string | null {
      if (!ensureStarted() || !server || !lanAddress) return null;
      store.set(code, { payload, expiresAt: Date.now() + TTL_MS });
      return `http://${lanAddress}:${server.addr.port}/pair/${code}`;
    },
    status(code: string) {
      return store.has(code) ? "waiting" : "claimed-or-unknown";
    },
    async close() {
      if (stopTimer !== undefined) {
        clearTimeout(stopTimer);
        stopTimer = undefined;
      }
      if (sweep !== undefined) {
        clearInterval(sweep);
        sweep = undefined;
      }
      const s = server;
      server = null;
      lanAddress = null;
      if (s) await s.shutdown();
    },
  };
}
