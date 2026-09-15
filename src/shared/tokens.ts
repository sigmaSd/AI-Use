/**
 * Single source of truth for token storage on both sides of the host/page
 * boundary.
 *
 * The page keeps its own copy in `localStorage` (src/web/store.ts) and the
 * Deno host mirrors it process-side (src/host/tokens.ts) because the
 * desktop WebView origin changes every launch. Both copies previously
 * declared the same key names and payload shapes independently — this module
 * owns them once, so the two sides can't drift.
 */

/** Page + host localStorage key for the Claude session token. */
export const CLAUDE_TOKEN_KEY = "claude_session_key";
/** Page + host key for the current single-cookie ChatGPT session. */
export const CHATGPT_SESSION_KEY = "chatgpt_session_token";
/** Page + host keys for the legacy chunked ChatGPT session pair. */
export const CHATGPT_SESSION_0_KEY = "chatgpt_session_token_0";
export const CHATGPT_SESSION_1_KEY = "chatgpt_session_token_1";
/** Page + host key for the OpenCode auth cookie. */
export const OPENCODE_TOKEN_KEY = "opencode_auth";
/** Page + host key for the OpenCode workspace id. */
export const OPENCODE_WORKSPACE_KEY = "opencode_workspace_id";

/**
 * Token payload shared by the page API (as `TokenRequest`), the host mirror
 * endpoints, and the phone-share QR payload. All fields optional: callers
 * send only the providers they mean to set.
 */
export interface TokenFields {
  claudeToken?: string;
  /** Current single-cookie form: value of `__Secure-next-auth.session-token`. */
  chatgptSessionToken?: string;
  /** Legacy chunked form: values of `...session-token.0` / `.1`. */
  chatgptSession0?: string;
  chatgptSession1?: string;
  opencodeToken?: string;
  opencodeWorkspaceId?: string;
}
