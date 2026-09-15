import { assertEquals } from "@std/assert";
import {
  clearPersistedTokens,
  readPersistedTokens,
  writePersistedTokens,
} from "./tokens.ts";

function reset() {
  clearPersistedTokens("all");
}

Deno.test("round-trips each provider independently", () => {
  reset();
  writePersistedTokens({
    claudeToken: "sk-ant-test",
    chatgptSessionToken: "single-abc",
    opencodeToken: "oc-test",
    opencodeWorkspaceId: "wrk_test",
  });

  assertEquals(readPersistedTokens(), {
    claudeToken: "sk-ant-test",
    chatgptSessionToken: "single-abc",
    opencodeToken: "oc-test",
    opencodeWorkspaceId: "wrk_test",
  });
  reset();
});

Deno.test("split chatgpt form is preserved when no single is set", () => {
  reset();
  writePersistedTokens({ chatgptSession0: "p0", chatgptSession1: "p1" });

  assertEquals(readPersistedTokens(), {
    chatgptSession0: "p0",
    chatgptSession1: "p1",
  });
  reset();
});

Deno.test("single chatgpt write clears a stale split pair", () => {
  reset();
  writePersistedTokens({ chatgptSession0: "p0", chatgptSession1: "p1" });
  writePersistedTokens({ chatgptSessionToken: "single-new" });

  assertEquals(readPersistedTokens(), { chatgptSessionToken: "single-new" });
  reset();
});

Deno.test("clear is scoped per provider", () => {
  reset();
  writePersistedTokens({
    claudeToken: "sk-ant-test",
    chatgptSessionToken: "single-abc",
    opencodeToken: "oc-test",
  });
  clearPersistedTokens("chatgpt");

  assertEquals(readPersistedTokens(), {
    claudeToken: "sk-ant-test",
    opencodeToken: "oc-test",
  });
  reset();
});
