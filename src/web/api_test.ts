import { assertEquals } from "@std/assert";
import { normalizeChatGPTSession } from "./api.ts";

Deno.test("normalizeChatGPTSession: bare single value", () => {
  assertEquals(normalizeChatGPTSession("abc"), { single: "abc" });
});

Deno.test("normalizeChatGPTSession: prefixed single value", () => {
  assertEquals(
    normalizeChatGPTSession("__Secure-next-auth.session-token=abc;"),
    { single: "abc" },
  );
});

Deno.test("normalizeChatGPTSession: bare .0 in first field, .1 in second", () => {
  assertEquals(
    normalizeChatGPTSession("p0", undefined, "p1"),
    { part0: "p0", part1: "p1" },
  );
});

Deno.test("normalizeChatGPTSession: prefixed .0 in the single field", () => {
  assertEquals(
    normalizeChatGPTSession(
      "__Secure-next-auth.session-token.0=p0",
      undefined,
      "__Secure-next-auth.session-token.1=p1",
    ),
    { part0: "p0", part1: "p1" },
  );
});

Deno.test("normalizeChatGPTSession: whole cookie string pasted", () => {
  assertEquals(
    normalizeChatGPTSession(
      "foo=bar; __Secure-next-auth.session-token.0=p0; " +
        "__Secure-next-auth.session-token.1=p1; baz=qux",
    ),
    { part0: "p0", part1: "p1" },
  );
});

Deno.test("normalizeChatGPTSession: lone .0 stays incomplete", () => {
  assertEquals(
    normalizeChatGPTSession("__Secure-next-auth.session-token.0=p0"),
    { part0: "p0" },
  );
});
