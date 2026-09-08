import { assertEquals, assertRejects } from "@std/assert";
import { ChatGPTAuthError, ChatGPTClient } from "./chatgpt.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeJwt(exp: number): string {
  const payload = btoa(JSON.stringify({ exp }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

function urlOf(input: Request | URL | string): string {
  return typeof input === "string" ? input : input.toString();
}

Deno.test("reuses a valid access token across usage polls", async () => {
  const now = 10_000_000;
  const accessToken = fakeJwt((now + 60 * 60_000) / 1000);
  let sessionRequests = 0;
  let usageRequests = 0;

  const client = new ChatGPTClient({
    deviceId: "device-test",
    now: () => now,
    fetchFn: (input) => {
      if (urlOf(input).includes("/api/auth/session")) {
        sessionRequests++;
        return Promise.resolve(jsonResponse(200, { accessToken }));
      }
      usageRequests++;
      return Promise.resolve(jsonResponse(200, { plan_type: "plus" }));
    },
  });

  await client.fetchUsage("session-0", "session-1");
  await client.fetchUsage("session-0", "session-1");

  assertEquals(sessionRequests, 1);
  assertEquals(usageRequests, 2);
});

Deno.test("refreshes the access token after expiry", async () => {
  let now = 10_000_000;
  let sessionRequests = 0;

  const client = new ChatGPTClient({
    deviceId: "device-test",
    now: () => now,
    fetchFn: (input) => {
      if (urlOf(input).includes("/api/auth/session")) {
        sessionRequests++;
        return Promise.resolve(jsonResponse(
          200,
          { accessToken: fakeJwt((now + 60_000) / 1000) },
        ));
      }
      return Promise.resolve(jsonResponse(200, { plan_type: "plus" }));
    },
  });

  await client.fetchUsage("session-0", "session-1");
  now += 40_000;
  await client.fetchUsage("session-0", "session-1");

  assertEquals(sessionRequests, 2);
});

Deno.test("refreshes once when the usage token is rejected", async () => {
  const now = 10_000_000;
  let sessionRequests = 0;
  let usageRequests = 0;

  const client = new ChatGPTClient({
    deviceId: "device-test",
    now: () => now,
    fetchFn: (input) => {
      if (urlOf(input).includes("/api/auth/session")) {
        sessionRequests++;
        return Promise.resolve(jsonResponse(
          200,
          { accessToken: fakeJwt((now + 60 * 60_000) / 1000) },
        ));
      }
      usageRequests++;
      return Promise.resolve(
        usageRequests === 1
          ? jsonResponse(403, { detail: "expired" })
          : jsonResponse(200, { plan_type: "plus" }),
      );
    },
  });

  const result = await client.fetchUsage("session-0", "session-1");

  assertEquals(result.plan_type, "plus");
  assertEquals(sessionRequests, 2);
  assertEquals(usageRequests, 2);
});

Deno.test("surfaces an auth error after the refresh retry also fails", async () => {
  const now = 10_000_000;
  let sessionRequests = 0;
  let usageRequests = 0;

  const client = new ChatGPTClient({
    deviceId: "device-test",
    now: () => now,
    fetchFn: (input) => {
      if (urlOf(input).includes("/api/auth/session")) {
        sessionRequests++;
        return Promise.resolve(jsonResponse(
          200,
          { accessToken: fakeJwt((now + 60 * 60_000) / 1000) },
        ));
      }
      usageRequests++;
      return Promise.resolve(jsonResponse(403, { detail: "forbidden" }));
    },
  });

  await assertRejects(
    () => client.fetchUsage("session-0", "session-1"),
    ChatGPTAuthError,
    "auth failed: 403",
  );

  assertEquals(sessionRequests, 2);
  assertEquals(usageRequests, 2);
});
