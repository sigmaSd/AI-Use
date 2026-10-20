import { assertEquals, assertRejects } from "@std/assert";
import {
  ChatGPTAuthError,
  ChatGPTClient,
  type ChatGPTSession,
  rotatedSession,
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

const COOKIE = "__Secure-next-auth.session-token";
const NOW = Date.parse("2026-10-20T12:00:00Z");
const SINGLE: ChatGPTSession = { kind: "single", token: "old" };
const SPLIT: ChatGPTSession = {
  kind: "split",
  token0: "old-0",
  token1: "old-1",
};

Deno.test("rotatedSession: picks up a re-issued single cookie", () => {
  assertEquals(
    rotatedSession(SINGLE, [
      `${COOKIE}=new; Path=/; Expires=Wed, 18 Nov 2026 12:00:00 GMT; HttpOnly; Secure; SameSite=Lax`,
    ], NOW),
    { kind: "single", token: "new" },
  );
});

Deno.test("rotatedSession: picks up re-issued chunks", () => {
  assertEquals(
    rotatedSession(
      SPLIT,
      [`${COOKIE}.0=new-0; Path=/`, `${COOKIE}.1=new-1`],
      NOW,
    ),
    { kind: "split", token0: "new-0", token1: "new-1" },
  );
});

Deno.test("rotatedSession: switches shape when the old shape is cleared", () => {
  assertEquals(
    rotatedSession(SPLIT, [
      `${COOKIE}=new; Path=/`,
      `${COOKIE}.0=; Path=/; Max-Age=0`,
      `${COOKIE}.1=; Path=/; Max-Age=0`,
    ], NOW),
    { kind: "single", token: "new" },
  );
  assertEquals(
    rotatedSession(SINGLE, [
      `${COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      `${COOKIE}.0=new-0`,
      `${COOKIE}.1=new-1`,
    ], NOW),
    { kind: "split", token0: "new-0", token1: "new-1" },
  );
});

Deno.test("rotatedSession: ignores an unchanged cookie and unrelated ones", () => {
  assertEquals(rotatedSession(SINGLE, [`${COOKIE}=old; Path=/`], NOW), null);
  assertEquals(
    rotatedSession(SPLIT, [`${COOKIE}.0=old-0`, `${COOKIE}.1=old-1`], NOW),
    null,
  );
  assertEquals(
    rotatedSession(SINGLE, [
      "__Secure-next-auth.callback-url=https%3A%2F%2Fchatgpt.com",
      `${COOKIE}-other=x`,
      "__cf_bm=abc; Expires=Wed, 18 Nov 2026 12:00:00 GMT",
      "garbage",
    ], NOW),
    null,
  );
  assertEquals(rotatedSession(SINGLE, [], NOW), null);
});

Deno.test("rotatedSession: never replaces a session with a deletion or a partial one", () => {
  // Signed out: nothing usable to switch to.
  assertEquals(
    rotatedSession(SINGLE, [`${COOKIE}=; Path=/; Max-Age=0`], NOW),
    null,
  );
  assertEquals(rotatedSession(SPLIT, [`${COOKIE}.0=new-0`], NOW), null);
  // Three chunks cannot be stored, and two of them would be a broken session.
  assertEquals(
    rotatedSession(SPLIT, [
      `${COOKIE}.0=new-0`,
      `${COOKIE}.1=new-1`,
      `${COOKIE}.2=new-2`,
    ], NOW),
    null,
  );
  // Both shapes at once is ambiguous.
  assertEquals(
    rotatedSession(SINGLE, [
      `${COOKIE}=new`,
      `${COOKIE}.0=new-0`,
      `${COOKIE}.1=new-1`,
    ], NOW),
    null,
  );
});

Deno.test("rotatedSession: expiry attributes decide deletion, Max-Age first", () => {
  const past = "Expires=Mon, 19 Oct 2026 12:00:00 GMT";
  const future = "Expires=Wed, 21 Oct 2026 12:00:00 GMT";
  assertEquals(rotatedSession(SINGLE, [`${COOKIE}=new; ${past}`], NOW), null);
  assertEquals(
    rotatedSession(SINGLE, [`${COOKIE}=new; ${future}`], NOW),
    { kind: "single", token: "new" },
  );
  assertEquals(
    rotatedSession(SINGLE, [`${COOKIE}=new; ${future}; Max-Age=0`], NOW),
    null,
  );
  assertEquals(
    rotatedSession(SINGLE, [`${COOKIE}=new; ${past}; Max-Age=3600`], NOW),
    { kind: "single", token: "new" },
  );
  // A later line for the same cookie wins, as in a browser.
  assertEquals(
    rotatedSession(SINGLE, [`${COOKIE}=; Max-Age=0`, `${COOKIE}=new`], NOW),
    { kind: "single", token: "new" },
  );
});

function sessionResponse(accessToken: string, setCookies: string[]): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify({ accessToken }), { headers });
}

function cookieOf(init: RequestInit | undefined): string {
  return (init?.headers as Record<string, string>)["Cookie"];
}

Deno.test("adopts the re-issued session cookie for later refreshes", async () => {
  let now = 10_000_000;
  const sentCookies: string[] = [];
  const rotations: [ChatGPTSession, ChatGPTSession][] = [];

  const client = new ChatGPTClient({
    deviceId: "device-test",
    now: () => now,
    onSessionRotated: (from, to) => rotations.push([from, to]),
    fetchFn: (input, init) => {
      if (urlOf(input).includes("/api/auth/session")) {
        sentCookies.push(cookieOf(init));
        const next = `rotated-${sentCookies.length}`;
        return Promise.resolve(sessionResponse(
          fakeJwt((now + 60_000) / 1000),
          [`${COOKIE}=${next}; Path=/; HttpOnly; Secure`],
        ));
      }
      return Promise.resolve(jsonResponse(200, { plan_type: "plus" }));
    },
  });

  const original: ChatGPTSession = { kind: "single", token: "pasted" };
  await client.fetchUsage(original);
  assertEquals(rotations, [[original, { kind: "single", token: "rotated-1" }]]);

  // The caller may still hold the pasted session until its next poll; the
  // cached token is reused and the next refresh sends the rotated cookie.
  await client.fetchUsage(original);
  assertEquals(sentCookies.length, 1);
  now += 40_000;
  await client.fetchUsage(original);
  assertEquals(sentCookies, [`${COOKIE}=pasted`, `${COOKIE}=rotated-1`]);
  assertEquals(rotations.length, 2);
  assertEquals(rotations[1][1], { kind: "single", token: "rotated-2" });
});

Deno.test("follows two rotations inside one poll", async () => {
  const now = 10_000_000;
  const sentCookies: string[] = [];
  let usageRequests = 0;

  const client = new ChatGPTClient({
    deviceId: "device-test",
    now: () => now,
    fetchFn: (input, init) => {
      if (urlOf(input).includes("/api/auth/session")) {
        sentCookies.push(cookieOf(init));
        return Promise.resolve(sessionResponse(
          fakeJwt((now + 60 * 60_000) / 1000),
          [`${COOKIE}=rotated-${sentCookies.length}`],
        ));
      }
      usageRequests++;
      // First access token rejected: forces a second session exchange.
      return Promise.resolve(
        usageRequests === 1
          ? jsonResponse(401, { detail: "expired" })
          : jsonResponse(200, { plan_type: "plus" }),
      );
    },
  });

  const original: ChatGPTSession = { kind: "single", token: "pasted" };
  await client.fetchUsage(original);
  // Same poll, same stale session object: no third exchange, no old cookie.
  await client.fetchResetCredits(original);
  assertEquals(sentCookies, [`${COOKIE}=pasted`, `${COOKIE}=rotated-1`]);
});

Deno.test("does not rotate when the session exchange fails", async () => {
  let rotated = false;
  const client = new ChatGPTClient({
    deviceId: "device-test",
    onSessionRotated: () => rotated = true,
    fetchFn: () => {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", `${COOKIE}=new`);
      return Promise.resolve(new Response("{}", { headers }));
    },
  });

  await assertRejects(
    () => client.fetchUsage({ kind: "single", token: "pasted" }),
    ChatGPTAuthError,
    "no access token",
  );
  assertEquals(rotated, false);
});
