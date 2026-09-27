/**
 * In-process replacement for the old /api/* HTTP routes.
 *
 * The page used to POST tokens to the Deno process and poll GET /api/usage
 * every five seconds. Now that polling runs in the page, these are plain
 * function calls — but they keep the exact request and response shapes the
 * old routes had, so the UI code is unchanged apart from the call itself.
 *
 * Validation logic is ported verbatim from report.ts.
 */

import * as store from "./store.ts";
import * as poll from "./poll.ts";
import type { TokenFields } from "../shared/tokens.ts";
import {
  deleteBackendTokens,
  loadBackendTokens,
  saveBackendTokens,
} from "./backend_tokens.ts";

export interface StatusResponse {
  hasClaudeToken: boolean;
  hasChatGPTToken: boolean;
  hasOpenCodeToken: boolean;
  lastFetchedAt: string | null;
}

/** Token payload accepted from the UI and the phone-share QR. */
export type TokenRequest = TokenFields;

export interface TokenResponse {
  ok: boolean;
  error?: string;
}

export function getStatus(): StatusResponse {
  return {
    hasClaudeToken: !!store.getClaudeToken(),
    hasChatGPTToken: store.hasChatGPTSession(),
    hasOpenCodeToken: !!store.getOpenCodeToken(),
    lastFetchedAt: poll.snapshot().lastFetchedAt,
  };
}

export function getUsage(): poll.UsageSnapshot {
  return poll.snapshot();
}

const CHATGPT_COOKIE_RE =
  /__Secure-next-auth\.session-token(\.[01])?=([^;\s]+)/g;

export function normalizeChatGPTSession(
  single?: string,
  part0?: string,
  part1?: string,
): { single?: string; part0?: string; part1?: string } {
  const out: { single?: string; part0?: string; part1?: string } = {};
  for (const raw of [single, part0, part1]) {
    if (!raw || !raw.includes("__Secure-next-auth.session-token")) continue;
    for (const m of raw.matchAll(CHATGPT_COOKIE_RE)) {
      if (m[1] === ".0") out.part0 = m[2];
      else if (m[1] === ".1") out.part1 = m[2];
      else out.single = m[2];
    }
  }
  const bare = (v?: string) =>
    v && !v.includes("__Secure-next-auth.session-token")
      ? v.replace(/;$/, "")
      : undefined;
  // Bare values: the first UI field doubles as `.0` when `.1` is given.
  const s = bare(single), p0 = bare(part0), p1 = bare(part1);
  if (p0) out.part0 ??= p0;
  if (p1) out.part1 ??= p1;
  if (s) {
    if (out.part1 && !out.part0) out.part0 = s;
    else out.single ??= s;
  }
  // Complete chunk pair wins over a stray single value from the same paste.
  if (out.part0 && out.part1) delete out.single;
  return out;
}

