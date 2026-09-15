/**
 * aiuse UI.
 *
 * Ported verbatim from the inline <script> that used to live in report.ts,
 * with one change: the four fetch('/api/*') calls now go through ./api.ts,
 * which exposes the same request/response shapes as plain function calls.
 * Everything below is DOM rendering and is untouched.
 *
 * Ported to TypeScript (typed DOM access, provider response types); the
 * rendering logic itself is unchanged from the ES5 original.
 */

import * as api from "./api.ts";
import type { TokenResponse } from "./api.ts";
import { isDesktop } from "./platform.ts";
import type { ProviderError } from "./poll.ts";
import type {
  ClaudeUsageResponse,
  ExtraUsage,
  PrepaidCredits,
} from "./providers/claude.ts";
import type {
  ChatGPTRateLimit,
  ChatGPTUsageResponse,
  ChatGPTUsageWindow,
} from "./providers/chatgpt.ts";
import type { OCUsageResponse, OCUsageWindow } from "./providers/opencode.ts";
import { scanForTokens, shareConnections } from "./share/modal.ts";
import {
  colorVar,
  fmtAgo,
  fmtCountdownReal,
  fmtMinor,
  fmtTime,
  fmtWindow,
  statusWord,
} from "./ui/format.ts";

api.init();

document.addEventListener("contextmenu", function (e) {
  e.preventDefault();
});

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

function inputById(id: string): HTMLInputElement {
  return byId<HTMLInputElement>(id);
}

function buttonById(id: string): HTMLButtonElement {
  return byId<HTMLButtonElement>(id);
}

function showScreen(name: string): void {
  byId("key-screen").style.display = (name === "key") ? "flex" : "none";
  byId("dashboard").style.display = (name === "dashboard") ? "block" : "none";
}

function buildMeter(elId: string, pct: number): void {
  const el = byId(elId);
  const totalCells = 20;
  const onCells = Math.round((pct / 100) * totalCells);
  const color = colorVar(pct);
  el.innerHTML = "";
  for (let i = 0; i < totalCells; i++) {
    const c = document.createElement("div");
    c.className = "cell";
    if (i < onCells) c.style.background = color;
    el.appendChild(c);
  }
}

function applyStatus(elId: string, pct: number): void {
  const badge = byId(elId);
  const color = colorVar(pct);
  badge.textContent = statusWord(pct);
  badge.style.color = color;
  badge.style.borderColor = color;
}

// Resets store the absolute reset time (ISO string) for countdown calculation.
// For OpenCode we only get resetInSec from the API, so we compute the absolute
// time at the moment we receive the data.
const resets: Record<string, string | null> = {}; // absolute reset times by provider/window
let chatgptResetKeys: string[] = [];
let lastFetchedAt: string | null = null;
let usageRequestSequence = 0;
let latestAppliedUsageRequest = 0;
let latestAppliedUsageRevision = -1;
let pollHandle: ReturnType<typeof setInterval> | null = null;

// ---- provider visibility ----
let hasClaude = false;
let hasChatGPT = false;
let hasOpenCode = false;

function updateProviderSections() {
  byId("claude-section").style.display = hasClaude ? "" : "none";
  byId("chatgpt-section").style.display = hasChatGPT ? "" : "none";
  byId("opencode-section").style.display = hasOpenCode ? "" : "none";
  byId("reset-claude").style.display = hasClaude ? "" : "none";
  byId("reset-chatgpt").style.display = hasChatGPT ? "" : "none";
  byId("reset-opencode").style.display = hasOpenCode ? "" : "none";
}

// ---- error rendering ----
function renderProviderError(prefix: string, error: ProviderError): void {
  if (!error) return;
  const el = byId(prefix + "-error");
  byId(prefix + "-error-kind").textContent = error.kind === "auth"
    ? "possible auth issue"
    : "network error";
  byId(prefix + "-error-msg").textContent = error.message || "";
  el.style.display = "flex";
  const badge = byId(prefix + "-badge");
  badge.textContent = "error";
  badge.className = "provider-badge err";
}
function clearProviderError(prefix: string): void {
  byId(prefix + "-error").style.display = "none";
  const badge = byId(prefix + "-badge");
  badge.textContent = "connected";
  badge.className = "provider-badge ok";
}

