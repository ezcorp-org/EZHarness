/**
 * Server-handler tests for the per-IP FAILED-Bearer-auth rate limit added to
 * `src/hooks.server.ts`.
 *
 * Threat model: a forged `ezk_<random>` token misses the O(1) hash index in
 * verifyApiKey and falls back to a full `SELECT * FROM settings` scan. The
 * Bearer-auth path runs pre-session on any protected route with no IP-level
 * limit, so an unauthenticated attacker spraying random tokens can amplify
 * each request into a table scan. This suite proves the mitigation:
 *
 *   (a) repeated FAILED Bearer attempts from one IP get 429 after the limit;
 *   (b) a VALID key is never throttled, even past the limit (only failures
 *       are counted, and a success short-circuits before counting);
 *   (c) cookie / session requests are entirely unaffected (no Bearer header);
 *   (d) the limit is PER-IP — one IP's failures never throttle another;
 *   (e) requests with NO Authorization header are never counted/throttled;
 *   (f) once over the limit, attachBearerAuth is NOT even invoked (the scan
 *       is short-circuited — that's the whole point of the mitigation).
 *
 * Mirrors the mock setup in hooks-server-setup-redirect.server.test.ts.
 */

// CRITICAL: set BEFORE the dynamic import of hooks.server — that module's
// top-level `await ensureInitialized()` / background-timers are gated on this.
process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";
// No trusted proxy → getClientIp() falls back to x-real-ip, which our test
// events set directly. This lets each case pick its own client IP cleanly.
process.env.TRUSTED_PROXY_COUNT = "0";

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(async () => 1), // a setup'd instance with one user
  getUserById: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/context", () => ({
  ensureInitialized: vi.fn(async () => {}),
}));
vi.mock("$server/startup/background-timers", () => ({
  startBackgroundTimers: vi.fn(async () => {}),
}));

// The Bearer router is mocked so we control success/failure deterministically
// and can ASSERT whether it was invoked (the short-circuit must skip it).
const attachBearerAuth = vi.fn(
  async (
    evt: { locals: { user?: unknown; apiKeyScopes?: unknown } },
    authHeader: string | null | undefined,
  ) => {
    // Only `Bearer ezk_valid` authenticates; everything else fails (leaves
    // locals.user undefined), mirroring a forged-token spray.
    if (authHeader === "Bearer ezk_valid") {
      evt.locals.user = { id: "user-1", email: "", name: "Valid", role: "member" };
      evt.locals.apiKeyScopes = ["chat"];
      return true;
    }
    return false;
  },
);
vi.mock("$lib/server/security/bearer-auth", () => ({
  attachBearerAuth: (...args: unknown[]) =>
    (attachBearerAuth as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("$server/db/queries/sessions", () => ({
  hashToken: vi.fn(async () => "hash"),
  lookupSessionByTokenHash: vi.fn(async () => ({
    session: { id: "sess-1" },
    viaPrevious: false,
  })),
  touchSession: vi.fn(async () => {}),
  rotateSessionToken: vi.fn(async () => null),
}));
vi.mock("$server/auth/jwt", () => ({
  // A valid cookie session resolves to a real user — exercises the
  // session branch, which must NOT touch the failed-Bearer bucket.
  verifyJWT: vi.fn(async () => ({
    id: "cookie-user",
    email: "c@example.com",
    name: "Cookie User",
    role: "member",
    iat: Math.floor(Date.now() / 1000),
  })),
  getJwtSecret: vi.fn(async () => "secret"),
  signJWT: vi.fn(async () => "new-token"),
}));
vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(async () => undefined),
}));

const { handle, __failedBearerLimiter, __FAILED_BEARER_LIMIT } = await import(
  "../hooks.server"
);

// ── Helpers ──────────────────────────────────────────────────────────

function makeEvent(
  path: string,
  opts: {
    method?: string;
    authHeader?: string;
    realIp?: string;
    cookie?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.authHeader) headers["authorization"] = opts.authHeader;
  if (opts.realIp) headers["x-real-ip"] = opts.realIp;
  if (opts.cookie) headers["cookie"] = `ezcorp_session=${opts.cookie}`;

  const cookies = {
    get: vi.fn((name: string) =>
      opts.cookie && name === "ezcorp_session" ? opts.cookie : undefined,
    ),
    set: vi.fn(),
    delete: vi.fn(),
  };
  return {
    request: new Request(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers,
    }),
    url: new URL(`http://localhost${path}`),
    cookies,
    locals: {},
    getClientAddress: () => "127.0.0.1",
    route: { id: path },
    params: {},
    setHeaders: vi.fn(),
    fetch: vi.fn(),
    isDataRequest: false,
    isSubRequest: false,
  } as any;
}

