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

export interface StatusResponse {
  hasClaudeToken: boolean;
  hasChatGPTToken: boolean;
  hasOpenCodeToken: boolean;
  lastFetchedAt: string | null;
}

export interface TokenRequest {
  claudeToken?: string;
  chatgptSession0?: string;
  chatgptSession1?: string;
  opencodeToken?: string;
  opencodeWorkspaceId?: string;
}

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

export function setTokens(body: TokenRequest): TokenResponse {
  let claudeTok = body.claudeToken?.trim();
  let chatgptSession0 = body.chatgptSession0?.trim();
  let chatgptSession1 = body.chatgptSession1?.trim();
  let opencodeTok = body.opencodeToken?.trim();
  const opencodeWsId = body.opencodeWorkspaceId?.trim();

  // Strip accidental cookie-name prefixes
  if (claudeTok && claudeTok.startsWith("sessionKey=")) {
    claudeTok = claudeTok.slice(11);
  }
  chatgptSession0 = chatgptSession0?.replace(
    /^__Secure-next-auth\.session-token\.0=/,
    "",
  ).replace(/;$/, "");
  chatgptSession1 = chatgptSession1?.replace(
    /^__Secure-next-auth\.session-token\.1=/,
    "",
  ).replace(/;$/, "");
  if (opencodeTok && opencodeTok.startsWith("auth=")) {
    opencodeTok = opencodeTok.slice(5);
  }
  if (opencodeWsId && !opencodeWsId.startsWith("wrk_")) {
    return {
      ok: false,
      error: "Workspace ID should start with wrk_ (check the URL).",
    };
  }

  if (!claudeTok && !chatgptSession0 && !chatgptSession1 && !opencodeTok) {
    return { ok: false, error: "Paste at least one provider token." };
  }

  if (!!chatgptSession0 !== !!chatgptSession1) {
    return {
      ok: false,
      error: "Both ChatGPT session cookie parts are required.",
    };
  }

  if (claudeTok) {
    store.setClaudeToken(claudeTok);
    store.clearClaudeOrg();
    poll.clearClaudeState();
  }
  if (chatgptSession0 && chatgptSession1) {
    store.setChatGPTSession(chatgptSession0, chatgptSession1);
    poll.clearChatGPTState();
  }
  if (opencodeTok) {
    store.setOpenCodeToken(opencodeTok);
    if (opencodeWsId) store.setOpenCodeWorkspace(opencodeWsId);
    poll.clearOpenCodeState();
  }

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