// Dismiss buttons
byId("claude-error-dismiss").addEventListener("click", function () {
  byId("claude-error").style.display = "none";
});
byId("chatgpt-error-dismiss").addEventListener("click", function () {
  byId("chatgpt-error").style.display = "none";
});
byId("opencode-error-dismiss").addEventListener("click", function () {
  byId("opencode-error").style.display = "none";
});

// ---- Claude rendering ----
function renderClaudeUsage(
  usage: ClaudeUsageResponse | null,
  prepaidCredits: PrepaidCredits | null,
  error: ProviderError | null,
): void {
  if (error) {
    renderProviderError("claude", error);
    return;
  }
  clearProviderError("claude");
  if (!usage) return;

  const fh = usage.five_hour;
  const sd = usage.seven_day;

  byId("pct-5h").textContent = String(Math.round(fh.utilization));
  byId("pct-7d").textContent = String(Math.round(sd.utilization));
  buildMeter("meter-5h", fh.utilization);
  buildMeter("meter-7d", sd.utilization);
  applyStatus("status-5h", fh.utilization);
  applyStatus("status-7d", sd.utilization);
  byId("reset-5h-time").textContent = fmtTime(fh.resets_at);
  byId("reset-7d-time").textContent = fmtTime(sd.resets_at);

  resets.fiveHour = fh.resets_at;
  resets.sevenDay = sd.resets_at;

  const spendRow5h = byId("spend-5h-row");
  if (fh.used_dollars != null && fh.limit_dollars != null) {
    spendRow5h.style.display = "flex";
    byId("spend-5h").textContent = "$" + fh.used_dollars.toFixed(2) + " of $" +
      fh.limit_dollars.toFixed(2);
  } else {
    spendRow5h.style.display = "none";
  }
  const spendRow7d = byId("spend-7d-row");
  if (sd.used_dollars != null && sd.limit_dollars != null) {
    spendRow7d.style.display = "flex";
    byId("spend-7d").textContent = "$" + sd.used_dollars.toFixed(2) + " of $" +
      sd.limit_dollars.toFixed(2);
  } else {
    spendRow7d.style.display = "none";
  }

  const spendEnabled = (usage.extra_usage && usage.extra_usage.is_enabled) ||
    (usage.spend && usage.spend.enabled);
  byId("spend-tag").textContent = spendEnabled ? "enabled" : "disabled";

  renderExtraCredits(usage.extra_usage, prepaidCredits);
  renderScopedLimits(usage);
}

function renderExtraCredits(
  extraUsage: ExtraUsage | null | undefined,
  prepaidCredits: PrepaidCredits | null,
): void {
  const row = byId("credits-row");
  if (
    !extraUsage || !extraUsage.is_enabled || extraUsage.used_credits == null
  ) {
    row.style.display = "none";
    return;
  }
  row.style.display = "flex";
  let text = fmtMinor(
    extraUsage.used_credits,
    extraUsage.decimal_places,
    extraUsage.currency,
  );
  if (extraUsage.monthly_limit != null) {
    text += " of " +
      fmtMinor(
        extraUsage.monthly_limit,
        extraUsage.decimal_places,
        extraUsage.currency,
      ) + " monthly cap";
  }
  if (prepaidCredits && prepaidCredits.amount != null) {
    text += " (" + fmtMinor(prepaidCredits.amount, 2, prepaidCredits.currency) +
      " remaining)";
  }
  byId("credits-used").textContent = text;
}

function renderScopedLimits(usage: ClaudeUsageResponse): void {
  const panel = byId("scoped-panel");
  const container = byId("scoped-limits");
  const all = usage.limits || [];
  const scoped = all.filter(function (l) {
    return l.kind === "weekly_scoped" && l.scope && l.scope.model &&
      l.scope.model.display_name;
  });

  if (scoped.length === 0) {
    panel.style.display = "none";
    return;
  }

  panel.style.display = "block";
  container.innerHTML = "";

  scoped.forEach(function (l) {
    if (!l.scope?.model) return;
    const name = l.scope.model.display_name;
    const pct = l.percent || 0;
    const active = l.is_active;
    const color = active ? colorVar(pct) : "var(--dim)";
    const label = active ? statusWord(pct) : "inactive";

    const row = document.createElement("div");
    row.className = "scoped-row";

    const head = document.createElement("div");
    head.className = "scoped-head";
    const nameEl = document.createElement("span");
    nameEl.className = "scoped-name";
    nameEl.textContent = name;
    const badge = document.createElement("span");
    badge.className = "status";
    badge.textContent = label;
    badge.style.color = color;
    badge.style.borderColor = color;
    head.appendChild(nameEl);
    head.appendChild(badge);

    const pctEl = document.createElement("div");
    pctEl.className = "scoped-pct";
    pctEl.textContent = Math.round(pct) + "%";

    const meterEl = document.createElement("div");
    meterEl.className = "meter";
    const totalCells = 20;
    const onCells = Math.round((pct / 100) * totalCells);
    for (let i = 0; i < totalCells; i++) {
      const c = document.createElement("div");
      c.className = "cell";
      if (i < onCells) c.style.background = color;
      meterEl.appendChild(c);
    }

    row.appendChild(head);
    row.appendChild(pctEl);
    row.appendChild(meterEl);
    container.appendChild(row);
  });
}

