/**
 * Deno-side token persistence for the desktop host.
 *
 * Why this exists: the page keeps its own copy in `localStorage`
 * (see web/src/store.ts), but the compiled desktop binary serves the UI
 * from `http://127.0.0.1:<random-port>` with a fresh port every launch.
 * Browser storage is origin-scoped (scheme + host + port), so the page's
 * `localStorage` comes back empty on every restart. The Deno runtime's own
 * `localStorage`, in contrast, persists per app in the platform app-data
 * directory for compiled binaries — so the host mirrors tokens here and the
 * page hydrates from it on boot (see web/src/backend_tokens.ts).
 *
 * The first `Deno.serve()` in the process is forced loopback-only, so these
 * values never leave the machine. Key names intentionally match
 * web/src/store.ts so the two copies stay 1:1.
 */

export interface PersistedTokens {
  claudeToken?: string;
  chatgptSessionToken?: string;
  chatgptSession0?: string;
  chatgptSession1?: string;
  opencodeToken?: string;
  opencodeWorkspaceId?: string;
}

const LS_CLAUDE = "claude_session_key";
const LS_CHATGPT = "chatgpt_session_token";
const LS_CHATGPT_0 = "chatgpt_session_token_0";
const LS_CHATGPT_1 = "chatgpt_session_token_1";
const LS_OPENCODE = "opencode_auth";
const LS_OPENCODE_WS = "opencode_workspace_id";

function clean(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

export function readPersistedTokens(): PersistedTokens {
  const out: PersistedTokens = {};
  const claude = localStorage.getItem(LS_CLAUDE);
  if (claude) out.claudeToken = claude;
  const single = localStorage.getItem(LS_CHATGPT);
  if (single) {
    out.chatgptSessionToken = single;
  } else {
    const s0 = localStorage.getItem(LS_CHATGPT_0);
    const s1 = localStorage.getItem(LS_CHATGPT_1);
    if (s0 && s1) {
      out.chatgptSession0 = s0;
      out.chatgptSession1 = s1;
    }
  }
  const oc = localStorage.getItem(LS_OPENCODE);
  if (oc) out.opencodeToken = oc;
  const ws = localStorage.getItem(LS_OPENCODE_WS);
  if (ws) out.opencodeWorkspaceId = ws;
  return out;
}

export function writePersistedTokens(patch: PersistedTokens): void {
  const claude = clean(patch.claudeToken);
  if (claude !== undefined) localStorage.setItem(LS_CLAUDE, claude);

  const single = clean(patch.chatgptSessionToken);
  if (single !== undefined) {
    localStorage.setItem(LS_CHATGPT, single);
    localStorage.removeItem(LS_CHATGPT_0);
    localStorage.removeItem(LS_CHATGPT_1);
  } else {
    const s0 = clean(patch.chatgptSession0);
    const s1 = clean(patch.chatgptSession1);
    if (s0 !== undefined && s1 !== undefined) {
      localStorage.setItem(LS_CHATGPT_0, s0);
      localStorage.setItem(LS_CHATGPT_1, s1);
      localStorage.removeItem(LS_CHATGPT);
    }
  }

  const oc = clean(patch.opencodeToken);
  if (oc !== undefined) localStorage.setItem(LS_OPENCODE, oc);
  const ws = clean(patch.opencodeWorkspaceId);
  if (ws !== undefined) localStorage.setItem(LS_OPENCODE_WS, ws);
}

export function clearPersistedTokens(
  provider: "claude" | "chatgpt" | "opencode" | "all",
): void {
  if (provider === "claude" || provider === "all") {
    localStorage.removeItem(LS_CLAUDE);
  }
  if (provider === "chatgpt" || provider === "all") {
    localStorage.removeItem(LS_CHATGPT);
    localStorage.removeItem(LS_CHATGPT_0);
    localStorage.removeItem(LS_CHATGPT_1);
  }
  if (provider === "opencode" || provider === "all") {
    localStorage.removeItem(LS_OPENCODE);
    localStorage.removeItem(LS_OPENCODE_WS);
  }
}
