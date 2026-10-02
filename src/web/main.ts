/**
 * Dashboard and connection UI shared by desktop and Android.
 * Provider data comes from api.ts; compact overview rows and details sheets
 * stay live as polling updates usage and reset countdowns.
 */

import * as api from "./api.ts";
import type { TokenResponse } from "./api.ts";
import { isDesktop } from "./platform.ts";
import type { ProviderError } from "./poll.ts";
import type {
  ClaudeUsageResponse,
  DollarAllowance,
  ExtraUsage,
  PrepaidCredits,
} from "./providers/claude.ts";
import type {
  ChatGPTRateLimit,
  ChatGPTResetCreditsResponse,
  ChatGPTUsageResponse,
  ChatGPTUsageWindow,
} from "./providers/chatgpt.ts";
import type { OCUsageResponse, OCUsageWindow } from "./providers/opencode.ts";
import { scanForTokens, shareConnections } from "./share/modal.ts";
import {
  colorVar,
  fmtAgo,
  fmtCountdownCompact,
  fmtMinor,
  fmtTime,
  fmtWindowCompact,
  statusWord,
} from "./ui/format.ts";
import {
  chatgptResetCards,
  claudeResetCards,
  type ResetCard,
} from "./ui/resets.ts";

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

function openDetails(provider: string): void {
  byId<HTMLDialogElement>(provider + "-details").showModal();
}

document.querySelectorAll<HTMLElement>("[data-details]").forEach((button) => {
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", button.dataset.details + "-details");
  button.addEventListener("click", () => openDetails(button.dataset.details!));
});
document.querySelectorAll<HTMLDialogElement>(".details-sheet").forEach(
  (sheet) => {
    sheet.addEventListener("click", (event) => {
      if (event.target !== sheet) return;
      const rect = sheet.getBoundingClientRect();
      if (
        event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom
      ) sheet.close();
    });
  },
);
byId("usage-help").addEventListener("click", (event) => {
  event.preventDefault();
  (event.currentTarget as HTMLElement).closest("details")?.removeAttribute(
    "open",
  );
  openDetails("help");
});

function fillMeter(el: HTMLElement, pct: number, color: string): void {
  let fill = el.firstElementChild as HTMLElement | null;
  if (!fill) {
    fill = document.createElement("div");
    fill.className = "fill";
    el.appendChild(fill);
  }
  fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
  fill.style.background = color;
}

function buildMeter(elId: string, pct: number): void {
  fillMeter(byId(elId), pct, colorVar(pct));
}

function applyStatus(elId: string, pct: number): void {
  const badge = byId(elId);
  badge.textContent = statusWord(pct);
  badge.style.color = colorVar(pct);
  const panel = badge.closest(".panel");
  const value = panel?.querySelector<HTMLElement>(".pct");
  if (value) value.style.color = colorVar(pct);
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
  badge.title = "Provider error";
}
function clearProviderError(prefix: string): void {
  byId(prefix + "-error").style.display = "none";
  const badge = byId(prefix + "-badge");
  badge.textContent = "connected";
  badge.className = "provider-badge ok";
  badge.title = "Connected";
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
  renderAllowances(usage.dollar_allowances ?? []);
}

/** "Monthly" when the reset is weeks out; the API doesn't name the period. */
function allowanceLabel(a: DollarAllowance): string {
  const days = (new Date(a.resets_at).getTime() - Date.now()) / 86_400_000;
  return days > 14 ? "Monthly allowance" : "Dollar allowance";
}