// ---- ChatGPT rendering ----
function chatgptResetAt(win: ChatGPTUsageWindow): string | null {
  if (win.reset_at != null) return new Date(win.reset_at * 1000).toISOString();
  if (win.reset_after_seconds != null) {
    return new Date(Date.now() + win.reset_after_seconds * 1000).toISOString();
  }
  return null;
}

function appendChatGPTWindow(
  container: HTMLElement,
  name: string,
  win: ChatGPTUsageWindow | null | undefined,
  tag: string,
): void {
  if (!win) return;
  const key = "chatgpt-" + chatgptResetKeys.length;
  const pct = Number(win.used_percent || 0);
  const resetAt = chatgptResetAt(win);
  resets[key] = resetAt;
  chatgptResetKeys.push(key);

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.setAttribute("data-tag", tag);

  const head = document.createElement("div");
  head.className = "row-head";
  const label = document.createElement("div");
  label.className = "label";
  label.textContent = name + " · " + fmtWindow(win.limit_window_seconds);
  const status = document.createElement("div");
  status.className = "status";
  status.id = "status-" + key;
  head.appendChild(label);
  head.appendChild(status);

  const pctEl = document.createElement("div");
  pctEl.className = "pct";
  const pctValue = document.createElement("span");
  pctValue.textContent = String(Math.round(pct));
  const pctUnit = document.createElement("small");
  pctUnit.textContent = "%";
  pctEl.appendChild(pctValue);
  pctEl.appendChild(pctUnit);

  const meter = document.createElement("div");
  meter.className = "meter";
  meter.id = "meter-" + key;
  const countdown = document.createElement("div");
  countdown.className = "countdown";
  countdown.appendChild(document.createTextNode("resets in "));
  const countdownValue = document.createElement("span");
  countdownValue.id = "cd-" + key;
  countdownValue.textContent = resetAt
    ? fmtCountdownReal(new Date(resetAt).getTime() - Date.now())
    : "--";
  countdown.appendChild(countdownValue);

  panel.appendChild(head);
  panel.appendChild(pctEl);
  panel.appendChild(meter);
  panel.appendChild(countdown);
  container.appendChild(panel);
  buildMeter(meter.id, pct);
  applyStatus(status.id, pct);
}

function appendChatGPTRateLimit(
  container: HTMLElement,
  name: string,
  limit: ChatGPTRateLimit | null | undefined,
  tag: string,
): void {
  if (!limit) return;
  appendChatGPTWindow(container, name, limit.primary_window, tag);
  appendChatGPTWindow(container, name, limit.secondary_window, tag);
}

function renderChatGPTUsage(
  data: ChatGPTUsageResponse | null,
  error: ProviderError | null,
): void {
  if (error) {
    renderProviderError("chatgpt", error);
    return;
  }
  clearProviderError("chatgpt");
  if (!data) return;

  chatgptResetKeys.forEach(function (key) {
    delete resets[key];
  });
  chatgptResetKeys = [];
  const container = byId("chatgpt-limits");
  container.innerHTML = "";
  appendChatGPTRateLimit(
    container,
    "Included usage",
    data.rate_limit,
    "plan limit",
  );
  appendChatGPTRateLimit(
    container,
    "Code review",
    data.code_review_rate_limit,
    "feature limit",
  );
  (data.additional_rate_limits || []).forEach(function (item) {
    appendChatGPTRateLimit(
      container,
      item.limit_name,
      item.rate_limit,
      "model limit",
    );
  });

  if (container.childNodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "no-provider";
    empty.textContent = "No rate-limit windows were reported for this account.";
    container.appendChild(empty);
  }

  byId("chatgpt-plan").textContent = data.plan_type || "unknown";
  const credits = data.credits || {};
  let creditsText = "none";
  if (credits.unlimited) creditsText = "unlimited";
  else if (credits.balance != null) creditsText = String(credits.balance);
  else if (credits.has_credits) creditsText = "available";
  byId("chatgpt-credits").textContent = creditsText;
}

