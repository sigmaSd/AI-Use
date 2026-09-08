/**
 * OpenCode Go usage client.
 *
 * Lifted from report.ts unchanged. Like the Claude client, the browser-shaped
 * headers survive because the denapk runtime shim proxies this request — see
 * host/runtime.js.
 */

import { envOverride, getOpenCodeWorkspace } from "../store.ts";
import { type OCUsageResponse, parseOpenCodeUsage } from "./opencode.ts";
import { AuthError } from "./claude.ts";

function opencodeHeaders(auth: string): Record<string, string> {
  const cleanAuth = auth.startsWith("auth=") ? auth.slice(5) : auth;
  return {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cookie": `auth=${cleanAuth}; oc_locale=en`,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
  };
}

function extractPageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/);
  return m ? m[1].trim() : "(no title)";
}

function resolveOpenCodeWorkspace(_auth: string): string {
  const override = envOverride("OPENCODE_WORKSPACE_ID");
  if (override) return override;
  const cached = getOpenCodeWorkspace();
  if (cached) return cached;

  throw new Error(
    "workspace ID not set — re-connect OpenCode and paste your workspace ID" +
      " (from the URL: opencode.ai/workspace/wrk_01…/go)",
  );
}

export async function fetchOpenCodeUsage(
  auth: string,
): Promise<OCUsageResponse> {
  const wsId = resolveOpenCodeWorkspace(auth);
  const res = await fetch(
    `https://opencode.ai/workspace/${wsId}/go`,
    { headers: opencodeHeaders(auth) },
  );

  console.error(
    "[aiuse] opencode go page:",
    JSON.stringify({
      status: res.status,
      url: res.url,
    }),
  );

  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`HTTP ${res.status} from ${res.url}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${res.url}`);
  }
  const html = await res.text();

  try {
    return parseOpenCodeUsage(html);
  } catch (e) {
    const title = extractPageTitle(html);
    console.error(
      "[aiuse] go page title:",
      title,
      "body snippet:",
      html.substring(0, 200).replace(/\s+/g, " "),
    );
    throw e;
  }
}
