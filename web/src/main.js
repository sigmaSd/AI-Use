/**
 * aiuse UI.
 *
 * Ported verbatim from the inline <script> that used to live in report.ts,
 * with one change: the four fetch('/api/*') calls now go through ./api.ts,
 * which exposes the same request/response shapes as plain function calls.
 * Everything below is DOM rendering and is untouched.
 *
 * It is still the original ES5-style code, which never saw the linter while it
 * lived inside a template literal, so deno.json excludes this file from lint
 * (110 no-var hits). Modernising it is a follow-up — keeping the move
 * behaviour-identical matters more than style while the Android port lands.
 */

import * as api from "./api.ts";
import { scanForTokens, shareConnections } from "./share/modal.ts";
import { isDesktop } from "./platform.ts";

api.init();

document.addEventListener("contextmenu", function (e) {
  e.preventDefault();
});

function byId(id) {
  return document.getElementById(id);
}

function showScreen(name) {
  byId("key-screen").style.display = (name === "key") ? "flex" : "none";
  byId("dashboard").style.display = (name === "dashboard") ? "block" : "none";
}

function colorVar(pct) {
  if (pct >= 90) return "var(--red)";
  if (pct >= 60) return "var(--amber)";
  return "var(--green)";
}
function statusWord(pct) {
  if (pct >= 90) return "critical";
  if (pct >= 60) return "elevated";
  return "normal";
}

function buildMeter(elId, pct) {
  var el = byId(elId);
  var totalCells = 20;
  var onCells = Math.round((pct / 100) * totalCells);
  var color = colorVar(pct);
  el.innerHTML = "";
  for (var i = 0; i < totalCells; i++) {
    var c = document.createElement("div");
    c.className = "cell";
    if (i < onCells) c.style.background = color;
    el.appendChild(c);
  }
}

function applyStatus(elId, pct) {
  var badge = byId(elId);
  var color = colorVar(pct);
  badge.textContent = statusWord(pct);
  badge.style.color = color;
  badge.style.borderColor = color;
}