export function setTokens(body: TokenRequest): TokenResponse {
  let claudeTok = body.claudeToken?.trim();
  let chatgptSessionToken = body.chatgptSessionToken?.trim();
  let chatgptSession0 = body.chatgptSession0?.trim();
  let chatgptSession1 = body.chatgptSession1?.trim();
  let opencodeTok = body.opencodeToken?.trim();
  const opencodeWsId = body.opencodeWorkspaceId?.trim();

  // Strip accidental cookie-name prefixes
  if (claudeTok && claudeTok.startsWith("sessionKey=")) {
    claudeTok = claudeTok.slice(11);
  }
  // ChatGPT flips between one `__Secure-next-auth.session-token` cookie and
  // chunked `.0`/`.1` ones. Accept either, including a whole pasted cookie
  // string or a `.0=`-prefixed value dropped into the single field.
  const chatgpt = normalizeChatGPTSession(
    chatgptSessionToken,
    chatgptSession0,
    chatgptSession1,
  );
  chatgptSessionToken = chatgpt.single;
  chatgptSession0 = chatgpt.part0;
  chatgptSession1 = chatgpt.part1;
  if (opencodeTok && opencodeTok.startsWith("auth=")) {
    opencodeTok = opencodeTok.slice(5);
  }
  if (opencodeWsId && !opencodeWsId.startsWith("wrk_")) {
    return {
      ok: false,
      error: "Workspace ID should start with wrk_ (check the URL).",
    };
  }

  if (
    !claudeTok && !chatgptSessionToken && !chatgptSession0 &&
    !chatgptSession1 &&
    !opencodeTok
  ) {
    return { ok: false, error: "Paste at least one provider token." };
  }

  if (
    !chatgptSessionToken && (!!chatgptSession0 !== !!chatgptSession1)
  ) {
    return {
      ok: false,
      error: chatgptSession0
        ? "Also paste __Secure-next-auth.session-token.1."
        : "Also paste __Secure-next-auth.session-token.0.",
    };
  }

  if (claudeTok) {
    store.setClaudeToken(claudeTok);
    store.clearClaudeOrg();
    poll.clearClaudeState();
  }
  if (chatgptSessionToken) {
    store.setChatGPTSessionSingle(chatgptSessionToken);
    poll.clearChatGPTState();
  } else if (chatgptSession0 && chatgptSession1) {
    store.setChatGPTSessionSplit(chatgptSession0, chatgptSession1);
    poll.clearChatGPTState();
  }
  if (opencodeTok) {
    store.setOpenCodeToken(opencodeTok);
    if (opencodeWsId) store.setOpenCodeWorkspace(opencodeWsId);
    poll.clearOpenCodeState();
  }

  // Mirror to the Deno host so tokens survive desktop restarts, where the
  // page origin (random port) changes every launch. Fail-soft on Android.
  const mirror: TokenRequest = {};
  if (claudeTok) mirror.claudeToken = claudeTok;
  if (chatgptSessionToken) {
    mirror.chatgptSessionToken = chatgptSessionToken;
  } else if (chatgptSession0 && chatgptSession1) {
    mirror.chatgptSession0 = chatgptSession0;
    mirror.chatgptSession1 = chatgptSession1;
  }
  if (opencodeTok) {
    mirror.opencodeToken = opencodeTok;
    if (opencodeWsId) mirror.opencodeWorkspaceId = opencodeWsId;
  }
  if (Object.keys(mirror).length > 0) saveBackendTokens(mirror);

  poll.bumpRevision();
  poll.wakePolling();
  return { ok: true };
}

export function resetToken(provider: string): TokenResponse {
  if (provider === "claude" || provider === "all") {
    store.clearClaudeToken();
    store.clearClaudeOrg();
    poll.clearClaudeState();
  }
  if (provider === "chatgpt" || provider === "all") {
    store.clearChatGPTSession();
    poll.clearChatGPTState();
  }
  if (provider === "opencode" || provider === "all") {
    store.clearOpenCodeToken();
    store.clearOpenCodeWorkspace();
    poll.clearOpenCodeState();
  }

  deleteBackendTokens(provider);

  poll.bumpRevision();

  if (
    !store.getClaudeToken() && !store.hasChatGPTSession() &&
    !store.getOpenCodeToken()
  ) {
    poll.stopPolling();
  }

  return { ok: true };
}

/** Kick off polling on load if any provider is already connected. */
export function init() {
  if (
    store.getClaudeToken() || store.hasChatGPTSession() ||
    store.getOpenCodeToken()
  ) {
    poll.startPolling();
  }
}

/**
 * Hydrate an empty page store from the Deno host mirror. Returns true when
 * anything was restored. No-op on Android (no host route) and when the page
 * already has tokens.
 */
export async function restoreFromBackend(): Promise<boolean> {
  if (
    store.getClaudeToken() || store.hasChatGPTSession() ||
    store.getOpenCodeToken()
  ) {
    return false;
  }
  const saved = await loadBackendTokens();
  if (!saved) return false;

  let restored = false;
  if (saved.claudeToken) {
    store.setClaudeToken(saved.claudeToken);
    restored = true;
  }
  if (saved.chatgptSessionToken) {
    store.setChatGPTSessionSingle(saved.chatgptSessionToken);
    restored = true;
  } else if (saved.chatgptSession0 && saved.chatgptSession1) {
    store.setChatGPTSessionSplit(
      saved.chatgptSession0,
      saved.chatgptSession1,
    );
    restored = true;
  }
  if (saved.opencodeToken) {
    store.setOpenCodeToken(saved.opencodeToken);
    if (saved.opencodeWorkspaceId) {
      store.setOpenCodeWorkspace(saved.opencodeWorkspaceId);
    }
    restored = true;
  }
  if (restored) {
    poll.bumpRevision();
    poll.startPolling();
  }
  return restored;
}