function renderAllowances(allowances: DollarAllowance[]): void {
  const container = byId("claude-allowances");
  container.style.display = allowances.length ? "" : "none";
  container.innerHTML = "";
  const details = byId("claude-allowance-details");
  details.hidden = !allowances.length;
  details.innerHTML = "";
  allowances.forEach(function (a) {
    const pct = a.utilization;
    const panel = document.createElement("div");
    panel.className = "panel";

    const head = document.createElement("div");
    head.className = "row-head";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = allowanceLabel(a);
    const status = document.createElement("div");
    status.className = "status";
    status.textContent = a.locked_reason ? "locked" : statusWord(pct);
    status.style.color = a.locked_reason ? "var(--red)" : colorVar(pct);
    head.appendChild(label);
    head.appendChild(status);

    const pctEl = document.createElement("div");
    pctEl.className = "pct";
    pctEl.style.color = a.locked_reason ? "var(--red)" : colorVar(pct);
    const used = a.used_dollars ?? a.limit_dollars * pct / 100;
    pctEl.textContent = "$" + used.toFixed(2);
    const of = document.createElement("small");
    of.textContent = " of $" + a.limit_dollars.toFixed(2);
    pctEl.appendChild(of);

    const meter = document.createElement("div");
    meter.className = "meter";
    fillMeter(meter, pct, colorVar(pct));

    const countdown = document.createElement("div");
    countdown.className = "countdown";
    countdown.appendChild(document.createTextNode("in "));
    const cd = document.createElement("span");
    cd.setAttribute("data-until", a.resets_at);
    cd.textContent = fmtCountdownCompact(
      new Date(a.resets_at).getTime() - Date.now(),
    );
    countdown.appendChild(cd);

    const meta = document.createElement("div");
    meta.className = "meta";
    const metaLabel = document.createElement("span");
    metaLabel.textContent = a.remaining_dollars != null
      ? "$" + a.remaining_dollars.toFixed(2) + " left"
      : Math.round(pct) + "% used";
    const metaTime = document.createElement("b");
    metaTime.textContent = fmtTime(a.resets_at);
    meta.appendChild(metaLabel);
    meta.appendChild(metaTime);

    panel.appendChild(head);
    panel.appendChild(pctEl);
    panel.appendChild(meter);
    panel.appendChild(countdown);
    const detail = document.createElement("div");
    detail.className = "panel";
    detail.dataset.tag = allowanceLabel(a);
    detail.appendChild(meta);
    details.appendChild(detail);
    if (a.locked_reason) {
      const note = document.createElement("div");
      note.className = "reset-warning";
      note.textContent = a.locked_reason;
      panel.appendChild(note);
    }
    container.appendChild(panel);
  });
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
    head.appendChild(nameEl);
    head.appendChild(badge);

    const pctEl = document.createElement("div");
    pctEl.className = "scoped-pct";
    pctEl.textContent = Math.round(pct) + "%";

    const meterEl = document.createElement("div");
    meterEl.className = "meter";
    fillMeter(meterEl, pct, color);

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
  label.textContent = name === "Included usage"
    ? fmtWindowCompact(win.limit_window_seconds)
    : name + " · " + fmtWindowCompact(win.limit_window_seconds);
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
  countdown.appendChild(document.createTextNode("in "));
  const countdownValue = document.createElement("span");
  countdownValue.id = "cd-" + key;
  countdownValue.textContent = resetAt
    ? fmtCountdownCompact(new Date(resetAt).getTime() - Date.now())
    : "--";
  countdown.appendChild(countdownValue);

  panel.appendChild(head);
  panel.appendChild(pctEl);
  panel.appendChild(meter);
  panel.appendChild(countdown);
  container.appendChild(panel);
  const timing = document.createElement("div");
  timing.className = "meta";
  const timingLabel = document.createElement("span");
  timingLabel.textContent = label.textContent;
  const timingValue = document.createElement("b");
  timingValue.textContent = resetAt ? fmtTime(resetAt) : "Not reported";
  timing.append(timingLabel, timingValue);
  byId("chatgpt-reset-times").appendChild(timing);
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
  const extra = byId("chatgpt-extra-limits");
  extra.innerHTML = "";
  byId("chatgpt-reset-times").innerHTML = "";
  // Keep secondary limits in details unless they need attention, or the
  // account has no included usage to show in the overview.
  const secondaryContainer = (limit: ChatGPTRateLimit | null | undefined) =>
    !data.rate_limit?.primary_window && !data.rate_limit?.secondary_window ||
      Number(limit?.primary_window?.used_percent || 0) >= 60 ||
      Number(limit?.secondary_window?.used_percent || 0) >= 60
      ? container
      : extra;
  appendChatGPTRateLimit(
    container,
    "Included usage",
    data.rate_limit,
    "plan limit",
  );
  appendChatGPTRateLimit(
    secondaryContainer(data.code_review_rate_limit),
    "Code review",
    data.code_review_rate_limit,
    "feature limit",
  );
  (data.additional_rate_limits || []).forEach(function (item) {
    appendChatGPTRateLimit(
      secondaryContainer(item.rate_limit),
      item.limit_name,
      item.rate_limit,
      "model limit",
    );
  });

  extra.style.display = extra.childNodes.length ? "" : "none";
  byId("chatgpt-reset-times").style.display = chatgptResetKeys.length
    ? ""
    : "none";
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
  byId("reset-" + prefix + "-time").textContent = fmtTime(resetsAt);
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

// ---- usage-limit resets ----
const PROVIDER_NAMES: Record<ResetCard["provider"], string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
};

