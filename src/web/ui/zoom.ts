/// <reference lib="dom" />
/**
 * Desktop UI zoom.
 *
 * Every size in index.html is a fixed px value tuned for a phone, where a
 * devicePixelRatio of ~3 makes 11–14px text comfortable. On a 1× desktop
 * monitor the same values read tiny, so the desktop build scales the whole
 * page with CSS `zoom` on <html> — one knob, no px→rem rewrite.
 *
 * Until the user picks a level, the default comes from the screen width
 * (see autoZoom). Ctrl/Cmd +, −, 0 and Ctrl+wheel adjust it, as does the
 * row in the "manage" menu. A chosen level is persisted host-side at
 * /api/zoom: page localStorage would not survive a restart on desktop
 * (fresh random-port origin every launch — see store.ts). Android never
 * calls initZoom; it already has system font scaling and pinch habits.
 *
 * Viewport units (100vh, 85dvh, …) are where engines disagree: Chromium
 * (WebView2) multiplies them by the zoom like any other length, so 100vh
 * overflows; WebKit (WebKitGTK, WKWebView) leaves them alone. Rather than
 * sniff engines, apply() measures a 100vh probe and publishes the actual
 * factor as `--vh-scale`, which index.html divides its vh lengths by.
 */

export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const MIN = ZOOM_STEPS[0];
const MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** Width (CSS px) the phone-tuned layout looks right at with zoom 1. */
const BASE_WIDTH = 1536;

export function clampZoom(z: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(z * 100) / 100));
}

/**
 * Default zoom for a screen `screenWidth` CSS px wide: 1 up to 1536,
 * growing linearly to 1.5 (1920 → 1.25), in 0.05 steps. CSS px already
 * fold in OS display scaling, so a 4K panel at 200% counts as 1920 —
 * the same physical size as a 1080p one, and it gets the same zoom.
 */
export function autoZoom(screenWidth: number): number {
  if (!(screenWidth > 0)) return 1;
  const z = Math.min(1.5, Math.max(1, screenWidth / BASE_WIDTH));
  return Math.round(z * 20) / 20;
}

/** Next step up (dir 1) or down (dir -1) from `z`, browser-style. */
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) {
    return ZOOM_STEPS.find((s) => s > z + 0.001) ?? MAX;
  }
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? MIN;
}

/** How much the current zoom inflated `100vh` (≈ zoom or 1, per engine). */
function measureVhScale(): number {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;top:0;left:0;width:1px;height:100vh;visibility:hidden";
  document.body.append(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h > 0 && innerHeight > 0 ? h / innerHeight : 1;
}

/** null = no stored choice, follow autoZoom. */
let chosen: number | null = null;
let label: HTMLElement | null = null;

function current(): number {
  return chosen ?? autoZoom(screen.width);
}

function apply(): void {
  const z = current();
  const root = document.documentElement;
  root.style.setProperty("zoom", String(z));
  root.style.setProperty("--vh-scale", String(measureVhScale()));
  if (label) {
    label.textContent = Math.round(z * 100) + "%" + (chosen ? "" : " auto");
  }
}

function persist(): void {
  fetch("/api/zoom", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ zoom: chosen }),
  }).catch(function () {
    // Fail-soft: the level still applies for this session.
  });
}

function set(z: number | null): void {
  chosen = z === null ? null : clampZoom(z);
  apply();
  persist();
}

function step(dir: 1 | -1): void {
  set(stepZoom(current(), dir));
}

export interface ZoomControls {
  /** Shows the current level, e.g. "125% auto". */
  label: HTMLElement;
  zoomIn: HTMLElement;
  zoomOut: HTMLElement;
  /** Clears the stored level, back to the screen-width default. */
  reset: HTMLElement;
}

export function initZoom(controls: ZoomControls): void {
  label = controls.label;
  // Auto level first so there's no 1×-sized flash while /api/zoom loads.
  apply();

  fetch("/api/zoom").then((r) => r.ok ? r.json() : null).then(
    function (body: { zoom?: unknown } | null) {
      // A keypress that landed before the fetch wins over the stored value.
      if (chosen === null && typeof body?.zoom === "number") {
        chosen = clampZoom(body.zoom);
        apply();
      }
    },
  ).catch(function () {
    // No host mirror (plain browser dev) — stay on auto.
  });

  controls.zoomIn.addEventListener("click", () => step(1));
  controls.zoomOut.addEventListener("click", () => step(-1));
  controls.reset.addEventListener("click", () => set(null));

  // preventDefault also stops webviews with built-in zoom (WebView2) from
  // stacking theirs on top of this one.
  document.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === "=" || e.key === "+") step(1);
    else if (e.key === "-" || e.key === "_") step(-1);
    else if (e.key === "0") set(null);
    else return;
    e.preventDefault();
  });
  // Trackpad pinch arrives as a burst of tiny ctrl+wheel deltas; one mouse
  // notch is ~100. Accumulate so either way it's one step per notch.
  let wheel = 0;
  document.addEventListener("wheel", function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    wheel += e.deltaMode === 0 ? e.deltaY : e.deltaY * 40;
    if (Math.abs(wheel) < 80) return;
    step(wheel < 0 ? 1 : -1);
    wheel = 0;
  }, { passive: false });
}
