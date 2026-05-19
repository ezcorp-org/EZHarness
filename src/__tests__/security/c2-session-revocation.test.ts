// Regression test for sec-C2: hooks.server.ts must treat a missing session row
// as REVOKED (401 for API / redirect for browsers) and must NOT silently
// auto-recreate the session. The pre-fix "migration bridge" at hooks.server.ts
// ~line 267 called createSession() whenever a valid JWT arrived without a
// matching session row, making POST /api/auth/logout and admin session
// revocation effectively no-ops for the 30-day JWT lifetime.
//
// Tests fix(sec-C2): 528af05
//
// Strategy: import the `handle` hook with PI_SKIP_INIT set, mock every module
// it depends on, and invoke it directly with a fake RequestEvent. A spy on
// `createSession` proves the bridge is gone: post-fix it is never called, so a
// revoked-session request returns 401 instead of silently minting a new row.
process.env.PI_SKIP_INIT = "1";

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";

// NOTE: we deliberately do NOT call mockServerAlias() here — that helper wires
// $server/* aliases to the real modules, and the overrides below need to win.
// If mockServerAlias() is called after our overrides, it replaces them; if
// called before, Bun may cache its factory output before our override runs.
// Safer to mock every specifier hooks.server.ts touches ourselves.

// ── Spies / mock state ────────────────────────────────────────────
let storedSession:
  | { id: string; userId: string; tokenHash: string }
  | null = null;
let createSessionCalls: Array<Record<string, unknown>> = [];
let touchSessionCalls: string[] = [];

// ── Module mocks (must be registered BEFORE importing hooks.server) ──
//
// Bun resolves $server/* and $lib/* via the .svelte-kit/tsconfig.json paths
// map to the REAL src/ and web/src/lib/ files. `mock.module()` must intercept
// at BOTH the alias specifier AND the resolved relative specifier — otherwise
// Bun may load the real module bypassing the mock. The relative paths below
// are computed from this test file at src/__tests__/security/.
const ctxMock = () => ({
  ensureInitialized: async () => {},
  getBus: () => ({ on: () => {}, off: () => {}, emit: () => {} }),
});
mock.module("$lib/server/context", ctxMock);
mock.module("../../../web/src/lib/server/context", ctxMock);

