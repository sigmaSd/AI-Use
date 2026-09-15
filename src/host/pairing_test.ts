import { assert, assertEquals } from "@std/assert";
import { startPairingServer } from "./pairing.ts";

Deno.test("pairing server publishes on demand and closes cleanly", async () => {
  const pairing = startPairingServer();
  const url = pairing.publish("test-code-12345678", "{}");
  if (url !== null) {
    assert(url.startsWith("http://"), `expected LAN url, got ${url}`);
    assertEquals(pairing.status("test-code-12345678"), "waiting");
  }
  await pairing.close();
  // close() is idempotent and safe when the listener was never up.
  await pairing.close();
});
