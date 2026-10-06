import { assertEquals } from "@std/assert";
import { autoZoom, clampZoom, stepZoom } from "./zoom.ts";

Deno.test("autoZoom: 1 up to the base width, 1.5 cap, 0.05 steps", () => {
  assertEquals(autoZoom(0), 1);
  assertEquals(autoZoom(390), 1);
  assertEquals(autoZoom(1366), 1);
  assertEquals(autoZoom(1536), 1);
  assertEquals(autoZoom(1920), 1.25);
  assertEquals(autoZoom(2560), 1.5);
  assertEquals(autoZoom(3840), 1.5);
});

Deno.test("stepZoom: walks the browser-style step list", () => {
  assertEquals(stepZoom(1, 1), 1.1);
  assertEquals(stepZoom(1.1, 1), 1.25);
  assertEquals(stepZoom(1.25, -1), 1.1);
  assertEquals(stepZoom(1.2, 1), 1.25);
  assertEquals(stepZoom(1.2, -1), 1.1);
  assertEquals(stepZoom(2, 1), 2);
  assertEquals(stepZoom(0.8, -1), 0.8);
});

Deno.test("clampZoom: bounds and rounding", () => {
  assertEquals(clampZoom(5), 2);
  assertEquals(clampZoom(0.1), 0.8);
  assertEquals(clampZoom(1.234), 1.23);
});
