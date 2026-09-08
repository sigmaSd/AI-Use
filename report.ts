#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
/// <reference lib="deno.desktop" />
/**
 * aiuse — usage monitor for Claude.ai, ChatGPT, and OpenCode Go
 *
 * The UI and all provider logic live in ./web and run entirely in the page,
 * so the same bundle also ships inside an Android APK (see the denapk
 * packager). This file is only the desktop host: it serves ./web, answers the
 * denapk proxy route, and opens the window.
 *
 * The proxy exists because a browser refuses to send `Cookie`, `User-Agent`,
 * `Referer` and `Sec-Fetch-*`, and the provider APIs send no CORS headers.
 * web/../host/runtime.js rewrites cross-origin requests here; this end undoes
 * the rewrite and performs the real request. The Android shell implements the
 * same two routes in shouldInterceptRequest.
 *
 * - Session tokens are entered once in the UI and persist in localStorage.
 * - Organization / workspace IDs are auto-detected.
 * - Set CLAUDE_ORG_ID or OPENCODE_WORKSPACE_ID to override detection.
 *
 * Run:
 *   deno task bundle && deno desktop --allow-net --allow-env --allow-read report.ts
 */

import { contentType } from "@std/media-types/content-type";
import { extname, join, normalize } from "@std/path";

const HERE = import.meta.dirname!;
const WEB_ROOT = join(HERE, "web");
const RUNTIME_JS = join(HERE, "host", "runtime.js");

const PROXY_PREFIX = "/__denapk/proxy/";
const HEADER_PREFIX = "x-denapk-h-";

/** Env overrides the page can't read itself, appended to the runtime shim. */
function envScript(): string {
  const env: Record<string, string> = {};
  for (const name of ["CLAUDE_ORG_ID", "OPENCODE_WORKSPACE_ID"]) {
    const v = Deno.env.get(name);
    if (v) env[name] = v;
  }
  return `\nglobalThis.__DENAPK_ENV = ${JSON.stringify(env)};\n`;
}

/**
 * Replay a request the page could not make itself.
 *
 * The shim moved every header to `x-denapk-h-*` so the browser would not strip
 * the forbidden ones; restore the real names and forward.
 */
async function handleProxy(req: Request, encodedTarget: string) {
  let target: URL;
  try {
    target = new URL(decodeURIComponent(encodedTarget));
  } catch {
    return new Response("bad proxy target", { status: 400 });
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return new Response("unsupported protocol", { status: 400 });
  }

  const headers = new Headers();
  for (const [name, value] of req.headers) {
    if (name.startsWith(HEADER_PREFIX)) {
      headers.set(name.slice(HEADER_PREFIX.length), value);
    }
  }

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "follow",
  });

  // Strip hop-by-hop and CORS-relevant headers; the page reads this as
  // same-origin, so upstream's own CORS policy is irrelevant here.
  const out = new Headers();
  for (const [name, value] of upstream.headers) {
    if (name === "content-encoding" || name === "content-length") continue;
    if (name.startsWith("access-control-")) continue;
    out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname);
  if (rel.includes("..")) return new Response("forbidden", { status: 403 });

  const path = join(WEB_ROOT, rel);
  try {
    const body = await Deno.readFile(path);
    return new Response(body, {
      headers: {
        "content-type": contentType(extname(path)) ??
          "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname.startsWith(PROXY_PREFIX)) {
    return await handleProxy(req, url.pathname.slice(PROXY_PREFIX.length));
  }

  if (url.pathname === "/__denapk/runtime.js") {
    const js = await Deno.readTextFile(RUNTIME_JS) + envScript();
    return new Response(js, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  }

  return await serveStatic(url.pathname);
}

Deno.serve(handle);
if (Deno.BrowserWindow) {
  const _win = new Deno.BrowserWindow({
    title: "AI Usage",
    height: 1100,
    width: 1300,
  });
}
