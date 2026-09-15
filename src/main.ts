#!/usr/bin/env -S deno run --allow-net --allow-read --allow-sys
/// <reference lib="deno.desktop" />
/**
 * aiuse — usage monitor for Claude.ai, ChatGPT, and OpenCode Go
 *
 * The UI and all provider logic live in ./web and run entirely in the page,
 * so the same bundle also ships inside an Android APK (see the denoapk
 * packager). This file is only the desktop host: it serves ./web, answers the
 * pairing routes, and opens the window. Cross-origin provider calls and
 * the runtime shim are handled by denoapk's handleDenoapkRequest helper
 * (the same routes the Android shell implements natively); the pairing
 * routes below are app-specific and stay here.
 *
 * The proxy exists because a browser refuses to send `Cookie`, `User-Agent`,
 * `Referer` and `Sec-Fetch-*`, and the provider APIs send no CORS headers.
 * denoapk's fetch shim rewrites cross-origin requests to its proxy path;
 * the handler undoes the rewrite and performs the real request.
 *
 * The pairing routes back the "share to phone" feature — see host/pairing.ts
 * for why a second Deno.serve() call is what makes it reachable from a phone
 * at all, and src/web/share/ for the client side.
 *
 * - Session tokens are entered once in the UI and persist in the Deno
 *   process's localStorage (see host/tokens.ts), mirrored from the page's
 *   own copy. The page copy alone is not enough on desktop: the WebView
 *   origin includes a random port that changes every launch, so page
 *   localStorage comes back empty without the host mirror.
 * - Organization / workspace IDs are auto-detected.
 *
 * Run:
 *   deno task bundle && deno desktop --allow-net --allow-read --allow-sys src/main.ts
 */

import { contentType } from "@std/media-types/content-type";
import { extname, join, normalize } from "@std/path";
import { handleDenoapkRequest } from "@sigmasd/denoapk/handler";
import { type PairingServer, startPairingServer } from "./host/pairing.ts";
import {
  clearPersistedTokens,
  readPersistedTokens,
  writePersistedTokens,
} from "./host/tokens.ts";

const HERE = import.meta.dirname!;
const WEB_ROOT = join(HERE, "web");

// Assigned after Deno.serve(handle) below, not here — deliberately. The
// desktop launcher forces loopback-only binding on whichever Deno.serve()
// call executes *first* in the process; the main server (serving the
// WebView, meant to stay loopback-only) has to be that one. Starting the
// pairing server here instead — which it was, briefly — put things
// backwards: the pairing server got loopback-forced and the *main app*
// ended up bound to 0.0.0.0, LAN-exposed. Confirmed both ways on this
// machine before landing on this ordering.
// deno-lint-ignore prefer-const
let pairing: PairingServer;

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TOKEN_PROVIDER_RE = /^(claude|chatgpt|opencode|all)$/;

async function handlePairPublish(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null) as
    | { code?: string; payload?: unknown }
    | null;
  if (
    !body || !CODE_RE.test(body.code ?? "") || typeof body.payload !== "object"
  ) {
    return json({ ok: false, error: "bad request" }, 400);
  }
  // Binds the on-demand LAN listener on first share; null means offline.
  const shareUrl = pairing.publish(body.code!, JSON.stringify(body.payload));
  if (!shareUrl) {
    return json({
      ok: false,
      error: "no usable network interface found — is this machine online?",
    }, 500);
  }
  return json({ ok: true, url: shareUrl });
}

async function handle(req: Request): Promise<Response> {
  // runtime.js + proxy come from denoapk's helper (same routes the Android
  // shell implements natively). exec stays disabled — this app never calls
  // it. Returns null for everything else, including the /api routes below.
  const denoapkRes = await handleDenoapkRequest(req);
  if (denoapkRes) return denoapkRes;

  const url = new URL(req.url);

  if (url.pathname === "/api/pair/publish" && req.method === "POST") {
    return await handlePairPublish(req);
  }

  if (
    url.pathname.startsWith("/api/pair/status/") && req.method === "GET"
  ) {
    const code = url.pathname.slice("/api/pair/status/".length);
    return json({ status: pairing.status(code) });
  }

  // Host-side token mirror (see host/tokens.ts for why the page copy alone
  // does not survive desktop restarts). Loopback-only like everything else
  // on the first Deno.serve(), so tokens never leave the machine here.
  if (url.pathname === "/api/tokens" && req.method === "GET") {
    return json(readPersistedTokens());
  }

  if (url.pathname === "/api/tokens" && req.method === "POST") {
    const body = await req.json().catch(() => null) as
      | Record<
        string,
        unknown
      >
      | null;
    if (!body || typeof body !== "object") {
      return json({ ok: false, error: "bad request" }, 400);
    }
    writePersistedTokens({
      claudeToken: typeof body.claudeToken === "string"
        ? body.claudeToken
        : undefined,
      chatgptSessionToken: typeof body.chatgptSessionToken === "string"
        ? body.chatgptSessionToken
        : undefined,
      chatgptSession0: typeof body.chatgptSession0 === "string"
        ? body.chatgptSession0
        : undefined,
      chatgptSession1: typeof body.chatgptSession1 === "string"
        ? body.chatgptSession1
        : undefined,
      opencodeToken: typeof body.opencodeToken === "string"
        ? body.opencodeToken
        : undefined,
      opencodeWorkspaceId: typeof body.opencodeWorkspaceId === "string"
        ? body.opencodeWorkspaceId
        : undefined,
    });
    return json({ ok: true });
  }

  if (url.pathname === "/api/tokens" && req.method === "DELETE") {
    const provider = url.searchParams.get("provider") ?? "";
    if (!TOKEN_PROVIDER_RE.test(provider)) {
      return json({ ok: false, error: "bad request" }, 400);
    }
    clearPersistedTokens(
      provider as "claude" | "chatgpt" | "opencode" | "all",
    );
    return json({ ok: true });
  }

  return await serveStatic(url.pathname);
}

Deno.serve(handle);
pairing = startPairingServer();

if (Deno.BrowserWindow) {
  const win = new Deno.BrowserWindow({
    title: "AI Usage",
    height: 1100,
    width: 1300,
  });
  // Closing the window does not stop the runtime on its own: both servers
  // plus the pairing sweep timer keep the event loop alive, so without this
  // the process lingers until Ctrl-C. Shut everything down and exit.
  win.addEventListener("close", () => {
    void (async () => {
      try {
        await pairing.close();
      } catch {
        // Already shutting down — fall through to exit.
      }
      Deno.exit(0);
    })();
  });
}
