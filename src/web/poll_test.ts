import { assertEquals } from "@std/assert";
import { persistRotatedChatGPTSession } from "./poll.ts";
import {
  clearChatGPTSession,
  getChatGPTSession,
  setChatGPTSessionSingle,
  setChatGPTSessionSplit,
} from "./store.ts";

Deno.test("persistRotatedChatGPTSession: replaces the stored session", () => {
  try {
    setChatGPTSessionSingle("old");
    persistRotatedChatGPTSession(
      { kind: "single", token: "old" },
      { kind: "single", token: "new" },
    );
    assertEquals(getChatGPTSession(), { kind: "single", token: "new" });

    // Shape changes replace the other shape's keys too.
    persistRotatedChatGPTSession(
      { kind: "single", token: "new" },
      { kind: "split", token0: "p0", token1: "p1" },
    );
    assertEquals(getChatGPTSession(), {
      kind: "split",
      token0: "p0",
      token1: "p1",
    });
  } finally {
    clearChatGPTSession();
  }
});

Deno.test("persistRotatedChatGPTSession: a reconnect during the refresh wins", () => {
  try {
    setChatGPTSessionSplit("pasted-0", "pasted-1");
    persistRotatedChatGPTSession(
      { kind: "single", token: "old" },
      { kind: "single", token: "rotated-from-old" },
    );
    assertEquals(getChatGPTSession(), {
      kind: "split",
      token0: "pasted-0",
      token1: "pasted-1",
    });

    // Disconnected meanwhile: stays disconnected.
    clearChatGPTSession();
    persistRotatedChatGPTSession(
      { kind: "single", token: "old" },
      { kind: "single", token: "rotated-from-old" },
    );
    assertEquals(getChatGPTSession(), null);
  } finally {
    clearChatGPTSession();
  }
});
