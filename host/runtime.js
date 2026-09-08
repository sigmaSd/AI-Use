/**
 * denoapk runtime shim — injected by the host, never imported by app code.
 *
 * App code writes ordinary Deno-style fetch:
 *
 *   fetch("https://claude.ai/api/organizations", { headers: { Cookie: ... } })
 *
 * A WebView would drop `Cookie`, `User-Agent`, `Referer` and `Sec-Fetch-*`
 * (forbidden request headers) and then fail the CORS check anyway. So this
 * shim rewrites cross-origin requests to a host-served proxy path, carrying
 * the headers under an `x-denoapk-h-` prefix that the browser will send
 * happily. The host strips the prefix and performs the real request.
 *
 * This runs *before* fetch, while `init.headers` is still an ordinary object,
 * which is why the forbidden names are still intact at this point.
 *
 * The same file is served by the Deno host (report.ts) and baked into the
 * APK, so both platforms agree on the wire format.
 */
(function () {
  const PROXY = "/__denoapk/proxy/";
  const PREFIX = "x-denoapk-h-";
  const orig = globalThis.fetch;

  globalThis.fetch = function (input, init = {}) {
    const href = typeof input === "string" ? input : input.url;
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return orig(input, init);
    }
    if (url.origin === location.origin) return orig(input, init);

    // `new Headers()` has guard "none", so forbidden names survive the copy.
    const encoded = {};
    new Headers(init.headers || {}).forEach((value, name) => {
      encoded[PREFIX + name] = value;
    });

    // Encoded so the target URL can never be confused with the proxy path.
    return orig(PROXY + encodeURIComponent(url.href), {
      ...init,
      headers: encoded,
    });
  };

  // Hosts may append a `__DENOAPK_ENV` assignment after this file; default it
  // so app code can read it unconditionally.
  globalThis.__DENOAPK_ENV = globalThis.__DENOAPK_ENV || {};
})();
