/**
 * Token storage.
 *
 * These used to live in Deno's localStorage because the Deno process did the
 * fetching. Now the page does, so they live in the page's own localStorage —
 * identical on the desktop webview and in the Android WebView (which gets a
 * real localStorage because assets are served from a secure origin).
 *
 * ChatGPT used to need two chunked cookies (...session-token.0/.1); current
 * captures show a single ...session-token cookie. The single form lives under
 * CHATGPT_SESSION_KEY, the legacy split form under _0/_1 — both are still
 * read, new connects always write the single form.
 */

import type { ChatGPTSession } from "./providers/chatgpt.ts";

const CLAUDE_TOKEN_KEY = "claude_session_key";
const CLAUDE_ORG_KEY = "claude_org_id";
const CHATGPT_SESSION_KEY = "chatgpt_session_token";
const CHATGPT_SESSION_0_KEY = "chatgpt_session_token_0";
const CHATGPT_SESSION_1_KEY = "chatgpt_session_token_1";
const OPENCODE_TOKEN_KEY = "opencode_auth";
const OPENCODE_WORKSPACE_KEY = "opencode_workspace_id";

export function getClaudeToken(): string | null {
  return localStorage.getItem(CLAUDE_TOKEN_KEY);
}
export function setClaudeToken(v: string) {
  localStorage.setItem(CLAUDE_TOKEN_KEY, v);
}
export function clearClaudeToken() {
  localStorage.removeItem(CLAUDE_TOKEN_KEY);
}
export function getClaudeOrg(): string | null {
  return localStorage.getItem(CLAUDE_ORG_KEY);
}
export function setClaudeOrg(v: string) {
  localStorage.setItem(CLAUDE_ORG_KEY, v);
}
export function clearClaudeOrg() {
  localStorage.removeItem(CLAUDE_ORG_KEY);
}

export function getChatGPTSession0(): string | null {
  return localStorage.getItem(CHATGPT_SESSION_0_KEY);
}
export function getChatGPTSession1(): string | null {
  return localStorage.getItem(CHATGPT_SESSION_1_KEY);
}
export function getChatGPTSessionSingle(): string | null {
  return localStorage.getItem(CHATGPT_SESSION_KEY);
}
/** Single-cookie installs are preferred; split installs keep working. */
export function getChatGPTSession(): ChatGPTSession | null {
  const single = localStorage.getItem(CHATGPT_SESSION_KEY);
  if (single) return { kind: "single", token: single };
  const s0 = localStorage.getItem(CHATGPT_SESSION_0_KEY);
  const s1 = localStorage.getItem(CHATGPT_SESSION_1_KEY);
  if (s0 && s1) return { kind: "split", token0: s0, token1: s1 };
  return null;
}
export function setChatGPTSessionSingle(token: string) {
  localStorage.setItem(CHATGPT_SESSION_KEY, token);
  localStorage.removeItem(CHATGPT_SESSION_0_KEY);
  localStorage.removeItem(CHATGPT_SESSION_1_KEY);
}
export function setChatGPTSessionSplit(session0: string, session1: string) {
  localStorage.setItem(CHATGPT_SESSION_0_KEY, session0);
  localStorage.setItem(CHATGPT_SESSION_1_KEY, session1);
  localStorage.removeItem(CHATGPT_SESSION_KEY);
}
export function setChatGPTSession(session0: string, session1: string) {
  setChatGPTSessionSplit(session0, session1);
}
export function clearChatGPTSession() {
  localStorage.removeItem(CHATGPT_SESSION_KEY);
  localStorage.removeItem(CHATGPT_SESSION_0_KEY);
  localStorage.removeItem(CHATGPT_SESSION_1_KEY);
}
export function hasChatGPTSession(): boolean {
  return getChatGPTSession() !== null;
}

export function getOpenCodeToken(): string | null {
  return localStorage.getItem(OPENCODE_TOKEN_KEY);
}
export function setOpenCodeToken(v: string) {
  localStorage.setItem(OPENCODE_TOKEN_KEY, v);
}
export function clearOpenCodeToken() {
  localStorage.removeItem(OPENCODE_TOKEN_KEY);
}
export function getOpenCodeWorkspace(): string | null {
  return localStorage.getItem(OPENCODE_WORKSPACE_KEY);
}
export function setOpenCodeWorkspace(v: string) {
  localStorage.setItem(OPENCODE_WORKSPACE_KEY, v);
}
export function clearOpenCodeWorkspace() {
  localStorage.removeItem(OPENCODE_WORKSPACE_KEY);
}
