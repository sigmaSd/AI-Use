/**
 * Deno-side token persistence for the desktop host.
 *
 * Why this exists: the page keeps its own copy in `localStorage`
 * (see src/web/store.ts), but the compiled desktop binary serves the UI
 * from `http://127.0.0.1:<random-port>` with a fresh port every launch.
 * Browser storage is origin-scoped (scheme + host + port), so the page's
 * `localStorage` comes back empty on every restart. The Deno runtime's own
 * `localStorage`, in contrast, persists per app in the platform app-data
 * directory for compiled binaries — so the host mirrors tokens here and the
 * page hydrates from it on boot (see src/web/backend_tokens.ts).
 *
 * The first `Deno.serve()` in the process is forced loopback-only, so these
 * values never leave the machine. Key names and payload shape come from
 * src/shared/tokens.ts so the two copies stay 1:1.
 */

import {
  CHATGPT_SESSION_0_KEY,
  CHATGPT_SESSION_1_KEY,
  CHATGPT_SESSION_KEY,
  CLAUDE_TOKEN_KEY,
  OPENCODE_TOKEN_KEY,
  OPENCODE_WORKSPACE_KEY,
  type TokenFields,
} from "../shared/tokens.ts";

/** Host-side view of the shared token payload. */
export type PersistedTokens = TokenFields;

function clean(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

export function readPersistedTokens(): PersistedTokens {
  const out: PersistedTokens = {};
  const claude = localStorage.getItem(CLAUDE_TOKEN_KEY);
  if (claude) out.claudeToken = claude;
  const single = localStorage.getItem(CHATGPT_SESSION_KEY);
  if (single) {
    out.chatgptSessionToken = single;
  } else {
    const s0 = localStorage.getItem(CHATGPT_SESSION_0_KEY);
    const s1 = localStorage.getItem(CHATGPT_SESSION_1_KEY);
    if (s0 && s1) {
      out.chatgptSession0 = s0;
      out.chatgptSession1 = s1;
    }
  }
  const oc = localStorage.getItem(OPENCODE_TOKEN_KEY);
  if (oc) out.opencodeToken = oc;
  const ws = localStorage.getItem(OPENCODE_WORKSPACE_KEY);
  if (ws) out.opencodeWorkspaceId = ws;
  return out;
}

export function writePersistedTokens(patch: PersistedTokens): void {
  const claude = clean(patch.claudeToken);
  if (claude !== undefined) localStorage.setItem(CLAUDE_TOKEN_KEY, claude);

  const single = clean(patch.chatgptSessionToken);
  if (single !== undefined) {
    localStorage.setItem(CHATGPT_SESSION_KEY, single);
    localStorage.removeItem(CHATGPT_SESSION_0_KEY);
    localStorage.removeItem(CHATGPT_SESSION_1_KEY);
  } else {
    const s0 = clean(patch.chatgptSession0);
    const s1 = clean(patch.chatgptSession1);
    if (s0 !== undefined && s1 !== undefined) {
      localStorage.setItem(CHATGPT_SESSION_0_KEY, s0);
      localStorage.setItem(CHATGPT_SESSION_1_KEY, s1);
      localStorage.removeItem(CHATGPT_SESSION_KEY);
    }
  }

  const oc = clean(patch.opencodeToken);
  if (oc !== undefined) localStorage.setItem(OPENCODE_TOKEN_KEY, oc);
  const ws = clean(patch.opencodeWorkspaceId);
  if (ws !== undefined) localStorage.setItem(OPENCODE_WORKSPACE_KEY, ws);
}

export function clearPersistedTokens(
  provider: "claude" | "chatgpt" | "opencode" | "all",
): void {
  if (provider === "claude" || provider === "all") {
    localStorage.removeItem(CLAUDE_TOKEN_KEY);
  }
  if (provider === "chatgpt" || provider === "all") {
    localStorage.removeItem(CHATGPT_SESSION_KEY);
    localStorage.removeItem(CHATGPT_SESSION_0_KEY);
    localStorage.removeItem(CHATGPT_SESSION_1_KEY);
  }
  if (provider === "opencode" || provider === "all") {
    localStorage.removeItem(OPENCODE_TOKEN_KEY);
    localStorage.removeItem(OPENCODE_WORKSPACE_KEY);
  }
}
