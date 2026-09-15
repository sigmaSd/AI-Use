/**
 * Host-side token mirror client.
 *
 * The page's own localStorage is origin-scoped, and the desktop binary
 * serves from a random port per launch — so it reads empty after every
 * restart. The Deno host persists the same values process-side
 * (see host/tokens.ts) and exposes them at same-origin `/api/tokens`.
 *
 * All helpers are fail-soft: on Android that route does not exist (the
 * native shell only implements the denoapk routes) and page localStorage
 * there is already stable, so a failure just means "no host mirror".
 */

import type { TokenRequest } from "./api.ts";

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

export async function loadBackendTokens(): Promise<TokenRequest | null> {
  try {
    const res = await fetch("/api/tokens", {
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as
      | Record<
        string,
        unknown
      >
      | null;
    if (!body || typeof body !== "object") return null;
    const out: TokenRequest = {};
    const claudeToken = pickString(body.claudeToken);
    if (claudeToken) out.claudeToken = claudeToken;
    const chatgptSessionToken = pickString(body.chatgptSessionToken);
    if (chatgptSessionToken) out.chatgptSessionToken = chatgptSessionToken;
    const chatgptSession0 = pickString(body.chatgptSession0);
    const chatgptSession1 = pickString(body.chatgptSession1);
    if (chatgptSession0) out.chatgptSession0 = chatgptSession0;
    if (chatgptSession1) out.chatgptSession1 = chatgptSession1;
    const opencodeToken = pickString(body.opencodeToken);
    if (opencodeToken) out.opencodeToken = opencodeToken;
    const opencodeWorkspaceId = pickString(body.opencodeWorkspaceId);
    if (opencodeWorkspaceId) out.opencodeWorkspaceId = opencodeWorkspaceId;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Fire-and-forget: page storage is already updated; this just mirrors. */
export function saveBackendTokens(payload: TokenRequest): void {
  try {
    void fetch("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    // Synchronous throw (e.g. no fetch) — nothing to do.
  }
}

/** Fire-and-forget host mirror clear. */
export function deleteBackendTokens(provider: string): void {
  try {
    void fetch(`/api/tokens?provider=${encodeURIComponent(provider)}`, {
      method: "DELETE",
    }).catch(() => {});
  } catch {
    // Nothing to do.
  }
}
