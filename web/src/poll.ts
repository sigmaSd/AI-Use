/**
 * Polling engine.
 *
 * Ported from report.ts unchanged in behaviour — it just runs in the page now
 * instead of in the Deno process, so the UI reads `snapshot()` directly rather
 * than round-tripping through GET /api/usage every five seconds.
 */

import {
  ChatGPTAuthError,
  ChatGPTClient,
  type ChatGPTUsageResponse,
} from "./providers/chatgpt.ts";
import type { OCUsageResponse } from "./providers/opencode.ts";
import { fetchOpenCodeUsage } from "./providers/opencode_client.ts";
import {
  AuthError,
  type ClaudeUsageResponse,
  fetchClaudePrepaidCredits,
  fetchClaudeUsage,
  type PrepaidCredits,
} from "./providers/claude.ts";
import {
  getChatGPTSession0,
  getChatGPTSession1,
  getClaudeToken,
  getOpenCodeToken,
  hasChatGPTSession,
} from "./store.ts";

const POLL_INTERVAL_MS = 30_000;
const AUTH_RETRY_BASE_MS = 30_000;
const AUTH_RETRY_MAX_MS = 10 * 60_000;
const AUTH_RETRY_JITTER_MS = 5_000;
const AUTH_ERROR_DISPLAY_THRESHOLD = 2;

export interface ProviderError {
  kind: "auth" | "network";
  message: string;
}

export interface UsageSnapshot {
  claude: {
    usage: ClaudeUsageResponse | null;
    prepaidCredits: PrepaidCredits | null;
    error: ProviderError | null;
  };
  chatgpt: { usage: ChatGPTUsageResponse | null; error: ProviderError | null };
  opencode: { usage: OCUsageResponse | null; error: ProviderError | null };
  lastFetchedAt: string | null;
  revision: number;
}

const chatgptClient = new ChatGPTClient({ deviceId: crypto.randomUUID() });

let latestClaudeUsage: ClaudeUsageResponse | null = null;
let latestClaudePrepaid: PrepaidCredits | null = null;
let latestChatGPTUsage: ChatGPTUsageResponse | null = null;
let latestOpenCodeUsage: OCUsageResponse | null = null;

let claudeError: ProviderError | null = null;
let chatgptError: ProviderError | null = null;
let opencodeError: ProviderError | null = null;

let authErrorCountClaude = 0;
let authErrorCountChatGPT = 0;
let authErrorCountOpenCode = 0;
let nextClaudePollAt = 0;
let nextChatGPTPollAt = 0;
let nextOpenCodePollAt = 0;
let lastFetchedAt: string | null = null;
let usageRevision = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let pollInFlight = false;

function authRetryDelay(errorCount: number): number {
  const exponent = Math.min(Math.max(errorCount - 1, 0), 20);
  const exponential = Math.min(
    AUTH_RETRY_MAX_MS,
    AUTH_RETRY_BASE_MS * 2 ** exponent,
  );
  const jitter = Math.floor(Math.random() * AUTH_RETRY_JITTER_MS);
  return exponential + jitter;
}

/** Current state, in the same shape the old GET /api/usage returned. */
export function snapshot(): UsageSnapshot {
  return {
    claude: {
      usage: latestClaudeUsage,
      prepaidCredits: latestClaudePrepaid,
      error: claudeError,
    },
    chatgpt: { usage: latestChatGPTUsage, error: chatgptError },
    opencode: { usage: latestOpenCodeUsage, error: opencodeError },
    lastFetchedAt,
    revision: usageRevision,
  };
}

function scheduleNext() {
  const now = Date.now();
  const nextPolls: number[] = [];

  if (getClaudeToken()) nextPolls.push(nextClaudePollAt || now);
  if (hasChatGPTSession()) nextPolls.push(nextChatGPTPollAt || now);
  if (getOpenCodeToken()) nextPolls.push(nextOpenCodePollAt || now);

  if (nextPolls.length === 0) {
    pollTimer = undefined;
    return;
  }

  const nextPollAt = Math.min(...nextPolls);
  const delay = Math.max(0, nextPollAt - now);
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    void pollOnce();
  }, delay);
}