function expiryChip(card: ResetCard): string {
  if (card.urgency === "urgent") return "expiring";
  if (card.urgency === "soon") return "expires soon";
  if (card.adviceTone === "go") return "use now";
  return card.adviceTone === "blocked" ? "locked" : "available";
}

function renderResetCard(card: ResetCard): HTMLElement {
  const el = document.createElement("div");
  el.className = "reset-card " + card.urgency;

  const count = document.createElement("div");
  count.className = "reset-count";
  count.textContent = String(card.left);
  const unit = document.createElement("small");
  unit.textContent = card.total != null && card.total > card.left
    ? "of " + card.total
    : card.left === 1
    ? "reset"
    : "resets";
  count.appendChild(unit);

  const body = document.createElement("div");
  body.className = "reset-body";

  const head = document.createElement("div");
  head.className = "reset-head";
  const name = document.createElement("span");
  name.className = "reset-provider";
  const dot = document.createElement("span");
  dot.className = "provider-dot";
  dot.style.background = "var(--" + card.provider + ")";
  name.appendChild(dot);
  name.appendChild(document.createTextNode(PROVIDER_NAMES[card.provider]));
  const chip = document.createElement("span");
  chip.className = "reset-chip";
  chip.textContent = expiryChip(card);
  head.appendChild(name);
  head.appendChild(chip);
  body.appendChild(head);

  const expiry = document.createElement("div");
  expiry.className = "reset-expiry";
  if (card.expiresAt) {
    expiry.appendChild(document.createTextNode("expires in "));
    const cd = document.createElement("b");
    cd.setAttribute("data-until", card.expiresAt);
    cd.textContent = fmtCountdownCompact(
      new Date(card.expiresAt).getTime() - Date.now(),
    );
    expiry.appendChild(cd);
    expiry.appendChild(
      document.createTextNode(" · " + fmtTime(card.expiresAt)),
    );
  } else {
    expiry.textContent = "no expiry reported";
  }
  body.appendChild(expiry);

  if (card.detail) {
    const detail = document.createElement("div");
    detail.className = "reset-detail";
    detail.textContent = card.detail;
    detail.title = card.detail;
    body.appendChild(detail);
  }

  if (card.warning) {
    const warning = document.createElement("div");
    warning.className = "reset-warning";
    warning.textContent = card.warning;
    body.appendChild(warning);
  }

  const advice = document.createElement("div");
  advice.className = "reset-advice " + card.adviceTone;
  advice.textContent = card.advice;
  body.appendChild(advice);

  el.appendChild(count);
  el.appendChild(body);
  return el;
}

