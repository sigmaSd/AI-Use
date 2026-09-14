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
import { PAIRING_TTL_MS, pollShareStatus, publishShare } from "./pairApi.ts";
import { type QrScanner, startScan } from "./decode.ts";

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** Only the providers actually connected — an unconnected one adds nothing. */
function currentPayload(): api.TokenRequest {
  const body: api.TokenRequest = {};
  const claude = store.getClaudeToken();
  if (claude) body.claudeToken = claude;
  const session = store.getChatGPTSession();
  if (session) {
    if (session.kind === "single") {
      body.chatgptSessionToken = session.token;
    } else {
      body.chatgptSession0 = session.token0;
      body.chatgptSession1 = session.token1;
    }
  }
  const oc = store.getOpenCodeToken();
  if (oc) {
    body.opencodeToken = oc;
    const ws = store.getOpenCodeWorkspace();
    if (ws) body.opencodeWorkspaceId = ws;
  }
  return body;
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

  let stopPoll: (() => void) | undefined;
  let expireTimer: ReturnType<typeof setTimeout> | undefined;

  function close() {
    stopPoll?.();
    if (expireTimer !== undefined) clearTimeout(expireTimer);
    modal.style.display = "none";
    stopBtn.removeEventListener("click", close);
  }

  stopBtn.addEventListener("click", close);
  modal.style.display = "flex";
  status.className = "qr-status";
  status.textContent = "preparing…";

  try {
    const { code, url } = await publishShare(payload);

    drawQr(canvas, url);
    status.className = "qr-status";
    status.textContent = "waiting for your phone to scan…";

    stopPoll = pollShareStatus(code, () => {
      status.className = "qr-status ok";
      status.textContent = "✓ received on your phone";
      setTimeout(close, 1500);
    });

    expireTimer = setTimeout(() => {
      stopPoll?.();
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

  // Reveal the <video> only once it's actually painting frames; until then
  // the black viewport hides the WebView's built-in play-button placeholder.
  function onPlaying() {
    video.classList.add("live");
  }

  function close() {
    closed = true;
    scanner?.stop();
    if (pulseTimer !== undefined) clearTimeout(pulseTimer);
    video.removeEventListener("playing", onPlaying);
    video.classList.remove("live");
    modal.style.display = "none";
    cancelBtn.removeEventListener("click", close);
  }

  function pulse() {
    viewport.classList.add("detected");
    if (pulseTimer !== undefined) clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => viewport.classList.remove("detected"), 220);
  }

  cancelBtn.addEventListener("click", close);
  video.classList.remove("live");
  video.addEventListener("playing", onPlaying);
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
    onUnsupported() {
      status.className = "qr-status err";
      status.textContent =
        "this device's browser can't scan QR codes — paste the tokens manually";
    },
  });

  scanner = started;
  // Cancel was clicked while the camera was still starting up — stop it now
  // rather than leaving it running past a modal that already closed.
  if (closed) started.stop();
}
