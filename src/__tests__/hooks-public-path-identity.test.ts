/**
 * Public `/api/*` paths identify their caller without ever requiring one —
 * exercised through the REAL `hooks.server.ts` `handle`.
 *
 * The defect: `event.locals.user` was assigned ONLY inside the
 * `if (!isPublic)` block, so a PUBLIC_PATHS entry could never see a principal.
 * `GET /api/health?detail=true` gates on `role === "admin"`, so it answered
 * 401 to admins too and the Settings → System Health card
 * (`SystemHealth.svelte` polls exactly that URL) could only ever render
 * "Unable to load health status."
 *
 * F5's remedy — move the bare path into PUBLIC_SUBPATHS_ONLY, as was done for
 * `/api/auth/invite` and `POST /api/auth/reset-password` — cannot apply here:
 * `/api/health` is a liveness probe and its bare path must answer an anonymous
 * caller forever. So enforcement and identification were split instead, and
 * the three properties that split has to keep are pinned below:
 *
 *   1. the cookieless probe does ZERO I/O (no secret read, no session lookup);
 *   2. no verdict can ever fail the request — not a bad cookie, not a revoked
 *      session, not a dead DB (which is exactly when a probe matters most);
 *   3. the principal is no weaker than the enforcing branch's — same signature
 *      check, same revoked-row check.
 *
 * The second describe block re-proves every outcome of the ENFORCING branch,
 * which was refactored onto the same shared `verifySessionCookie`. Those
 * assertions are the regression net for that refactor: identical behaviour,
 * one implementation.
 *
 * Strategy (and mock layout) copied from `security/c2-session-revocation.test.ts`:
 * import `handle` with PI_SKIP_INIT set, mock every module it reaches for, and
 * invoke it with a fake RequestEvent. This is a bun:test rather than a
 * `web/src/__tests__/*.server.test.ts` on purpose — the node/vitest coverage
 * leg measures an explicit allowlist of source files that does not include
 * `web/src/hooks.server.ts`, so a vitest home would leave every line of this
 * fix unmeasured (the "tested but unmeasured" trap called out in
 * scripts/test-coverage.sh). The bun host pool instruments hooks.server.ts
 * already, via this and its sibling suites.
 */
process.env.PI_SKIP_INIT = "1";

import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Mock state, reset per test ────────────────────────────────────
let secretThrows = false;
let jwtPayload: Record<string, unknown> | null = null;
let lookupResult: { session: { id: string }; viaPrevious: boolean } | null = null;
let lookupThrows = false;
let calls = {
  getJwtSecret: 0,
  hashToken: 0,
  lookup: 0,
  getUserCount: 0,
  signJWT: 0,
  rotate: 0,
  touched: [] as string[],
};

// ── Module mocks (must be registered BEFORE importing hooks.server) ──
//
// Bun resolves $server/* and $lib/* through .svelte-kit/tsconfig.json's paths
// map to the REAL files, so `mock.module()` must intercept at BOTH the alias
// specifier AND the resolved relative specifier or the real module can load
// past the mock. Relative paths below are computed from `src/__tests__/`.
const ctxMock = () => ({
  ensureInitialized: async () => {},
  getBus: () => ({ on: () => {}, off: () => {}, emit: () => {} }),
});
mock.module("$lib/server/context", ctxMock);
mock.module("../../web/src/lib/server/context", ctxMock);

// NOT mocked, deliberately: `$server/startup/background-timers` (its two
// exports are only called from the boot block PI_SKIP_INIT disables) and
// `$lib/server/security/bearer-auth` (`attachBearerAuth` runs only for a
// COOKIELESS request on a NON-public path, which no case below produces).
// Mocking either would add a mock.module target that
// `mock-cleanup-coverage.test.ts` requires to be snapshotted — a shared-list
// edit for two functions this file never invokes.
const jwtMock = () => ({
  getJwtSecret: async () => {
    calls.getJwtSecret++;
    if (secretThrows) throw new Error("DB down");
    return "test-hs256-secret";
  },
  verifyJWT: async () => jwtPayload,
  signJWT: async () => {
    calls.signJWT++;
    return "rotated-token";
  },
});
mock.module("$server/auth/jwt", jwtMock);
mock.module("../auth/jwt", jwtMock);

const usersMock = () => ({
  getUserCount: async () => {
    calls.getUserCount++;
    return 1;
  },
  // The onboarding gate runs for authenticated PAGE navigations; return an
  // onboarded row so it never redirects and masks what we're asserting.
  getUserById: async (id: string) => ({ id, onboardedAt: new Date(0) }),
});
mock.module("$server/db/queries/users", usersMock);
mock.module("../db/queries/users", usersMock);

