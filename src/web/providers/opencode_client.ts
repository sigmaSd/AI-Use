/**
 * OpenCode Go usage client.
 *
 * Reads the console JSON API (`/console/api/go/status`), scoped to a
 * workspace via the `x-org-id` header. Like the Claude client, the
 * browser-shaped headers survive because the denoapk fetch shim proxies this
 * request.
 */

import { getOpenCodeWorkspace } from "../store.ts";
import { type OCUsageResponse, parseOpenCodeUsage } from "./opencode.ts";
import { AuthError } from "./claude.ts";
import { requestSignal } from "./timeout.ts";

/**
 * Build the Cookie header. The console API only honors
 * `__Host-console_session` (the legacy `auth` cookie alone gets a 401), so a
 * bare value is taken as that; anything with `=` is a whole pasted cookie
 * string.
 */
function opencodeCookie(auth: string): string {
  return auth.includes("=") ? auth : `__Host-console_session=${auth}`;
}

function opencodeHeaders(auth: string, wsId: string): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": `${opencodeCookie(auth)}; oc_locale=en`,
    "x-org-id": wsId,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

function resolveOpenCodeWorkspace(_auth: string): string {
  const cached = getOpenCodeWorkspace();
  if (cached) return cached;

  throw new Error(
    "workspace ID not set — re-connect OpenCode and paste your workspace ID" +
      " (from the URL: opencode.ai/console/wrk_01…/go)",
  );
}

export async function fetchOpenCodeUsage(
  auth: string,
): Promise<OCUsageResponse> {
  const wsId = resolveOpenCodeWorkspace(auth);
  const res = await fetch("https://opencode.ai/console/api/go/status", {
    headers: opencodeHeaders(auth, wsId),
    signal: requestSignal(),
  });

  console.error(
    "[aiuse] opencode go status:",
    JSON.stringify({ status: res.status, url: res.url }),
  );

  // Signed-out requests get 401 JSON or a redirect to the login page.
  if (
    res.status === 401 || res.status === 403 || res.url.includes("/login")
  ) {
    await res.body?.cancel();
    throw new AuthError(
      `HTTP ${res.status} — the session cookie is expired or invalid (needs __Host-console_session)`,
    );
  }
  if (!res.ok) {
    const snippet = (await res.text()).substring(0, 200).replace(/\s+/g, " ");
    throw new Error(`HTTP ${res.status} from ${res.url}: ${snippet}`);
  }
  return parseOpenCodeUsage(await res.json());
}
