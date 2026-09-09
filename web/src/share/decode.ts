/// <reference lib="dom" />
/**
 * Phone side: scan a <video> element for a pairing URL, then fetch it.
 *
 * Two decoders, picked at runtime:
 *
 *   - `BarcodeDetector` (native, ML-Kit-backed on Android WebView) when the
 *     platform exposes it and it lists `qr_code`. This is the same fast path
 *     Google's own camera uses — a warm `detect()` is ~25ms, so we can run it
 *     every frame via requestVideoFrameCallback instead of a throttled loop.
 *   - `@zxing/library` otherwise (older WebViews, desktop webview, any future
 *     iOS build). This is the original pure-JS decoder; it scans a frame,
 *     waits ~500ms, scans again.
 *
 * The camera setup (explicit resolution, environment-facing camera) is shared
 * and unchanged from the original design — that infrastructure was hard-won in
 * on-device testing and applies regardless of which decoder reads the frame.
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

/** Minimal shape of the Shape Detection API's BarcodeDetector — not in the
 *  TS DOM lib yet, and we only touch this much of it. */
interface DetectedBarcode {
  rawValue: string;
  format: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

/** null when unavailable or QR isn't a supported format — caller uses ZXing. */
async function makeBarcodeDetector(): Promise<BarcodeDetectorLike | null> {
  const Ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor })
    .BarcodeDetector;
  if (typeof Ctor !== "function") return null;
  try {
    const formats = await Ctor.getSupportedFormats();
    if (!formats.includes("qr_code")) return null;
    return new Ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
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
  let stopped = false;
  let handled = false; // stop acting after the first valid pairing URL
  let stream: MediaStream | undefined;
  let zxingReader: BrowserQRCodeReader | undefined;
  let rvfcHandle: number | undefined;

  async function onDecoded(text: string) {
    if (handled || stopped) return;
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

  function stop() {
    stopped = true;
    if (rvfcHandle !== undefined && "cancelVideoFrameCallback" in video) {
      video.cancelVideoFrameCallback(rvfcHandle);
    }
    zxingReader?.reset();
    // ZXing stops the tracks it was handed on reset(); the BarcodeDetector
    // path has no such owner, so stop them here too. Idempotent either way.
    stream?.getTracks().forEach((t) => t.stop());
  }

  try {
    // Without an explicit size, this WebView fell back to 480x640 in
    // testing — at that resolution even a small QR, photographed off a
    // monitor a foot or two away, has individual modules smaller than a
    // pixel and is essentially unreadable. `ideal` is a soft request the
    // camera will satisfy up to its real capability, not a hard requirement.
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });

    const detector = await makeBarcodeDetector();
    if (detector && "requestVideoFrameCallback" in video) {
      video.srcObject = stream;
      await video.play().catch(() => {});

      const scanFrame = async () => {
        if (stopped) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length > 0) void onDecoded(codes[0].rawValue);
        } catch {
          // Transient per-frame decode failures are expected — the code
          // may be half in frame, blurred mid-focus, glared. Keep going.
        }
        if (!stopped) {
          rvfcHandle = video.requestVideoFrameCallback(scanFrame);
        }
      };
      rvfcHandle = video.requestVideoFrameCallback(scanFrame);
    } else {
      zxingReader = new BrowserQRCodeReader();
      await zxingReader.decodeFromStream(stream, video, (result) => {
        if (stopped || !result) return;
        void onDecoded(result.getText());
      });
    }
  } catch (err) {
    cb.onCameraError(err);
  }

  return { stop };
}