const settingsMock = () => ({
  getSetting: async () => undefined,
  getAllSettings: async () => ({}),
});
mock.module("$server/db/queries/settings", settingsMock);
mock.module("../db/queries/settings", settingsMock);

const sessionsMock = () => ({
  hashToken: async (t: string) => {
    calls.hashToken++;
    return `hash:${t}`;
  },
  lookupSessionByTokenHash: async () => {
    calls.lookup++;
    if (lookupThrows) throw new Error("DB down");
    return lookupResult;
  },
  touchSession: async (id: string) => {
    calls.touched.push(id);
  },
  rotateSessionToken: async () => {
    calls.rotate++;
    return null;
  },
  deleteExpiredSessions: async () => {},
});
mock.module("$server/db/queries/sessions", sessionsMock);
mock.module("../db/queries/sessions", sessionsMock);

// ── Import the hook under test ────────────────────────────────────
// DYNAMIC import: a static one is hoisted above the PI_SKIP_INIT assignment
// at the top of this file, so hooks.server.ts's boot block would run the REAL
// ensureInitialized() before the guard is set.
let handle: typeof import("../../web/src/hooks.server").handle;
beforeAll(async () => {
  ({ handle } = await import("../../web/src/hooks.server"));
});

afterAll(() => {
  restoreModuleMocks();
});

// ── Fake RequestEvent factory ─────────────────────────────────────
function makeEvent(path: string, opts: { method?: string; cookie?: string } = {}) {
  const cookieSets: Array<{ name: string; value: string }> = [];
  const cookieDeletes: string[] = [];
  const cookies = {
    get: (name: string) => (opts.cookie && name === "ezcorp_session" ? opts.cookie : undefined),
    set: (name: string, value: string) => {
      cookieSets.push({ name, value });
    },
    delete: (name: string) => {
      cookieDeletes.push(name);
    },
    getAll: () => [],
    serialize: () => "",
  };

  const event = {
    request: new Request(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers: opts.cookie ? { cookie: `ezcorp_session=${opts.cookie}` } : {},
    }),
    url: new URL(`http://localhost${path}`),
    params: {},
    route: { id: path },
    cookies,
    locals: {} as App.Locals,
    platform: {},
    isDataRequest: false,
    isSubRequest: false,
    fetch: globalThis.fetch,
    setHeaders: () => {},
    getClientAddress: () => "127.0.0.1",
  } as never as {
    locals: { user?: { id: string; role: string }; authMethod?: string };
  };

  return { event, cookieSets, cookieDeletes };
}