function fmtTime(iso) {
  var d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtCountdownReal(ms) {
  if (ms <= 0) return "now";
  var totalSec = Math.floor(ms / 1000);
  var d = Math.floor(totalSec / 86400);
  var h = Math.floor((totalSec % 86400) / 3600);
  var m = Math.floor((totalSec % 3600) / 60);
  var s = totalSec % 60;
  if (d > 0) return d + "d " + h + "h " + m + "m";
  if (h > 0) return h + "h " + m + "m " + s + "s";
  if (m > 0) return m + "m " + s + "s";
  return s + "s";
}

function fmtAgo(iso) {
  if (!iso) return "--";
  var sec = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
  var d = Math.floor(sec / 86400);
  var h = Math.floor((sec % 86400) / 3600);
  var m = Math.floor((sec % 3600) / 60);
  if (d > 0) return "updated " + d + "d " + h + "h ago";
  if (h > 0) return "updated " + h + "h " + m + "m ago";
  if (m > 0) return "updated " + m + "m ago";
  return "updated " + sec + "s ago";
}

// Resets store the absolute reset time (ISO string) for countdown calculation.
// For OpenCode we only get resetInSec from the API, so we compute the absolute
// time at the moment we receive the data.
var resets = {}; // absolute reset times by provider/window
var chatgptResetKeys = [];
var lastFetchedAt = null;
var usageRequestSequence = 0;
var latestAppliedUsageRequest = 0;
var latestAppliedUsageRevision = -1;
var pollHandle = null;

// ---- provider visibility ----
var hasClaude = false;
var hasChatGPT = false;
var hasOpenCode = false;

function updateProviderSections() {
  byId("claude-section").style.display = hasClaude ? "" : "none";
  byId("chatgpt-section").style.display = hasChatGPT ? "" : "none";
  byId("opencode-section").style.display = hasOpenCode ? "" : "none";
  byId("reset-claude").style.display = hasClaude ? "" : "none";
  byId("reset-chatgpt").style.display = hasChatGPT ? "" : "none";
  byId("reset-opencode").style.display = hasOpenCode ? "" : "none";
}

// ---- error rendering ----
function renderProviderError(prefix, error) {
  if (!error) return;
  var el = byId(prefix + "-error");
  byId(prefix + "-error-kind").textContent = error.kind === "auth"
    ? "possible auth issue"
    : "network error";
  byId(prefix + "-error-msg").textContent = error.message || "";
  el.style.display = "flex";
  var badge = byId(prefix + "-badge");
  badge.textContent = "error";
  badge.className = "provider-badge err";
}
function clearProviderError(prefix) {
  byId(prefix + "-error").style.display = "none";
  var badge = byId(prefix + "-badge");
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
function renderClaudeUsage(usage, prepaidCredits, error) {
  if (error) {
    renderProviderError("claude", error);
    return;
  }
  clearProviderError("claude");
  if (!usage) return;

  var fh = usage.five_hour;
  var sd = usage.seven_day;

  byId("pct-5h").textContent = Math.round(fh.utilization);
  byId("pct-7d").textContent = Math.round(sd.utilization);
  buildMeter("meter-5h", fh.utilization);
  buildMeter("meter-7d", sd.utilization);
  applyStatus("status-5h", fh.utilization);
  applyStatus("status-7d", sd.utilization);
  byId("reset-5h-time").textContent = fmtTime(fh.resets_at);
  byId("reset-7d-time").textContent = fmtTime(sd.resets_at);

  resets.fiveHour = fh.resets_at;
  resets.sevenDay = sd.resets_at;

  var spendRow5h = byId("spend-5h-row");
  if (fh.used_dollars != null && fh.limit_dollars != null) {
    spendRow5h.style.display = "flex";
    byId("spend-5h").textContent = "$" + fh.used_dollars.toFixed(2) + " of $" +
      fh.limit_dollars.toFixed(2);
  } else {
    spendRow5h.style.display = "none";
  }
  var spendRow7d = byId("spend-7d-row");
  if (sd.used_dollars != null && sd.limit_dollars != null) {
    spendRow7d.style.display = "flex";
    byId("spend-7d").textContent = "$" + sd.used_dollars.toFixed(2) + " of $" +
      sd.limit_dollars.toFixed(2);
  } else {
    spendRow7d.style.display = "none";
  }

  var spendEnabled = (usage.extra_usage && usage.extra_usage.is_enabled) ||
    (usage.spend && usage.spend.enabled);
  byId("spend-tag").textContent = spendEnabled ? "enabled" : "disabled";

  renderExtraCredits(usage.extra_usage, prepaidCredits);
  renderScopedLimits(usage);
}

function fmtMinor(amountMinor, decimalPlaces, currency) {
  var places = decimalPlaces == null ? 2 : decimalPlaces;
  var symbol = currency === "USD" ? "$" : (currency || "") + " ";
  return symbol + (Number(amountMinor) / Math.pow(10, places)).toFixed(places);
}
function fmtMoney(amount, decimalPlaces, currency) {
  var symbol = currency === "USD" ? "$" : (currency || "") + " ";
  return symbol +
    Number(amount).toFixed(decimalPlaces == null ? 2 : decimalPlaces);
}

function renderExtraCredits(extraUsage, prepaidCredits) {
  var row = byId("credits-row");
  if (
    !extraUsage || !extraUsage.is_enabled || extraUsage.used_credits == null
  ) {
    row.style.display = "none";
    return;
  }
  row.style.display = "flex";
  var text = fmtMinor(
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

function renderScopedLimits(usage) {
  var panel = byId("scoped-panel");
  var container = byId("scoped-limits");
  var all = usage.limits || [];
  var scoped = all.filter(function (l) {
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
    var name = l.scope.model.display_name;
    var pct = l.percent || 0;
    var active = l.is_active;
    var color = active ? colorVar(pct) : "var(--dim)";
    var label = active ? statusWord(pct) : "inactive";

    var row = document.createElement("div");
    row.className = "scoped-row";

    var head = document.createElement("div");
    head.className = "scoped-head";
    var nameEl = document.createElement("span");
    nameEl.className = "scoped-name";
    nameEl.textContent = name;
    var badge = document.createElement("span");
    badge.className = "status";
    badge.textContent = label;
    badge.style.color = color;
    badge.style.borderColor = color;
    head.appendChild(nameEl);
    head.appendChild(badge);

    var pctEl = document.createElement("div");
    pctEl.className = "scoped-pct";
    pctEl.textContent = Math.round(pct) + "%";

    var meterEl = document.createElement("div");
    meterEl.className = "meter";
    var totalCells = 20;
    var onCells = Math.round((pct / 100) * totalCells);
    for (var i = 0; i < totalCells; i++) {
      var c = document.createElement("div");
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
function fmtWindow(seconds) {
  if (!seconds) return "usage window";
  if (seconds % 604800 === 0) return (seconds / 604800) + "-week window";
  if (seconds % 86400 === 0) return (seconds / 86400) + "-day window";
  if (seconds % 3600 === 0) return (seconds / 3600) + "-hour window";
  return fmtCountdownReal(seconds * 1000) + " window";
}

function chatgptResetAt(win) {
  if (win.reset_at != null) return new Date(win.reset_at * 1000).toISOString();
  if (win.reset_after_seconds != null) {
    return new Date(Date.now() + win.reset_after_seconds * 1000).toISOString();
  }
  return null;
}

function appendChatGPTWindow(container, name, win, tag) {
  if (!win) return;
  var key = "chatgpt-" + chatgptResetKeys.length;
  var pct = Number(win.used_percent || 0);
  var resetAt = chatgptResetAt(win);
  resets[key] = resetAt;
  chatgptResetKeys.push(key);

  var panel = document.createElement("div");
  panel.className = "panel";
  panel.setAttribute("data-tag", tag);

  var head = document.createElement("div");
  head.className = "row-head";
  var label = document.createElement("div");
  label.className = "label";
  label.textContent = name + " · " + fmtWindow(win.limit_window_seconds);
  var status = document.createElement("div");
  status.className = "status";
  status.id = "status-" + key;
  head.appendChild(label);
  head.appendChild(status);

  var pctEl = document.createElement("div");
  pctEl.className = "pct";
  var pctValue = document.createElement("span");
  pctValue.textContent = String(Math.round(pct));
  var pctUnit = document.createElement("small");
  pctUnit.textContent = "%";
  pctEl.appendChild(pctValue);
  pctEl.appendChild(pctUnit);

  var meter = document.createElement("div");
  meter.className = "meter";
  meter.id = "meter-" + key;
  var countdown = document.createElement("div");
  countdown.className = "countdown";
  countdown.appendChild(document.createTextNode("resets in "));
  var countdownValue = document.createElement("span");
  countdownValue.id = "cd-" + key;
  countdownValue.textContent = resetAt
    ? fmtCountdownReal(new Date(resetAt) - new Date())
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

function appendChatGPTRateLimit(container, name, limit, tag) {
  if (!limit) return;
  appendChatGPTWindow(container, name, limit.primary_window, tag);
  appendChatGPTWindow(container, name, limit.secondary_window, tag);
}

function renderChatGPTUsage(data, error) {
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
  var container = byId("chatgpt-limits");
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
    var empty = document.createElement("div");
    empty.className = "no-provider";
    empty.textContent = "No rate-limit windows were reported for this account.";
    container.appendChild(empty);
  }

  byId("chatgpt-plan").textContent = data.plan_type || "unknown";
  var credits = data.credits || {};
  var creditsText = "none";
  if (credits.unlimited) creditsText = "unlimited";
  else if (credits.balance != null) creditsText = String(credits.balance);
  else if (credits.has_credits) creditsText = "available";
  byId("chatgpt-credits").textContent = creditsText;
}

// ---- OpenCode rendering ----
function renderOCWindow(prefix, win) {
  var pct = win.usagePercent || 0;
  byId("pct-" + prefix).textContent = Math.round(pct);
  buildMeter("meter-" + prefix, pct);
  applyStatus("status-" + prefix, pct);

  // Compute absolute reset time from resetInSec
  var now = Date.now();
  var resetsAt = new Date(now + win.resetInSec * 1000).toISOString();
  resets[prefix] = resetsAt;
}

function renderOpenCodeUsage(data, error) {
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
  var requestSequence = ++usageRequestSequence;
  try {
    var body = api.getUsage();
    var revision = typeof body.revision === "number" ? body.revision : 0;
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
    byId("claude-key-input").style.display = "none";
    byId("claude-connect").style.display = "none";
    byId("claude-connected-badge").style.display = "inline";
  } else {
    byId("claude-key-input").style.display = "";
    byId("claude-connect").style.display = "";
    byId("claude-connected-badge").style.display = "none";
  }
  if (hasChatGPT) {
    byId("chatgpt-session-0-input").style.display = "none";
    byId("chatgpt-session-1-input").style.display = "none";
    byId("chatgpt-connect").style.display = "none";
    byId("chatgpt-connected-badge").style.display = "inline";
  } else {
    byId("chatgpt-session-0-input").style.display = "";
    byId("chatgpt-session-1-input").style.display = "";
    byId("chatgpt-connect").style.display = "";
    byId("chatgpt-connected-badge").style.display = "none";
  }
  if (hasOpenCode) {
    byId("opencode-key-input").style.display = "none";
    byId("opencode-workspace-input").style.display = "none";
    byId("opencode-connect").style.display = "none";
    byId("opencode-connected-badge").style.display = "inline";
  } else {
    byId("opencode-key-input").style.display = "";
    byId("opencode-workspace-input").style.display = "";
    byId("opencode-connect").style.display = "";
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
  claudeToken,
  chatgptSession0,
  chatgptSession1,
  opencodeToken,
  opencodeWorkspaceId,
) {
  var body = {};
  if (claudeToken) body.claudeToken = claudeToken;
  if (chatgptSession0) body.chatgptSession0 = chatgptSession0;
  if (chatgptSession1) body.chatgptSession1 = chatgptSession1;
  if (opencodeToken) body.opencodeToken = opencodeToken;
  if (opencodeWorkspaceId) body.opencodeWorkspaceId = opencodeWorkspaceId;

  return Promise.resolve(api.setTokens(body));
}

// Claude connect button
byId("claude-connect").addEventListener("click", function () {
  var token = byId("claude-key-input").value.trim();
  if (!token) {
    byId("claude-key-error").textContent = "Paste a session key first.";
    return;
  }
  byId("claude-connect").disabled = true;
  byId("claude-key-error").textContent = "";
  connectProvider(token, undefined, undefined, undefined, undefined).then(
    function (res) {
      byId("claude-connect").disabled = false;
      if (res.ok) {
        byId("claude-key-input").value = "";
        checkStatusAndShow();
      } else {
        byId("claude-key-error").textContent = res.error ||
          "Something went wrong.";
      }
    },
  ).catch(function () {
    byId("claude-connect").disabled = false;
    byId("claude-key-error").textContent =
      "Request failed. Is the server running?";
  });
});

// ChatGPT connect button
byId("chatgpt-connect").addEventListener("click", function () {
  var session0 = byId("chatgpt-session-0-input").value.trim();
  var session1 = byId("chatgpt-session-1-input").value.trim();
  if (!session0 || !session1) {
    byId("chatgpt-key-error").textContent = "Paste both session cookie parts.";
    return;
  }
  byId("chatgpt-connect").disabled = true;
  byId("chatgpt-key-error").textContent = "";
  connectProvider(undefined, session0, session1, undefined, undefined).then(
    function (res) {
      byId("chatgpt-connect").disabled = false;
      if (res.ok) {
        byId("chatgpt-session-0-input").value = "";
        byId("chatgpt-session-1-input").value = "";
        checkStatusAndShow();
      } else {
        byId("chatgpt-key-error").textContent = res.error ||
          "Something went wrong.";
      }
    },
  ).catch(function () {
    byId("chatgpt-connect").disabled = false;
    byId("chatgpt-key-error").textContent =
      "Request failed. Is the server running?";
  });
});

// OpenCode connect button
byId("opencode-connect").addEventListener("click", function () {
  var token = byId("opencode-key-input").value.trim();
  var wsId = byId("opencode-workspace-input").value.trim();
  if (!token) {
    byId("opencode-key-error").textContent = "Paste the auth cookie first.";
    return;
  }
  if (!wsId) {
    byId("opencode-key-error").textContent =
      "Paste your workspace ID (from the URL).";
    return;
  }
  byId("opencode-connect").disabled = true;
  byId("opencode-key-error").textContent = "";
  connectProvider(undefined, undefined, undefined, token, wsId).then(
    function (res) {
      byId("opencode-connect").disabled = false;
      if (res.ok) {
        byId("opencode-key-input").value = "";
        byId("opencode-workspace-input").value = "";
        checkStatusAndShow();
      } else {
        byId("opencode-key-error").textContent = res.error ||
          "Something went wrong.";
      }
    },
  ).catch(function () {
    byId("opencode-connect").disabled = false;
    byId("opencode-key-error").textContent =
      "Request failed. Is the server running?";
  });
});

// Allow Enter on either input
byId("claude-key-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") byId("claude-connect").click();
});
byId("chatgpt-session-0-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") byId("chatgpt-connect").click();
});
byId("chatgpt-session-1-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") byId("chatgpt-connect").click();
});
byId("opencode-key-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") byId("opencode-connect").click();
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
function resetProvider(provider) {
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
  var now = new Date();
  byId("clock").textContent = now.toLocaleTimeString();
  if (resets.fiveHour) {
    byId("cd-5h").textContent = fmtCountdownReal(
      new Date(resets.fiveHour) - now,
    );
  }
  if (resets.sevenDay) {
    byId("cd-7d").textContent = fmtCountdownReal(
      new Date(resets.sevenDay) - now,
    );
  }
  chatgptResetKeys.forEach(function (key) {
    var el = byId("cd-" + key);
    if (el && resets[key]) {
      el.textContent = fmtCountdownReal(new Date(resets[key]) - now);
    }
  });
  if (resets["oc-rolling"]) {
    byId("cd-oc-rolling").textContent = fmtCountdownReal(
      new Date(resets["oc-rolling"]) - now,
    );
  }
  if (resets["oc-weekly"]) {
    byId("cd-oc-weekly").textContent = fmtCountdownReal(
      new Date(resets["oc-weekly"]) - now,
    );
  }
  if (resets["oc-monthly"]) {
    byId("cd-oc-monthly").textContent = fmtCountdownReal(
      new Date(resets["oc-monthly"]) - now,
    );
  }
  if (lastFetchedAt) byId("updated-ago").textContent = fmtAgo(lastFetchedAt);
}, 1000);

// ---- init ----
checkStatusAndShow();