// ---- OpenCode rendering ----
function renderOCWindow(prefix: string, win: OCUsageWindow): void {
  const pct = win.usagePercent || 0;
  byId("pct-" + prefix).textContent = String(Math.round(pct));
  buildMeter("meter-" + prefix, pct);
  applyStatus("status-" + prefix, pct);

  // Compute absolute reset time from resetInSec
  const now = Date.now();
  const resetsAt = new Date(now + win.resetInSec * 1000).toISOString();
  resets[prefix] = resetsAt;
}

function renderOpenCodeUsage(
  data: OCUsageResponse | null,
  error: ProviderError | null,
): void {
  if (error) {
    renderProviderError("opencode", error);
    return;
  }
  clearProviderError("opencode");
  if (!data) return;

  renderOCWindow("oc-rolling", data.rollingUsage);
  renderOCWindow("oc-weekly", data.weeklyUsage);
  renderOCWindow("oc-monthly", data.monthlyUsage);
}

// ---- data fetching ----
function fetchUsageOnce() {
  // Reading poll state is synchronous now, so responses can no longer
  // arrive out of order — the revision guard is kept as a cheap no-op.
  const requestSequence = ++usageRequestSequence;
  try {
    const body = api.getUsage();
    const revision = typeof body.revision === "number" ? body.revision : 0;
    if (requestSequence < latestAppliedUsageRequest) return;
    if (revision < latestAppliedUsageRevision) return;
    latestAppliedUsageRequest = requestSequence;
    latestAppliedUsageRevision = revision;
    if (body.claude) {
      renderClaudeUsage(
        body.claude.usage,
        body.claude.prepaidCredits,
        body.claude.error,
      );
    }
    if (body.chatgpt) {
      renderChatGPTUsage(body.chatgpt.usage, body.chatgpt.error);
    }
    if (body.opencode) {
      renderOpenCodeUsage(body.opencode.usage, body.opencode.error);
    }
    lastFetchedAt = body.lastFetchedAt;
    byId("updated-ago").textContent = fmtAgo(lastFetchedAt);
    byId("stamp").textContent = lastFetchedAt
      ? ("last poll " + lastFetchedAt)
      : "";
  } catch (e) {
    console.error("usage render failed", e);
  }
}

function startDashboardPolling() {
  fetchUsageOnce();
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(fetchUsageOnce, 5000);
}
function stopDashboardPolling() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

// ---- auth: independent provider connections ----
function updateKeyScreenState() {
  // Show/hide connected state for each provider
  if (hasClaude) {
    inputById("claude-key-input").style.display = "none";
    buttonById("claude-connect").style.display = "none";
    byId("claude-connected-badge").style.display = "inline";
  } else {
    inputById("claude-key-input").style.display = "";
    buttonById("claude-connect").style.display = "";
    byId("claude-connected-badge").style.display = "none";
  }
  if (hasChatGPT) {
    inputById("chatgpt-session-input").style.display = "none";
    buttonById("chatgpt-connect").style.display = "none";
    byId("chatgpt-connected-badge").style.display = "inline";
  } else {
    inputById("chatgpt-session-input").style.display = "";
    buttonById("chatgpt-connect").style.display = "";
    byId("chatgpt-connected-badge").style.display = "none";
  }
  if (hasOpenCode) {
    inputById("opencode-key-input").style.display = "none";
    inputById("opencode-workspace-input").style.display = "none";
    buttonById("opencode-connect").style.display = "none";
    byId("opencode-connected-badge").style.display = "inline";
  } else {
    inputById("opencode-key-input").style.display = "";
    inputById("opencode-workspace-input").style.display = "";
    buttonById("opencode-connect").style.display = "";
    byId("opencode-connected-badge").style.display = "none";
  }
  // Show "back to dashboard" only if at least one provider is connected
  byId("back-to-dash").style.display = (hasClaude || hasChatGPT || hasOpenCode)
    ? ""
    : "none";
}