/** Drive `handle`, unwrapping preload.ts's `redirect()` throw shape. */
async function callHandle(event: unknown, resolve?: () => Promise<Response>) {
  const resolveFn = resolve ?? (async () => new Response("ok", { status: 200 }));
  let resolveCalls = 0;
  const wrapped = async () => {
    resolveCalls++;
    return resolveFn();
  };
  try {
    const response = (await handle({ event, resolve: wrapped } as never)) as Response;
    return {
      response,
      redirect: null as null | { status: number; location: string },
      resolveCalls,
    };
  } catch (e) {
    if (e && typeof e === "object" && "status" in e && "location" in e) {
      return {
        response: null,
        redirect: e as { status: number; location: string },
        resolveCalls,
      };
    }
    throw e;
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

const ADMIN_PAYLOAD = {
  id: "admin-1",
  email: "a@x",
  name: "A",
  role: "admin",
  // Fresh enough that the sliding-refresh branch is skipped by default.
  iat: nowSeconds(),
  exp: nowSeconds() + 3600,
};

/** A live, non-revoked session row for the inbound cookie. */
const LIVE_ROW = { session: { id: "sess-1" }, viaPrevious: false };

beforeEach(() => {
  secretThrows = false;
  jwtPayload = null;
  lookupResult = null;
  lookupThrows = false;
  calls = {
    getJwtSecret: 0,
    hashToken: 0,
    lookup: 0,
    getUserCount: 0,
    signJWT: 0,
    rotate: 0,
    touched: [],
  };
});

describe("hooks: opportunistic identification on public /api/* paths", () => {
  // ── Property 1: the probe still costs nothing ──────────────────────
  for (const path of ["/api/health", "/api/ready", "/api/version"]) {
    test(`${path} with NO cookie: anonymous, and not one byte of I/O`, async () => {
      const { event } = makeEvent(path);

      const { response, resolveCalls } = await callHandle(event);

      expect(response!.status).toBe(200);
      expect(resolveCalls).toBe(1);
      expect(event.locals.user).toBeUndefined();
      expect(event.locals.authMethod).toBeUndefined();
      // The whole point: an orchestrator polling this path every few seconds
      // must not be charged a JWT-secret read or a session lookup for it.
      expect(calls.getJwtSecret).toBe(0);
      expect(calls.hashToken).toBe(0);
      expect(calls.lookup).toBe(0);
      expect(calls.getUserCount).toBe(0);
    });
  }

  // ── The regression that matters ────────────────────────────────────
  test("GET /api/health?detail=true with a valid ADMIN cookie → hook populates locals.user", async () => {
    jwtPayload = ADMIN_PAYLOAD;
    lookupResult = LIVE_ROW;

    const { event } = makeEvent("/api/health?detail=true", { cookie: "jwt-token" });
    const { response, resolveCalls } = await callHandle(event);

    expect(response!.status).toBe(200);
    expect(resolveCalls).toBe(1);
    // This is the assertion the pre-fix tree cannot satisfy — and it is the
    // whole reason the admin System Health card could never load.
    expect(event.locals.user).toEqual({
      id: "admin-1",
      email: "a@x",
      name: "A",
      role: "admin",
    } as never);
    // Property 3: the principal came through the same verification the
    // enforcing branch uses, so it carries the same method stamp.
    expect(event.locals.authMethod).toBe("session");
  });

  test("a MEMBER cookie is identified as a member, not silently promoted", async () => {
    // The detail gate is `role === "admin"`; a hook that stamped a principal
    // without carrying its role would hand every logged-in user the detailed
    // probe. The role must survive the trip verbatim.
    jwtPayload = { ...ADMIN_PAYLOAD, id: "member-1", role: "member" };
    lookupResult = LIVE_ROW;

    const { event } = makeEvent("/api/health?detail=true", { cookie: "jwt-token" });
    await callHandle(event);

    expect(event.locals.user!.id).toBe("member-1");
    expect(event.locals.user!.role).toBe("member");
  });

  // ── Property 3: no weaker than the enforcing branch ────────────────
  test("a REVOKED session identifies nobody (and the request still succeeds)", async () => {
    // Logout / admin force-logout deletes the row while the JWT stays within
    // its 90-day lifetime. If the public branch skipped the row check, a
    // force-logged-out admin would keep reading the detailed probe.
    jwtPayload = ADMIN_PAYLOAD;
    lookupResult = null;

    const { event } = makeEvent("/api/health?detail=true", { cookie: "jwt-token" });
    const { response } = await callHandle(event);

    expect(response!.status).toBe(200);
    expect(event.locals.user).toBeUndefined();
    expect(event.locals.authMethod).toBeUndefined();
  });

  // ── Property 2: never fails the request ────────────────────────────
  test("an UNVERIFIABLE cookie is ignored — anonymous 200, and the cookie is NOT cleared", async () => {
    // The enforcing branch answers 401 and clears the cookie here. A public
    // path must do neither: a garbage cookie on a liveness probe is not a
    // reason to log the user out of the app.
    jwtPayload = null;

    const { event, cookieSets, cookieDeletes } = makeEvent("/api/health", {
      cookie: "garbage",
    });
    const { response, resolveCalls } = await callHandle(event);

    expect(response!.status).toBe(200);
    expect(resolveCalls).toBe(1);
    expect(event.locals.user).toBeUndefined();
    expect(cookieSets).toEqual([]);
    expect(cookieDeletes).toEqual([]);
  });

  test("DB down (getJwtSecret throws) → probe still answers 200, anonymously", async () => {
    // The moment a liveness probe earns its keep. `getJwtSecret` reads the
    // settings table when the secret isn't cached yet, so a cold process
    // meeting a dead DB hits exactly this. It must not become a 500.
    secretThrows = true;

    const { event } = makeEvent("/api/health?detail=true", { cookie: "jwt-token" });
    const { response, resolveCalls } = await callHandle(event);

    expect(response!.status).toBe(200);
    expect(resolveCalls).toBe(1);
    expect(event.locals.user).toBeUndefined();
  });

  test("DB down (session lookup throws) → JWT-only fallback still identifies the admin", async () => {
    // Same fallback the enforcing branch takes: a verified signature is enough
    // when the revocation table cannot be consulted. Without it, the detailed
    // probe would go dark during precisely the outage it exists to describe.
    jwtPayload = ADMIN_PAYLOAD;
    lookupThrows = true;

    const { event } = makeEvent("/api/health?detail=true", { cookie: "jwt-token" });
    const { response } = await callHandle(event);

    expect(response!.status).toBe(200);
    expect(event.locals.user!.id).toBe("admin-1");
    expect(event.locals.user!.role).toBe("admin");
  });

  // ── Scope guards ───────────────────────────────────────────────────
  test("a public PAGE route with a valid cookie stays principal-free", async () => {
    // `/login` and friends are the pre-auth funnel. Handing them a principal
    // would pull them under the onboarding-redirect gate and change navigation
    // for a half-onboarded user — a behaviour change this defect never needed.
    // The `/api/` scoping is what prevents it.
    jwtPayload = ADMIN_PAYLOAD;
    lookupResult = LIVE_ROW;

    const { event } = makeEvent("/login", { cookie: "jwt-token" });
    const { response } = await callHandle(event);

    expect(response!.status).toBe(200);
    expect(event.locals.user).toBeUndefined();
    expect(calls.getJwtSecret).toBe(0);
  });

  test("a public API path never re-issues the cookie (no sliding refresh)", async () => {
    // A path that does not REQUIRE a session has no business rotating one.
    // The inbound JWT here is well past the refresh threshold, which on a
    // protected path would sign a new token and Set-Cookie.
    jwtPayload = { ...ADMIN_PAYLOAD, iat: nowSeconds() - 400 * 24 * 3600 };
    lookupResult = LIVE_ROW;

    const { event, cookieSets } = makeEvent("/api/health?detail=true", {
      cookie: "jwt-token",
    });
    await callHandle(event);

    expect(event.locals.user!.role).toBe("admin");
    expect(calls.signJWT).toBe(0);
    expect(calls.rotate).toBe(0);
    expect(cookieSets).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The enforcing branch was refactored onto the SAME `verifySessionCookie` used
// above, so every one of its outcomes is re-pinned here. A shared verifier is
// only an improvement if it provably did not move any of these.
// ───────────────────────────────────────────────────────────────────────────
describe("hooks: the enforcing branch keeps every outcome", () => {
  test("valid session on a protected API path → principal stamped, request served", async () => {
    jwtPayload = ADMIN_PAYLOAD;
    lookupResult = LIVE_ROW;

    const { event } = makeEvent("/api/conversations", { cookie: "jwt-token" });
    const { response } = await callHandle(event);

    expect(response!.status).toBe(200);
    expect(event.locals.user!.id).toBe("admin-1");
    expect(event.locals.authMethod).toBe("session");
    // Live sessions get their throttled activity touch.
    expect(calls.touched).toEqual(["sess-1"]);
  });

  test("unverifiable cookie on a protected API path → 401 Session expired, cookie cleared", async () => {
    jwtPayload = null;

    const { event, cookieSets } = makeEvent("/api/conversations", { cookie: "garbage" });
    const { response, resolveCalls } = await callHandle(event);

    expect(response!.status).toBe(401);
    expect(((await response!.json()) as { error?: string }).error).toBe("Session expired");
    expect(resolveCalls).toBe(0);
    expect(cookieSets).toEqual([{ name: "ezcorp_session", value: "" }]);
  });

  test("unverifiable cookie on a protected PAGE → redirect to /login?reason=session_expired", async () => {
    jwtPayload = null;

    const { event } = makeEvent("/projects/abc", { cookie: "garbage" });
    const { redirect, resolveCalls } = await callHandle(event);

    expect(redirect).not.toBeNull();
    expect(redirect!.status).toBe(302);
    expect(redirect!.location).toBe("/login?reason=session_expired&returnTo=%2Fprojects%2Fabc");
    expect(resolveCalls).toBe(0);
  });

  test("revoked session on a protected API path → 401 Session revoked, legacy cookie purged", async () => {
    jwtPayload = ADMIN_PAYLOAD;
    lookupResult = null;

    const { event, cookieDeletes } = makeEvent("/api/conversations", { cookie: "jwt-token" });
    const { response, resolveCalls } = await callHandle(event);

    expect(response!.status).toBe(401);
    expect(((await response!.json()) as { error?: string }).error).toBe("Session revoked");
    expect(cookieDeletes).toEqual(["pi_session"]);
    expect(resolveCalls).toBe(0);
  });

  test("revoked session on a protected PAGE → redirect to /login?reason=session_revoked", async () => {
    jwtPayload = ADMIN_PAYLOAD;
    lookupResult = null;

    const { event } = makeEvent("/projects/abc", { cookie: "jwt-token" });
    const { redirect } = await callHandle(event);

    expect(redirect).not.toBeNull();
    expect(redirect!.location).toBe("/login?reason=session_revoked&returnTo=%2Fprojects%2Fabc");
  });

  test("JWT secret unreachable on a protected path → request is served, not bounced", async () => {
    // "Cannot judge" is not "invalid". Bouncing every cookie-bearing user to
    // /login because the settings table blinked would turn a DB hiccup into a
    // fleet-wide logout.
    secretThrows = true;

    const { event } = makeEvent("/api/conversations", { cookie: "jwt-token" });
    const { response, resolveCalls } = await callHandle(event);

    expect(response!.status).toBe(200);
    expect(resolveCalls).toBe(1);
    // Served, but NOT authenticated — no principal is invented out of an
    // unverifiable cookie.
    expect(event.locals.user).toBeUndefined();
    expect(event.locals.authMethod).toBeUndefined();
  });
});