async function pollOnce() {
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    const claudeToken = getClaudeToken();
    const chatgptSession0 = getChatGPTSession0();
    const chatgptSession1 = getChatGPTSession1();
    const opencodeToken = getOpenCodeToken();
    const now = Date.now();

    if (!claudeToken && !hasChatGPTSession() && !opencodeToken) {
      return;
    }

    let hadAnySuccess = false;
    let attemptedAnyProvider = false;

    if (chatgptSession0 && chatgptSession1 && now >= nextChatGPTPollAt) {
      attemptedAnyProvider = true;
      try {
        latestChatGPTUsage = await chatgptClient.fetchUsage(
          chatgptSession0,
          chatgptSession1,
        );
        authErrorCountChatGPT = 0;
        chatgptError = null;
        nextChatGPTPollAt = Date.now() + POLL_INTERVAL_MS;
        hadAnySuccess = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof ChatGPTAuthError) {
          authErrorCountChatGPT++;
          if (authErrorCountChatGPT >= AUTH_ERROR_DISPLAY_THRESHOLD) {
            chatgptError = {
              kind: "auth",
              message:
                `${message}; ChatGPT cookies may have rotated — reconnect ChatGPT if this continues`,
            };
          }
          nextChatGPTPollAt = Date.now() +
            authRetryDelay(authErrorCountChatGPT);
        } else {
          authErrorCountChatGPT = 0;
          chatgptError = { kind: "network", message };
          nextChatGPTPollAt = Date.now() + POLL_INTERVAL_MS;
        }
        console.error("[aiuse] chatgpt poll failed:", message);
      }
    }

    if (claudeToken && now >= nextClaudePollAt) {
      attemptedAnyProvider = true;
      try {
        latestClaudeUsage = await fetchClaudeUsage(claudeToken);
        latestClaudePrepaid = await fetchClaudePrepaidCredits(claudeToken);
        authErrorCountClaude = 0;
        claudeError = null;
        nextClaudePollAt = Date.now() + POLL_INTERVAL_MS;
        hadAnySuccess = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof AuthError) {
          authErrorCountClaude++;
          if (authErrorCountClaude >= AUTH_ERROR_DISPLAY_THRESHOLD) {
            claudeError = { kind: "auth", message };
          }
          nextClaudePollAt = Date.now() + authRetryDelay(authErrorCountClaude);
        } else {
          authErrorCountClaude = 0;
          claudeError = { kind: "network", message };
          nextClaudePollAt = Date.now() + POLL_INTERVAL_MS;
        }
        console.error("[aiuse] claude poll failed:", message);
      }
    }

    if (opencodeToken && now >= nextOpenCodePollAt) {
      attemptedAnyProvider = true;
      try {
        latestOpenCodeUsage = await fetchOpenCodeUsage(opencodeToken);
        authErrorCountOpenCode = 0;
        opencodeError = null;
        nextOpenCodePollAt = Date.now() + POLL_INTERVAL_MS;
        hadAnySuccess = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof AuthError) {
          authErrorCountOpenCode++;
          if (authErrorCountOpenCode >= AUTH_ERROR_DISPLAY_THRESHOLD) {
            opencodeError = { kind: "auth", message };
          }
          nextOpenCodePollAt = Date.now() +
            authRetryDelay(authErrorCountOpenCode);
        } else {
          authErrorCountOpenCode = 0;
          opencodeError = { kind: "network", message };
          nextOpenCodePollAt = Date.now() + POLL_INTERVAL_MS;
        }
        console.error(
          "[aiuse] opencode poll failed:",
          e instanceof Error ? e.stack || message : message,
        );
      }
    }

    if (hadAnySuccess) {
      lastFetchedAt = new Date().toISOString();
    }
    if (attemptedAnyProvider) usageRevision++;
  } finally {
    pollInFlight = false;
    scheduleNext();
  }
}

export function startPolling() {
  if (pollTimer !== undefined) return;
  void pollOnce();
}

export function wakePolling() {
  if (pollTimer !== undefined) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  if (!pollInFlight) void pollOnce();
}

export function stopPolling() {
  if (pollTimer !== undefined) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

/** Bump the revision so the UI re-renders after a token change. */
export function bumpRevision() {
  usageRevision++;
}

export function clearClaudeState() {
  latestClaudeUsage = null;
  latestClaudePrepaid = null;
  claudeError = null;
  authErrorCountClaude = 0;
  nextClaudePollAt = 0;
}

export function clearChatGPTState() {
  latestChatGPTUsage = null;
  chatgptError = null;
  authErrorCountChatGPT = 0;
  nextChatGPTPollAt = 0;
  chatgptClient.clearAccessToken();
}

export function clearOpenCodeState() {
  latestOpenCodeUsage = null;
  opencodeError = null;
  authErrorCountOpenCode = 0;
  nextOpenCodePollAt = 0;
}