function renderResets(
  claude: ClaudeUsageResponse | null,
  chatgpt: ChatGPTUsageResponse | null,
  chatgptCredits: ChatGPTResetCreditsResponse | null,
  chatgptCreditsError: string | null,
): void {
  const cards = [
    ...(hasClaude ? claudeResetCards(claude) : []),
    ...(hasChatGPT
      ? chatgptResetCards(
        chatgpt,
        chatgptCredits,
        Date.now(),
        chatgptCreditsError,
      )
      : []),
  ];
  for (const provider of ["claude", "chatgpt"] as const) {
    const summaries = byId(provider + "-reset-summary");
    const details = byId(provider + "-reset-details");
    const providerCards = cards.filter((card) => card.provider === provider);
    summaries.hidden = details.hidden = providerCards.length === 0;
    details.replaceChildren();
    providerCards.forEach((card, index) => {
      // Keep the opener alive across polls so closing a sheet can restore focus.
      const existing = summaries.children[index] as
        | HTMLButtonElement
        | undefined;
      const summary = existing ?? document.createElement("button");
      if (!existing) {
        summary.setAttribute("aria-haspopup", "dialog");
        summary.setAttribute("aria-controls", provider + "-details");
        summary.addEventListener("click", () => openDetails(provider));
        summaries.appendChild(summary);
      }
      summary.replaceChildren();
      summary.className = "reset-summary " + card.urgency + " " +
        card.adviceTone;
      const count = document.createElement("strong");
      count.textContent = card.left +
        (card.left === 1 ? " free reset" : " free resets");
      const expiry = document.createElement("span");
      if (card.expiresAt) {
        expiry.appendChild(document.createTextNode("expires in "));
        const time = document.createElement("span");
        time.dataset.until = card.expiresAt;
        time.textContent = fmtCountdownCompact(
          new Date(card.expiresAt).getTime() - Date.now(),
        );
        expiry.appendChild(time);
      }
      const chip = document.createElement("span");
      chip.className = "reset-chip";
      chip.textContent = card.warning
        ? "Check details ›"
        : expiryChip(card) + " ›";
      summary.append(count, expiry, chip);
      details.appendChild(renderResetCard(card));
    });
    while (summaries.childElementCount > providerCards.length) {
      summaries.lastElementChild?.remove();
    }
  }
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
    renderResets(
      body.claude?.usage ?? null,
      body.chatgpt?.usage ?? null,
      body.chatgpt?.resetCredits ?? null,
      body.chatgpt?.resetCreditsError ?? null,
    );
    lastFetchedAt = body.lastFetchedAt;
    byId("updated-ago").textContent = fmtAgo(lastFetchedAt);
    updateCountdowns();
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
    inputById("chatgpt-session1-input").style.display = "none";
    buttonById("chatgpt-connect").style.display = "none";
    byId("chatgpt-connected-badge").style.display = "inline";
  } else {
    inputById("chatgpt-session-input").style.display = "";
    inputById("chatgpt-session1-input").style.display = "";
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
  // First field is the single session-token cookie, or `.0` when the
  // optional `.1` field is filled; api.setTokens sorts out which.
  if (chatgptSession) body.chatgptSessionToken = chatgptSession;
  if (chatgptSession1) body.chatgptSession1 = chatgptSession1;
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
  const session1 = inputById("chatgpt-session1-input").value.trim();
  if (!session) {
    byId("chatgpt-key-error").textContent = "Paste the session cookie value.";
    return;
  }
  buttonById("chatgpt-connect").disabled = true;
  byId("chatgpt-key-error").textContent = "";
  connectProvider(undefined, session, session1, undefined, undefined).then(
    function (res) {
      buttonById("chatgpt-connect").disabled = false;
      if (res.ok) {
        inputById("chatgpt-session-input").value = "";
        inputById("chatgpt-session1-input").value = "";
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
for (const id of ["chatgpt-session-input", "chatgpt-session1-input"]) {
  inputById(id).addEventListener("keydown", function (e) {
    if (e.key === "Enter") buttonById("chatgpt-connect").click();
  });
}
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
} else {
  // ...and the reverse: the phone is the receiving end, so "share to phone"
  // has nowhere to go from here.
  byId("share-connections").style.display = "none";
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

// ---- countdowns ----
function updateCountdowns(): void {
  const now = new Date();
  if (resets.fiveHour) {
    byId("cd-5h").textContent = fmtCountdownCompact(
      new Date(resets.fiveHour).getTime() - now.getTime(),
    );
  }
  if (resets.sevenDay) {
    byId("cd-7d").textContent = fmtCountdownCompact(
      new Date(resets.sevenDay).getTime() - now.getTime(),
    );
  }
  chatgptResetKeys.forEach(function (key) {
    const el = byId("cd-" + key);
    if (el && resets[key]) {
      el.textContent = fmtCountdownCompact(
        new Date(resets[key]).getTime() - now.getTime(),
      );
    }
  });
  if (resets["oc-rolling"]) {
    byId("cd-oc-rolling").textContent = fmtCountdownCompact(
      new Date(resets["oc-rolling"]).getTime() - now.getTime(),
    );
  }
  if (resets["oc-weekly"]) {
    byId("cd-oc-weekly").textContent = fmtCountdownCompact(
      new Date(resets["oc-weekly"]).getTime() - now.getTime(),
    );
  }
  if (resets["oc-monthly"]) {
    byId("cd-oc-monthly").textContent = fmtCountdownCompact(
      new Date(resets["oc-monthly"]).getTime() - now.getTime(),
    );
  }
  document.querySelectorAll<HTMLElement>("[data-until]").forEach(
    function (el) {
      el.textContent = fmtCountdownCompact(
        new Date(el.getAttribute("data-until") || "").getTime() -
          now.getTime(),
      );
    },
  );
  if (lastFetchedAt) byId("updated-ago").textContent = fmtAgo(lastFetchedAt);
}
setInterval(updateCountdowns, 1000);

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