function showKeyScreenWithState() {
  updateKeyScreenState();
  showScreen("key");
}

function connectProvider(
  claudeToken?: string,
  chatgptSession?: string,
  chatgptSession1?: string,
  opencodeToken?: string,
  opencodeWorkspaceId?: string,
): Promise<TokenResponse> {
  const body: api.TokenRequest = {};
  if (claudeToken) body.claudeToken = claudeToken;
  // Legacy callers passed (session0, session1) for the chunked cookies;
  // the current UI passes a single session-token value as `chatgptSession`.
  if (chatgptSession && chatgptSession1) {
    body.chatgptSession0 = chatgptSession;
    body.chatgptSession1 = chatgptSession1;
  } else if (chatgptSession) {
    body.chatgptSessionToken = chatgptSession;
  }
  if (opencodeToken) body.opencodeToken = opencodeToken;
  if (opencodeWorkspaceId) body.opencodeWorkspaceId = opencodeWorkspaceId;

  return Promise.resolve(api.setTokens(body));
}

// Claude connect button
buttonById("claude-connect").addEventListener("click", function () {
  const token = inputById("claude-key-input").value.trim();
  if (!token) {
    byId("claude-key-error").textContent = "Paste a session key first.";
    return;
  }
  buttonById("claude-connect").disabled = true;
  byId("claude-key-error").textContent = "";
  connectProvider(token, undefined, undefined, undefined, undefined).then(
    function (res) {
      buttonById("claude-connect").disabled = false;
      if (res.ok) {
        inputById("claude-key-input").value = "";
        checkStatusAndShow();
      } else {
        byId("claude-key-error").textContent = res.error ||
          "Something went wrong.";
      }
    },
  ).catch(function () {
    buttonById("claude-connect").disabled = false;
    byId("claude-key-error").textContent =
      "Request failed. Is the server running?";
  });
});

// ChatGPT connect button
buttonById("chatgpt-connect").addEventListener("click", function () {
  const session = inputById("chatgpt-session-input").value.trim();
  if (!session) {
    byId("chatgpt-key-error").textContent = "Paste the session cookie value.";
    return;
  }
  buttonById("chatgpt-connect").disabled = true;
  byId("chatgpt-key-error").textContent = "";
  connectProvider(undefined, session, undefined, undefined, undefined).then(
    function (res) {
      buttonById("chatgpt-connect").disabled = false;
      if (res.ok) {
        inputById("chatgpt-session-input").value = "";
        checkStatusAndShow();
      } else {
        byId("chatgpt-key-error").textContent = res.error ||
          "Something went wrong.";
      }
    },
  ).catch(function () {
    buttonById("chatgpt-connect").disabled = false;
    byId("chatgpt-key-error").textContent =
      "Request failed. Is the server running?";
  });
});

// OpenCode connect button
buttonById("opencode-connect").addEventListener("click", function () {
  const token = inputById("opencode-key-input").value.trim();
  const wsId = inputById("opencode-workspace-input").value.trim();
  if (!token) {
    byId("opencode-key-error").textContent = "Paste the auth cookie first.";
    return;
  }
  if (!wsId) {
    byId("opencode-key-error").textContent =
      "Paste your workspace ID (from the URL).";
    return;
  }
  buttonById("opencode-connect").disabled = true;
  byId("opencode-key-error").textContent = "";
  connectProvider(undefined, undefined, undefined, token, wsId).then(
    function (res) {
      buttonById("opencode-connect").disabled = false;
      if (res.ok) {
        inputById("opencode-key-input").value = "";
        inputById("opencode-workspace-input").value = "";
        checkStatusAndShow();
      } else {
        byId("opencode-key-error").textContent = res.error ||
          "Something went wrong.";
      }
    },
  ).catch(function () {
    buttonById("opencode-connect").disabled = false;
    byId("opencode-key-error").textContent =
      "Request failed. Is the server running?";
  });
});

// Allow Enter on either input
inputById("claude-key-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") buttonById("claude-connect").click();
});
inputById("chatgpt-session-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") buttonById("chatgpt-connect").click();
});
inputById("opencode-key-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") buttonById("opencode-connect").click();
});

