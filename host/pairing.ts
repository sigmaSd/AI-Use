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
 * WiFi) binds normally. This is that second call.
 *
 * It exists to replace the original QR design (the credentials themselves,
 * chunked across dozens of animated QR frames) with something both simpler
 * and more secure: the QR now encodes a URL to this server, and the actual
 * secrets travel over a real HTTP response instead of being photographable
 * off a screen. A screenshot of the QR is useless once the code is consumed
 * or its short TTL expires — unlike a QR that carried the credentials
 * directly, which never expired.
 */

const TTL_MS = 2 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;

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
   * Full URL a phone on the same network should fetch to redeem `code`, or
   * null if no usable LAN interface was found (e.g. this machine is
   * genuinely offline).
   */
  urlFor(code: string): string | null;
  /** Store `payload` for one-time retrieval under `code`, expiring after TTL_MS. */
  publish(code: string, payload: string): void;
  /** Has `code` already been consumed or never existed? Lets the sharer poll for success. */
  status(code: string): "waiting" | "claimed-or-unknown";
}

export function startPairingServer(): PairingServer {
  const lanAddress = pickLanAddress();

  const server = Deno.serve(
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
      return new Response(entry.payload, {
        headers: { "content-type": "application/json" },
      });
    },
  );

  // Sweeps codes nobody ever redeemed, so a dismissed share doesn't leak
  // memory across a long-running desktop session.
  setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of store) {
      if (entry.expiresAt < now) store.delete(code);
    }
  }, SWEEP_INTERVAL_MS);

  return {
    urlFor(code: string) {
      if (!lanAddress) return null;
      return `http://${lanAddress}:${server.addr.port}/pair/${code}`;
    },
    publish(code: string, payload: string) {
      store.set(code, { payload, expiresAt: Date.now() + TTL_MS });
    },
    status(code: string) {
      return store.has(code) ? "waiting" : "claimed-or-unknown";
    },
  };
}