const jwtMock = () => ({
  getJwtSecret: async () => "test-hs256-secret",
  verifyJWT: async (token: string) => {
    if (token === "valid.jwt") {
      return {
        id: "user-c2",
        email: "c2@test.local",
        name: "C2 User",
        role: "member",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
    }
    return null;
  },
  signJWT: async () => "valid.jwt",
});
mock.module("$server/auth/jwt", jwtMock);
mock.module("../../auth/jwt", jwtMock);

const usersMock = () => ({
  getUserCount: async () => 1,
});
mock.module("$server/db/queries/users", usersMock);
mock.module("../../db/queries/users", usersMock);

const rateLimiterMock = () => ({
  RateLimiter: class {
    check() {
      return { allowed: true };
    }
  },
});
mock.module("$lib/server/security/rate-limiter", rateLimiterMock);
mock.module("../../../web/src/lib/server/security/rate-limiter", rateLimiterMock);

const apiKeysMock = () => ({
  verifyApiKey: async () => null,
  requireScope: () => null,
});
mock.module("$lib/server/security/api-keys", apiKeysMock);
mock.module("../../../web/src/lib/server/security/api-keys", apiKeysMock);

const payloadMock = () => ({
  getMaxPayload: () => 1024 * 1024,
  payloadTooLarge: () =>
    new Response(JSON.stringify({ error: "Payload too large" }), { status: 413 }),
});
mock.module("$lib/server/security/payload", payloadMock);
mock.module("../../../web/src/lib/server/security/payload", payloadMock);

const settingsMock = () => ({
  getSetting: async () => undefined,
  getAllSettings: async () => ({}),
});
mock.module("$server/db/queries/settings", settingsMock);
mock.module("../../db/queries/settings", settingsMock);

const sessionsMock = () => ({
  hashToken: async (t: string) => `hash:${t}`,
  // Hooks call lookupSessionByTokenHash; mirror the same matching logic and
  // wrap into the {session, viaPrevious} discriminator. Revocation test only
  // exercises the current-hash path, so viaPrevious stays false.
  lookupSessionByTokenHash: async (tokenHash: string) => {
    if (storedSession && storedSession.tokenHash === tokenHash) {
      return { session: storedSession, viaPrevious: false };
    }
    return null;
  },
  // Kept so non-hooks consumers (login page, logout endpoint, etc.) imported
  // through the same module mock still work if ever invoked.
  getSessionByTokenHash: async (tokenHash: string) => {
    if (storedSession && storedSession.tokenHash === tokenHash) return storedSession;
    return null;
  },
  // Spy — pre-fix hook imports this; post-fix hook does NOT. The test asserts
  // it is never invoked during a revoked-session request.
  createSession: async (args: Record<string, unknown>) => {
    createSessionCalls.push(args);
    storedSession = {
      id: `recreated-${createSessionCalls.length}`,
      userId: String(args.userId ?? ""),
      tokenHash: String(args.tokenHash ?? ""),
    };
  },
  touchSession: async (id: string) => {
    touchSessionCalls.push(id);
  },
  rotateSessionToken: async () => null,
  deleteExpiredSessions: async () => {},
});
mock.module("$server/db/queries/sessions", sessionsMock);
mock.module("../../db/queries/sessions", sessionsMock);

const errorLogsMock = () => ({
  cleanupOldErrors: async () => {},
});
mock.module("$server/db/queries/error-logs", errorLogsMock);
mock.module("../../db/queries/error-logs", errorLogsMock);

// ── Now import the hook under test ───────────────────────────────
import { handle } from "../../../web/src/hooks.server";

afterAll(() => {
  restoreModuleMocks();
});

// ── Fake RequestEvent factory ────────────────────────────────────
interface FakeCookies {
  get(name: string): string | undefined;
  set(name: string, value: string, opts?: unknown): void;
  delete(name: string, opts?: unknown): void;
  getAll(): Array<{ name: string; value: string }>;
  serialize(): string;
}

function makeEvent({
  method = "GET",
  url,
  cookies = {},
}: {
  method?: string;
  url: string;
  cookies?: Record<string, string>;
}) {
  const cookieStore = new Map<string, string>(Object.entries(cookies));
  const deleted = new Set<string>();
  const cookieJar: FakeCookies = {
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string) => {
      if (value === "") {
        cookieStore.delete(name);
        deleted.add(name);
      } else {
        cookieStore.set(name, value);
      }
    },
    delete: (name: string) => {
      cookieStore.delete(name);
      deleted.add(name);
    },
    getAll: () =>
      [...cookieStore.entries()].map(([name, value]) => ({ name, value })),
    serialize: () =>
      [...cookieStore.entries()].map(([n, v]) => `${n}=${v}`).join("; "),
  };

  const request = new Request(url, {
    method,
    headers: { "user-agent": "test-agent" },
  });

  return {
    event: {
      request,
      url: new URL(url),
      params: {},
      route: { id: null },
      cookies: cookieJar,
      locals: {} as App.Locals,
      platform: {},
      isDataRequest: false,
      isSubRequest: false,
      fetch: globalThis.fetch,
      setHeaders: () => {},
      getClientAddress: () => "127.0.0.1",
    } as any,
    deleted,
  };
}

// Resolver used by handle(). Returning a 200 here simulates "request reached
// the route" — the whole point of the C2 fix is that a revoked-session request
// must NOT reach this function.
let resolveCalls = 0;
const passThroughResolve = async (_event: any) => {
  resolveCalls++;
  return new Response("passed-through", { status: 200 });
};

// Unwrap sveltekit redirect() throw (stubbed in preload.ts as {status, location}).
async function callHandle(event: any) {
  try {
    const res = await handle({ event, resolve: passThroughResolve } as any);
    return { response: res, redirect: null as null | { status: number; location: string } };
  } catch (e: any) {
    if (e && typeof e === "object" && "status" in e && "location" in e) {
      return { response: null, redirect: e as { status: number; location: string } };
    }
    throw e;
  }
}

