/// <reference lib="dom" />
/**
 * Which runtime is this bundle running in — the Android WebView, or the
 * desktop webview?
 *
 * The same `web/` bundle ships both ways. denoapk serves it through Android's
 * WebViewAssetLoader, whose synthetic origin is always
 * `https://appassets.androidplatform.net` — the same fact host/runtime.js and
 * web/src/share/decode.ts already rely on. The desktop host (report.ts) serves
 * it from `http://localhost:<port>`. Nothing else tells the two apart at the
 * JS level, so the origin is the signal.
 */

export const isAndroid =
  location.hostname === "appassets.androidplatform.net";

export const isDesktop = !isAndroid;
