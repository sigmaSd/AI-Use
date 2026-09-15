import { assertEquals } from "@std/assert";
import { startPairingServer } from "./pairing.ts";

Deno.test("pairing server closes cleanly", async () => {
  const pairing = startPairingServer();
  pairing.publish("test-code-12345678", "{}");
  assertEquals(pairing.status("test-code-12345678"), "waiting");
  await pairing.close();
});