// "back to dashboard" link
byId("back-to-dash").addEventListener("click", function () {
  if (hasClaude || hasChatGPT || hasOpenCode) {
    showScreen("dashboard");
  }
});

// "connect provider" link in top bar
byId("connect-provider").addEventListener("click", function () {
  showKeyScreenWithState();
});

// share connected tokens to another device via QR, and scan one in return
byId("share-connections").addEventListener("click", function () {
  shareConnections();
});
byId("open-scan").addEventListener("click", function () {
  scanForTokens(function () {
    checkStatusAndShow();
  });
});
// Scanning a QR is inherently the phone's half of the pairing flow — the
// desktop is the one that *shows* the code. Hide the entry point (and its
// "or paste tokens manually" divider) on desktop, where there's no camera to
// point at anything anyway.
if (isDesktop) {
  byId("open-scan").style.display = "none";
  byId("scan-or-divider").style.display = "none";
}

// ---- reset ----
function resetProvider(provider: string): void {
  Promise.resolve(api.resetToken(provider)).then(function () {
    checkStatusAndShow();
  });
}

byId("reset-claude").addEventListener("click", function () {
  hasClaude = false;
  updateProviderSections();
  resets.fiveHour = null;
  resets.sevenDay = null;
  resetProvider("claude");
});
byId("reset-chatgpt").addEventListener("click", function () {
  hasChatGPT = false;
  updateProviderSections();
  chatgptResetKeys.forEach(function (key) {
    delete resets[key];
  });
  chatgptResetKeys = [];
  resetProvider("chatgpt");
});
byId("reset-opencode").addEventListener("click", function () {
  hasOpenCode = false;
  updateProviderSections();
  resets["oc-rolling"] = null;
  resets["oc-weekly"] = null;
  resets["oc-monthly"] = null;
  resetProvider("opencode");
});

// ---- status check on load ----
function checkStatusAndShow() {
  Promise.resolve(api.getStatus()).then(function (s) {
    hasClaude = s.hasClaudeToken;
    hasChatGPT = s.hasChatGPTToken;
    hasOpenCode = s.hasOpenCodeToken;
    updateProviderSections();
    if (s.hasClaudeToken || s.hasChatGPTToken || s.hasOpenCodeToken) {
      showScreen("dashboard");
      startDashboardPolling();
    } else {
      stopDashboardPolling();
      showKeyScreenWithState();
    }
  }).catch(function () {
    showKeyScreenWithState();
  });
}

// ---- clock + countdowns ----
setInterval(function () {
  const now = new Date();
  byId("clock").textContent = now.toLocaleTimeString();
  if (resets.fiveHour) {
    byId("cd-5h").textContent = fmtCountdownReal(
      new Date(resets.fiveHour).getTime() - now.getTime(),
    );
  }
  if (resets.sevenDay) {
    byId("cd-7d").textContent = fmtCountdownReal(
      new Date(resets.sevenDay).getTime() - now.getTime(),
    );
  }
  chatgptResetKeys.forEach(function (key) {
    const el = byId("cd-" + key);
    if (el && resets[key]) {
      el.textContent = fmtCountdownReal(
        new Date(resets[key]).getTime() - now.getTime(),
      );
    }
  });
  if (resets["oc-rolling"]) {
    byId("cd-oc-rolling").textContent = fmtCountdownReal(
      new Date(resets["oc-rolling"]).getTime() - now.getTime(),
    );
  }
  if (resets["oc-weekly"]) {
    byId("cd-oc-weekly").textContent = fmtCountdownReal(
      new Date(resets["oc-weekly"]).getTime() - now.getTime(),
    );
  }
  if (resets["oc-monthly"]) {
    byId("cd-oc-monthly").textContent = fmtCountdownReal(
      new Date(resets["oc-monthly"]).getTime() - now.getTime(),
    );
  }
  if (lastFetchedAt) byId("updated-ago").textContent = fmtAgo(lastFetchedAt);
}, 1000);

// ---- init ----
// The desktop WebView gets a fresh origin (random port) every launch, so the
// page store starts empty there even with saved tokens. Hydrate from the
// Deno host mirror before the first status check; fail-soft elsewhere.
Promise.resolve(api.restoreFromBackend()).then(
  function () {
    checkStatusAndShow();
  },
  function () {
    checkStatusAndShow();
  },
);
