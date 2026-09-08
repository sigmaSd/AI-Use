/// <reference lib="dom" />
/**
 * Phone side: scan a <video> element for a pairing URL, then fetch it.
 *
 * The camera setup here (explicit resolution, environment-facing camera,
 * ZXing's continuous decode loop) is unchanged from the original multi-frame
 * design — that infrastructure was hard-won in on-device testing and applies
 * regardless of what the QR contains. What changed is what happens with a
 * successful decode: instead of accumulating chunks, there's exactly one QR
 * to read, and it's a URL rather than credentials.
 *
 * fetch(url) here is cross-origin (this page's own origin is
 * https://appassets.androidplatform.net; the pairing URL is a bare
 * http://<lan-ip>:<port>/... address with no certificate) — host/runtime.js's
 * shim rewrites it through /__denoapk/proxy/, so it's ProxyClient.java doing
 * the actual fetch natively, not the WebView. That sidesteps both CORS *and*
 * mixed-content blocking for free, the same way it already does for the
 * claude.ai/chatgpt.com calls — this is the generic escape hatch built for
 * that, reused here as-is.
 */

import { BrowserQRCodeReader } from "@zxing/library";

export interface ScanCallbacks {
  /** A QR was read, but it isn't a pairing URL — scanning continues. */
  onNotAPairingCode(): void;
  onFetching(): void;
  /** The pairing server's response body, as text (JSON). */
  onComplete(json: string): void;
  onFetchError(err: unknown): void;
  onCameraError(err: unknown): void;
}

export interface QrScanner {
  stop(): void;
}

/** Only ever treat our own pairing links as valid — never blindly fetch an arbitrary scanned URL. */
function parsePairingUrl(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!/^\/pair\/[A-Za-z0-9_-]+$/.test(url.pathname)) return null;
  return url;
}

export async function startScan(
  video: HTMLVideoElement,
  cb: ScanCallbacks,
): Promise<QrScanner> {
  const reader = new BrowserQRCodeReader();
  let stopped = false;
  let handled = false; // stop acting after the first valid pairing URL

  async function onDecoded(text: string) {
    if (handled) return;
    const url = parsePairingUrl(text);
    if (!url) {
      cb.onNotAPairingCode();
      return;
    }

    handled = true;
    cb.onFetching();
    try {
      const res = await fetch(url.href);
      if (!res.ok) {
        throw new Error(`pairing server returned ${res.status}`);
      }
      cb.onComplete(await res.text());
    } catch (err) {
      handled = false; // let the user rescan rather than get stuck
      cb.onFetchError(err);
    }
  }

  try {
    // Without an explicit size, this WebView fell back to 480x640 in
    // testing — at that resolution even a small QR, photographed off a
    // monitor a foot or two away, has individual modules smaller than a
    // pixel and is essentially unreadable. `ideal` is a soft request the
    // camera will satisfy up to its real capability, not a hard requirement.
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });

    await reader.decodeFromStream(stream, video, (result) => {
      if (stopped || !result) return;
      void onDecoded(result.getText());
    });
  } catch (err) {
    cb.onCameraError(err);
  }

  return {
    stop() {
      stopped = true;
      reader.reset();
    },
  };
}