beforeEach(() => {
  storedSession = null;
  createSessionCalls = [];
  touchSessionCalls = [];
  resolveCalls = 0;
});

// ── Tests ────────────────────────────────────────────────────────

describe("sec-C2: missing session row is treated as revoked (API)", () => {
  test("API request with valid JWT + no session row → 401, no auto-recreate, no pass-through", async () => {
    // No storedSession — simulates a logged-out / admin-revoked user whose
    // cookie JWT is still within its 30-day lifetime.
    const { event } = makeEvent({
      url: "http://localhost/api/conversations",
      cookies: { ezcorp_session: "valid.jwt" },
    });

    const { response, redirect } = await callHandle(event);

    expect(redirect).toBeNull();
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    const body = await response!.json();
    expect(body.error).toMatch(/revoked|expired|required/i);

    // Critical: the handler must NOT have auto-recreated the session row.
    expect(createSessionCalls).toEqual([]);
    // And the request must NOT have been passed through to the route handler.
    expect(resolveCalls).toBe(0);
  });

  test("API request with valid JWT + matching session row → passes through to route", async () => {
    storedSession = {
      id: "sess-live",
      userId: "user-c2",
      tokenHash: "hash:valid.jwt",
    };
    const { event } = makeEvent({
      url: "http://localhost/api/conversations",
      cookies: { ezcorp_session: "valid.jwt" },
    });

    const { response, redirect } = await callHandle(event);

    expect(redirect).toBeNull();
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(resolveCalls).toBe(1);
    // locals.user must have been set from the JWT payload
    expect(event.locals.user).toBeDefined();
    expect(event.locals.user.id).toBe("user-c2");
    // touchSession should have been fired for live sessions
    expect(touchSessionCalls).toEqual(["sess-live"]);
    // And no auto-recreate (live session should never trigger createSession)
    expect(createSessionCalls).toEqual([]);
  });
});

describe("sec-C2: missing session row clears cookies & redirects (browser)", () => {
  test("non-API navigation with valid JWT + no session row → redirect to /login?reason=session_revoked", async () => {
    const { event, deleted } = makeEvent({
      url: "http://localhost/dashboard",
      cookies: { ezcorp_session: "valid.jwt" },
    });

    const { response, redirect } = await callHandle(event);

    expect(response).toBeNull();
    expect(redirect).not.toBeNull();
    expect(redirect!.status).toBe(302);
    // GET nav is bounced with a returnTo so the user lands back on the
    // same page after re-auth (added with the safe-redirect work).
    expect(redirect!.location).toBe("/login?reason=session_revoked&returnTo=%2Fdashboard");

    // Cookies cleared
    expect(deleted.has("ezcorp_session")).toBe(true);

    // Bridge removed
    expect(createSessionCalls).toEqual([]);
    expect(resolveCalls).toBe(0);
  });
});

describe("sec-C2: logout/admin-revoke scenario end-to-end shape", () => {
  test("after a session row is deleted, the next request with the same JWT is 401", async () => {
    // Arrange: session exists.
    storedSession = {
      id: "sess-to-revoke",
      userId: "user-c2",
      tokenHash: "hash:valid.jwt",
    };

    // First request: success, passes through.
    const first = await callHandle(
      makeEvent({
        url: "http://localhost/api/conversations",
        cookies: { ezcorp_session: "valid.jwt" },
      }).event,
    );
    expect(first.response!.status).toBe(200);

    // Simulate logout / admin-revoke: row is deleted.
    storedSession = null;

    // Second request: same JWT cookie, but row is gone.
    const second = await callHandle(
      makeEvent({
        url: "http://localhost/api/conversations",
        cookies: { ezcorp_session: "valid.jwt" },
      }).event,
    );

    expect(second.response).not.toBeNull();
    expect(second.response!.status).toBe(401);
    // The bridge is gone — revocation is permanent until a new login.
    expect(createSessionCalls).toEqual([]);
  });
});