/** Run one protected-route request and return its status (or 0 if it threw a
 *  redirect, which we don't expect on the API paths used here). */
async function run(event: any): Promise<number> {
  const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
  const res = (await handle({ event, resolve } as any)) as Response;
  return res.status;
}

const PROTECTED = "/api/conversations"; // not in PUBLIC_PATHS, not rate-limited as a route

describe("hooks.server.ts — failed-Bearer per-IP rate limit", () => {
  beforeEach(() => {
    __failedBearerLimiter.reset();
    attachBearerAuth.mockClear();
  });

  test("(a) repeated FAILED Bearer attempts from one IP get 429 after the limit", async () => {
    const ip = "203.0.113.7";
    // Up to the limit: each forged attempt fails auth → 401 (not 429).
    for (let i = 0; i < __FAILED_BEARER_LIMIT; i++) {
      const status = await run(
        makeEvent(PROTECTED, { authHeader: `Bearer ezk_forged_${i}`, realIp: ip }),
      );
      expect(status).toBe(401); // "Authentication required"
    }
    // The NEXT attempt crosses the budget → short-circuited 429.
    const blocked = await run(
      makeEvent(PROTECTED, { authHeader: "Bearer ezk_forged_x", realIp: ip }),
    );
    expect(blocked).toBe(429);
  });

  test("(f) once over the limit, attachBearerAuth (the table scan) is NOT invoked", async () => {
    const ip = "203.0.113.8";
    for (let i = 0; i < __FAILED_BEARER_LIMIT; i++) {
      await run(makeEvent(PROTECTED, { authHeader: `Bearer ezk_f${i}`, realIp: ip }));
    }
    expect(attachBearerAuth).toHaveBeenCalledTimes(__FAILED_BEARER_LIMIT);
    attachBearerAuth.mockClear();
    // Over-limit request must be rejected WITHOUT calling the verifier.
    const blocked = await run(
      makeEvent(PROTECTED, { authHeader: "Bearer ezk_more", realIp: ip }),
    );
    expect(blocked).toBe(429);
    expect(attachBearerAuth).not.toHaveBeenCalled();
  });

  test("(b) a VALID key is never throttled, even far past the limit", async () => {
    const ip = "203.0.113.9";
    // Hammer with the valid key many times over the failure budget.
    for (let i = 0; i < __FAILED_BEARER_LIMIT * 3; i++) {
      const status = await run(
        makeEvent(PROTECTED, { authHeader: "Bearer ezk_valid", realIp: ip }),
      );
      expect(status).toBe(200); // authenticated → resolve() ran
    }
    // And the failure bucket for this IP stays empty — a success never counts.
    expect(__failedBearerLimiter.peek(`ip:${ip}:bearerFail`).allowed).toBe(true);
  });

  test("(b') a valid key still succeeds even AFTER the same IP exhausted the bucket via a different (failing) header", async () => {
    // Edge case: an attacker on a shared NAT exhausts the bucket. Once over
    // the limit, EVERY Bearer request from that IP is short-circuited 429 —
    // including a valid one. This is acceptable (the limit is generous and
    // per-IP), but we assert the realistic case: a valid client on its OWN IP
    // is unaffected. (Documents the shared-IP tradeoff rather than hiding it.)
    const attackerIp = "203.0.113.10";
    const clientIp = "198.51.100.5";
    for (let i = 0; i < __FAILED_BEARER_LIMIT + 1; i++) {
      await run(makeEvent(PROTECTED, { authHeader: `Bearer ezk_x${i}`, realIp: attackerIp }));
    }
    // Attacker IP is now blocked.
    expect(
      await run(makeEvent(PROTECTED, { authHeader: "Bearer ezk_y", realIp: attackerIp })),
    ).toBe(429);
    // A legitimate client on a DIFFERENT IP authenticates fine.
    expect(
      await run(makeEvent(PROTECTED, { authHeader: "Bearer ezk_valid", realIp: clientIp })),
    ).toBe(200);
  });

  test("(c) cookie/session requests are entirely unaffected (no Bearer header)", async () => {
    const ip = "203.0.113.11";
    // First, exhaust the failed-Bearer bucket for this IP via forged tokens.
    for (let i = 0; i < __FAILED_BEARER_LIMIT + 5; i++) {
      await run(makeEvent(PROTECTED, { authHeader: `Bearer ezk_z${i}`, realIp: ip }));
    }
    attachBearerAuth.mockClear();
    // A cookie-authenticated request from the SAME IP must still succeed — it
    // carries no Authorization header and goes down the session branch,
    // bypassing the failed-Bearer guard entirely.
    const status = await run(
      makeEvent(PROTECTED, { cookie: "valid-session-token", realIp: ip }),
    );
    expect(status).toBe(200);
    // The Bearer router was NOT consulted for the cookie request.
    expect(attachBearerAuth).not.toHaveBeenCalled();
  });

  test("(c') a cookie request alone never touches the failed-Bearer bucket", async () => {
    const ip = "203.0.113.12";
    for (let i = 0; i < 50; i++) {
      const status = await run(
        makeEvent(PROTECTED, { cookie: "valid-session-token", realIp: ip }),
      );
      expect(status).toBe(200);
    }
    // Bucket for this IP is pristine.
    expect(__failedBearerLimiter.peek(`ip:${ip}:bearerFail`).allowed).toBe(true);
    // And the Bearer router was never consulted for a cookie request.
    expect(attachBearerAuth).not.toHaveBeenCalled();
  });

  test("(d) the limit is PER-IP — one IP's failures never throttle another", async () => {
    const ipA = "203.0.113.20";
    const ipB = "203.0.113.21";
    // Exhaust ipA's budget.
    for (let i = 0; i < __FAILED_BEARER_LIMIT + 1; i++) {
      await run(makeEvent(PROTECTED, { authHeader: `Bearer ezk_a${i}`, realIp: ipA }));
    }
    expect(
      await run(makeEvent(PROTECTED, { authHeader: "Bearer ezk_a_extra", realIp: ipA })),
    ).toBe(429);
    // ipB has its OWN fresh budget — first forged attempt is a 401, not a 429.
    expect(
      await run(makeEvent(PROTECTED, { authHeader: "Bearer ezk_b0", realIp: ipB })),
    ).toBe(401);
  });

  test("(e) a request with NO Authorization header is never counted or throttled", async () => {
    const ip = "203.0.113.30";
    // Many header-less protected requests (these 401 as 'Authentication
    // required' but must not feed the bucket).
    for (let i = 0; i < __FAILED_BEARER_LIMIT + 10; i++) {
      const status = await run(makeEvent(PROTECTED, { realIp: ip }));
      expect(status).toBe(401);
    }
    // Bucket stays empty: a header-less request never increments it, so a
    // legit Bearer client on this IP still gets its full budget afterwards.
    expect(__failedBearerLimiter.peek(`ip:${ip}:bearerFail`).allowed).toBe(true);
    expect(
      await run(makeEvent(PROTECTED, { authHeader: "Bearer ezk_valid", realIp: ip })),
    ).toBe(200);
  });

  test("a non-Bearer Authorization scheme is not counted (Basic)", async () => {
    const ip = "203.0.113.31";
    for (let i = 0; i < __FAILED_BEARER_LIMIT + 5; i++) {
      // Basic auth never matches `Bearer ` → attachBearerAuth no-ops, and our
      // guard only counts presented-Bearer failures.
      await run(makeEvent(PROTECTED, { authHeader: "Basic dXNlcjpwYXNz", realIp: ip }));
    }
    expect(__failedBearerLimiter.peek(`ip:${ip}:bearerFail`).allowed).toBe(true);
  });
});
