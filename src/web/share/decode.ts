/// <reference lib="dom" />
/**
 * Phone side: scan a <video> element for a pairing URL, then fetch it.
 *
 * Decoding is the platform's native `BarcodeDetector` (ML-Kit-backed on the
 * Android WebView — the same fast path Google's own camera uses). A warm
 * `detect()` is ~25ms, so it runs every frame via requestVideoFrameCallback
 * rather than on a throttled loop. There is no JS-decoder fallback: scanning
 * only ever runs on Android now (the desktop build hides the scan button —
 * see web/src/platform.ts), and every Android WebView we target ships the
 * API. If it's somehow missing, `onUnsupported()` fires instead.
 *
 * The camera setup (explicit resolution, environment-facing camera) is
 * unchanged from the original design — that infrastructure was hard-won in
 * on-device testing.
 *
 * fetch(url) here is cross-origin (this page's own origin is
 * https://appassets.androidplatform.net; the pairing URL is a bare
 * http://<lan-ip>:<port>/... address with no certificate) — denoapk's fetch
 * shim rewrites it through its proxy path, so the native shell performs the
 * actual fetch and sidesteps both CORS *and* mixed-content blocking.
 *
 * A hung detect() would stall the frame chain silently (rVFC only fires the
 * next callback after the current one settles), so every call is capped: on
 * timeout the wait is abandoned, the detector recreated, and `onDetectorStuck`
 * fires so the UI says so instead of freezing on the initial hint.
 */

export interface ScanCallbacks {
  /**
   * A QR was read, but it isn't a pairing URL — scanning continues. Receives
   * the trimmed raw text so the UI can show *what* it saw instead of failing
   * silently (a detector that only ever yields foreign QRs looks identical
   * to a dead detector otherwise).
   */
  onNotAPairingCode(text: string): void;
  /** A single detect() call hung past the watchdog — it was abandoned and
   *  the detector recreated. Scanning continues; the UI should say so. */
  onDetectorStuck(): void;
  onFetching(): void;
  /** The pairing server's response body, as text (JSON). */
  onComplete(json: string): void;
  onFetchError(err: unknown): void;
  onCameraError(err: unknown): void;
  /** This WebView has no usable BarcodeDetector — scanning can't run here. */
  onUnsupported(): void;
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

/** null when the API is missing or doesn't do QR — caller reports unsupported. */
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

/** A detect() that never settles must not wedge the frame chain: cap it so
 *  the caller can abandon the wait (the hung native call itself can't be
 *  cancelled, it just gets ignored once it finally settles). */
const DETECT_TIMEOUT_MS = 3500;

function detectTimeoutError(): Error {
  return new Error("detect-timeout");
}

export async function startScan(
  video: HTMLVideoElement,
  cb: ScanCallbacks,
): Promise<QrScanner> {
  let stopped = false;
  let handled = false; // stop acting after the first valid pairing URL
  let stream: MediaStream | undefined;
  let rvfcHandle: number | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let detector: BarcodeDetectorLike | undefined;

  function detectOnce(): Promise<DetectedBarcode[]> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(detectTimeoutError());
      }, DETECT_TIMEOUT_MS);
      detector!.detect(video).then(
        (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          resolve(r);
        },
        (e) => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  async function onDecoded(text: string) {
    if (handled || stopped) return;
    // Some implementations pad the raw value with whitespace — trim before
    // the strict pairing-URL check so a valid code isn't silently rejected.
    const cleaned = text.trim();
    const url = parsePairingUrl(cleaned);
    if (!url) {
      cb.onNotAPairingCode(cleaned);
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
    if (pollTimer !== undefined) clearInterval(pollTimer);
    stream?.getTracks().forEach((t) => t.stop());
  }

  try {
    const created = await makeBarcodeDetector();
    if (!created) {
      cb.onUnsupported();
      return { stop };
    }
    detector = created;

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
    video.srcObject = stream;
    await video.play().catch(() => {});

    const scanFrame = async () => {
      if (stopped) return;
      // The interval fallback can re-enter while a hung detect is still
      // inside its timeout window; the rVFC path is serial by construction
      // and never trips this.
      if (inFlight) return;
      inFlight = true;
      try {
        let codes: DetectedBarcode[];
        try {
          codes = await detectOnce();
        } catch (err) {
          if (err instanceof Error && err.message === "detect-timeout") {
            const recreated = await makeBarcodeDetector();
            if (!recreated) {
              if (!stopped) {
                stop();
                cb.onCameraError(
                  new Error("barcode detector became unavailable"),
                );
              }
              return;
            }
            detector = recreated;
            if (!stopped) cb.onDetectorStuck();
            codes = [];
          } else {
            // Transient per-frame decode failures are expected — the code
            // may be half in frame, blurred mid-focus, glared. Keep going.
            codes = [];
          }
        }
        if (!stopped && codes.length > 0) {
          void onDecoded(codes[0].rawValue);
        }
      } finally {
        inFlight = false;
      }
      // requestVideoFrameCallback ties the loop to actual painted frames
      // (and pauses it when the video is hidden); a timer is the fallback
      // for the rare WebView that has BarcodeDetector but not rVFC.
      if (!stopped && "requestVideoFrameCallback" in video) {
        rvfcHandle = video.requestVideoFrameCallback(scanFrame);
      }
    };

    if ("requestVideoFrameCallback" in video) {
      rvfcHandle = video.requestVideoFrameCallback(scanFrame);
    } else {
      pollTimer = setInterval(scanFrame, 80);
    }
  } catch (err) {
    cb.onCameraError(err);
  }

  return { stop };
}
