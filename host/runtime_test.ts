/**
 * Tests for the denapk runtime shim.
 *
 * The whole Android story rests on one assumption: a `new Headers()` copy
 * keeps forbidden request names (Cookie, User-Agent, Referer, Sec-Fetch-*)
 * because its guard is "none", so the shim can re-encode them before `fetch`
 * would strip them. If that ever stops holding, the proxy silently loses
 * authentication and every provider returns 401 — so it is worth asserting.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

interface Captured {
  url: string;
  init: RequestInit;
}

/** Load runtime.js against a stub origin, capturing what it forwards. */
async function loadShim(origin: string): Promise<{
  fetch: typeof fetch;
  calls: Captured[];
}> {
  const src = await Deno.readTextFile(
    new URL("./runtime.js", import.meta.url),
  );
  const calls: Captured[] = [];
  const sandbox = {
    Headers,
    URL,
    location: { href: origin + "/", origin },
    fetch: (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response("ok"));
    },
  } as unknown as typeof globalThis;

  // The shim is an IIFE over `globalThis`; give it our stub as that object.
  new Function("globalThis", "Headers", "URL", "location", src)(
    sandbox,
    Headers,
    URL,
    sandbox.location,
  );
  return { fetch: sandbox.fetch, calls };
}

Deno.test("same-origin requests pass through untouched", async () => {
  const { fetch: f, calls } = await loadShim("http://127.0.0.1:8137");
  await f("/dist/app.js");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "/dist/app.js");
});

Deno.test("cross-origin requests are rewritten to the proxy path", async () => {
  const { fetch: f, calls } = await loadShim("http://127.0.0.1:8137");
  await f("https://claude.ai/api/organizations");
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "/__denapk/proxy/" +
      encodeURIComponent("https://claude.ai/api/organizations"),
  );
});

Deno.test("forbidden headers survive the rewrite", async () => {
  const { fetch: f, calls } = await loadShim("http://127.0.0.1:8137");
  await f("https://claude.ai/api/organizations", {
    headers: {
      "Cookie": "sessionKey=secret",
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://claude.ai/",
      "Sec-Fetch-Mode": "cors",
      "anthropic-client-platform": "web_claude_ai",
    },
  });

  const sent = calls[0].init.headers as Record<string, string>;
  assertEquals(sent["x-denapk-h-cookie"], "sessionKey=secret");
  assertEquals(sent["x-denapk-h-user-agent"], "Mozilla/5.0");
  assertEquals(sent["x-denapk-h-referer"], "https://claude.ai/");
  assertEquals(sent["x-denapk-h-sec-fetch-mode"], "cors");
  assertEquals(sent["x-denapk-h-anthropic-client-platform"], "web_claude_ai");
  // No unprefixed leftovers — the browser would strip those.
  assertEquals(
    Object.keys(sent).every((k) => k.startsWith("x-denapk-h-")),
    true,
  );
});

Deno.test("the encoded target cannot be confused with the proxy path", async () => {
  const { fetch: f, calls } = await loadShim("http://127.0.0.1:8137");
  await f("https://evil.test/a/__denapk/proxy/b?x=1#frag");
  // Everything after the prefix is one opaque component.
  const rest = calls[0].url.slice("/__denapk/proxy/".length);
  assertEquals(rest.includes("/"), false);
  assertStringIncludes(decodeURIComponent(rest), "https://evil.test/a/");
});

Deno.test("other request options are preserved", async () => {
  const { fetch: f, calls } = await loadShim("http://127.0.0.1:8137");
  await f("https://claude.ai/x", {
    method: "POST",
    body: "hi",
    cache: "no-store",
  });
  assertEquals(calls[0].init.method, "POST");
  assertEquals(calls[0].init.body, "hi");
  assertEquals(calls[0].init.cache, "no-store");
});
