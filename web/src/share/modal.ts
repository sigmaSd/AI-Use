/// <reference lib="dom" />
/**
 * DOM wiring for the share/scan modals — the only place in web/src/share/
 * that touches the page. encode.ts and decode.ts have no idea a modal
 * exists; this is what connects them to it.
 *
 * "What happens after tokens are imported" (switching screens, refreshing
 * status) deliberately stays out of here and in main.js, the same place that
 * logic already lives for manually-typed tokens — scanForTokens takes a
 * plain callback rather than reaching into main.js's internals itself.
 */

import * as store from "../store.ts";
import * as api from "../api.ts";
import { drawQr } from "./encode.ts";
import { type QrScanner, startScan } from "./decode.ts";

/** Matches host/pairing.ts's own TTL — the server is authoritative; this is
 *  only so the UI can show a countdown and stop polling at roughly the same
 *  time the server would actually expire the code. */
const PAIRING_TTL_MS = 2 * 60_000;
const POLL_INTERVAL_MS = 1500;

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** Only the providers actually connected — an unconnected one adds nothing. */
function currentPayload(): api.TokenRequest {
  const body: api.TokenRequest = {};
  const claude = store.getClaudeToken();
  if (claude) body.claudeToken = claude;
  const s0 = store.getChatGPTSession0();
  const s1 = store.getChatGPTSession1();
  if (s0 && s1) {
    body.chatgptSession0 = s0;
    body.chatgptSession1 = s1;
  }
  const oc = store.getOpenCodeToken();
  if (oc) {
    body.opencodeToken = oc;
    const ws = store.getOpenCodeWorkspace();
    if (ws) body.opencodeWorkspaceId = ws;
  }
  return body;
}

function randomCode(): string {
  // 8 bytes (64 bits) is far more than enough entropy for a secret that's
  // single-use, same-LAN-only, and expires in 2 minutes — a shorter code
  // keeps the QR itself smaller and easier to scan, which matters more here
  // than a wider margin against a threat model that isn't realistic anyway.
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function shareConnections() {
  const payload = currentPayload();
  if (Object.keys(payload).length === 0) {
    alert("Connect at least one provider before sharing.");
    return;
  }

  const modal = byId("share-modal");
  const canvas = byId<HTMLCanvasElement>("share-canvas");
  const status = byId("share-status");
  const stopBtn = byId<HTMLButtonElement>("share-stop");

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let expireTimer: ReturnType<typeof setTimeout> | undefined;

  function close() {
    if (pollTimer !== undefined) clearInterval(pollTimer);
    if (expireTimer !== undefined) clearTimeout(expireTimer);
    modal.style.display = "none";
    stopBtn.removeEventListener("click", close);
  }

  stopBtn.addEventListener("click", close);
  modal.style.display = "flex";
  status.className = "qr-status";
  status.textContent = "preparing…";

  try {
    const code = randomCode();
    const res = await fetch("/__denoapk/pair/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, payload }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);

    drawQr(canvas, data.url);
    status.className = "qr-status";
    status.textContent = "waiting for your phone to scan…";

    pollTimer = setInterval(async () => {
      const s = await fetch(`/__denoapk/pair/status/${code}`).then((r) =>
        r.json()
      ).catch(() => null);
      if (s?.status === "claimed-or-unknown") {
        status.className = "qr-status ok";
        status.textContent = "✓ received on your phone";
        clearInterval(pollTimer);
        setTimeout(close, 1500);
      }
    }, POLL_INTERVAL_MS);

    expireTimer = setTimeout(() => {
      if (pollTimer !== undefined) clearInterval(pollTimer);
      status.className = "qr-status err";
      status.textContent = "code expired — share again to get a new one";
    }, PAIRING_TTL_MS);
  } catch (e) {
    status.className = "qr-status err";
    status.textContent = "couldn't prepare pairing: " +
      (e instanceof Error ? e.message : String(e));
  }
}

export async function scanForTokens(onImported: () => void) {
  const modal = byId("scan-modal");
  const viewport = byId("scan-viewport");
  const video = byId<HTMLVideoElement>("scan-video");
  const status = byId("scan-status");
  const cancelBtn = byId<HTMLButtonElement>("scan-cancel");

  let closed = false;
  // Declared as `let`, not `const`: close()'s closure must be able to see
  // this as undefined if cancel is clicked while the still-pending
  // startScan() await below hasn't resolved yet.
  // deno-lint-ignore prefer-const
  let scanner: QrScanner | undefined;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;

  function close() {
    closed = true;
    scanner?.stop();
    if (pulseTimer !== undefined) clearTimeout(pulseTimer);
    modal.style.display = "none";
    cancelBtn.removeEventListener("click", close);
  }

  function pulse() {
    viewport.classList.add("detected");
    if (pulseTimer !== undefined) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => viewport.classList.remove("detected"), 220);
  }

  cancelBtn.addEventListener("click", close);
  modal.style.display = "flex";
  status.className = "qr-status";
  status.textContent = "point at the code shown on your other device…";

  // startScan()'s own promise doesn't resolve until the camera stream is
  // attached and playing, which takes a beat — capture the result so close()
  // (a cancel click during that window) can still stop the camera once it
  // does, rather than leaking the stream.
  const started = await startScan(video, {
    onNotAPairingCode() {
      pulse();
      // Status stays as-is — a QR from something else entirely might
      // legitimately be in frame briefly; no need to alarm over it.
    },
    onFetching() {
      pulse();
      status.className = "qr-status";
      status.textContent = "found it — fetching your tokens…";
    },
    onComplete(jsonText) {
      let parsed: api.TokenRequest;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        status.className = "qr-status err";
        status.textContent = "received data wasn't valid — try scanning again";
        return;
      }
      const result = api.setTokens(parsed);
      close();
      if (result.ok) {
        onImported();
      } else {
        alert(result.error || "Could not import the scanned tokens.");
      }
    },
    onFetchError(err) {
      status.className = "qr-status err";
      status.textContent = "couldn't fetch: " +
        (err instanceof Error ? err.message : String(err)) +
        " — try scanning again";
    },
    onCameraError(err) {
      status.className = "qr-status err";
      status.textContent = "camera error: " +
        (err instanceof Error ? err.message : String(err));
    },
  });

  scanner = started;
  // Cancel was clicked while the camera was still starting up — stop it now
  // rather than leaving it running past a modal that already closed.
  if (closed) started.stop();
}
