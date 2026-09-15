import { assertEquals, assertRejects } from "@std/assert";
import {
  ChatGPTAuthError,
  ChatGPTClient,
  sessionCookieHeader,
} from "./chatgpt.ts";

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

  const session = { kind: "single", token: "session-single" } as const;
  await client.fetchUsage(session);
  await client.fetchUsage(session);

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

  const session = { kind: "single", token: "session-single" } as const;
  await client.fetchUsage(session);
  now += 40_000;
  await client.fetchUsage(session);

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

  const result = await client.fetchUsage(
    { kind: "split", token0: "session-0", token1: "session-1" },
  );

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
    () =>
      client.fetchUsage(
        { kind: "split", token0: "session-0", token1: "session-1" },
      ),
    ChatGPTAuthError,
    "auth failed: 403",
  );

  assertEquals(sessionRequests, 2);
  assertEquals(usageRequests, 2);
});

Deno.test("single session sends one un-chunked cookie", async () => {
  const now = 10_000_000;
  const accessToken = fakeJwt((now + 60 * 60_000) / 1000);
  let cookieHeader: string | null = null;

  const client = new ChatGPTClient({
    deviceId: "device-test",
    now: () => now,
    fetchFn: (input, init) => {
      if (urlOf(input).includes("/api/auth/session")) {
        cookieHeader = (init?.headers as Record<string, string>)["Cookie"];
        return Promise.resolve(jsonResponse(200, { accessToken }));
      }
      return Promise.resolve(jsonResponse(200, { plan_type: "plus" }));
    },
  });

  await client.fetchUsage({ kind: "single", token: "abc123" });

  assertEquals(
    cookieHeader,
    "__Secure-next-auth.session-token=abc123",
  );
  assertEquals(
    sessionCookieHeader({ kind: "single", token: "abc123" }),
    "__Secure-next-auth.session-token=abc123",
  );
});

Deno.test("split session sends both chunked cookies", async () => {
  const now = 10_000_000;
  const accessToken = fakeJwt((now + 60 * 60_000) / 1000);
  let cookieHeader: string | null = null;

  const client = new ChatGPTClient({
    deviceId: "device-test",
    now: () => now,
    fetchFn: (input, init) => {
      if (urlOf(input).includes("/api/auth/session")) {
        cookieHeader = (init?.headers as Record<string, string>)["Cookie"];
        return Promise.resolve(jsonResponse(200, { accessToken }));
      }
      return Promise.resolve(jsonResponse(200, { plan_type: "plus" }));
    },
  });

  await client.fetchUsage(
    { kind: "split", token0: "part-0", token1: "part-1" },
  );

  assertEquals(
    cookieHeader,
    "__Secure-next-auth.session-token.0=part-0; __Secure-next-auth.session-token.1=part-1",
  );
});
