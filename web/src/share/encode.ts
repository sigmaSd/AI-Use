/// <reference lib="dom" />
/**
 * Desktop side: render a single QR code pointing at the local pairing
 * server.
 *
 * The QR used to carry the credentials themselves, cycled across dozens of
 * animated frames to keep any one frame scannable — see host/pairing.ts for
 * why that's gone: the QR now just points at a one-time HTTP handoff, so
 * there's only ever one static, tiny, trivially-scannable code to draw.
 *
 * `lib="dom"` is pulled in explicitly here rather than project-wide in
 * deno.json — this file is the only one in web/src/ using real DOM element
 * types (HTMLCanvasElement); everything else gets by on the Web-standard
 * globals (fetch, localStorage, crypto) Deno's default lib already provides,
 * and report.ts (the Deno-only host) has no reason to see DOM types at all.
 */

import qrcode from "qrcode-generator";

/** Draw `text` as a QR code onto `canvas`. Returns the module count (side length). */
export function drawQr(canvas: HTMLCanvasElement, text: string): number {
  // "0" = auto-pick the smallest QR version that fits; "L" trades away some
  // error-correction headroom for more bytes per frame — fine here since a
  // pairing URL is short and fixed-format, not something that needs to
  // survive heavy print wear.
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();

  const modules = qr.getModuleCount();
  // Comfortably above the CSS display size (#share-canvas's max-width) in
  // native pixels, so modules stay crisp instead of relying on the browser
  // to upscale a smaller bitmap.
  const scale = Math.max(6, Math.floor(360 / modules));
  const size = modules * scale;
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(col * scale, row * scale, scale, scale);
      }
    }
  }
  return modules;
}
