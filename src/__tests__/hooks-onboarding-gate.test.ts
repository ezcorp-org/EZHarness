/**
 * The first-time-onboarding gate in `web/src/hooks.server.ts`, exercised
 * through the REAL `handle`.
 *
 * The gate looks the user up on every authenticated PAGE navigation, stashes
 * `onboardedAt` on `locals` for the wizard's load, and redirects to
 * `/onboarding` while it is still null. It is deliberately fail-OPEN: a dead
 * DB must not lock everyone out of the app behind a wizard.
 *
 * WHY THIS LIVES UNDER `src/__tests__/` AND NOT AS A
 * `web/src/__tests__/*.server.test.ts`: identical reasoning to
 * `hooks-public-path-identity.test.ts` — the node/vitest coverage leg measures
 * an explicit allowlist of source files that does NOT include
 * `web/src/hooks.server.ts`, so a vitest home leaves these lines unmeasured
 * (the "tested but unmeasured" trap called out in scripts/test-coverage.sh).
 * The bun host pool instruments hooks.server.ts already, via this file and its
 * siblings.
 *
 * The full behavioural matrix (asset paths, `/api/*` bypass, Bearer page nav,
 * unauthenticated precedence) stays in
 * `web/src/__tests__/hooks-server-onboarding-redirect.server.test.ts`; this
 * file covers the three OUTCOMES of the lookup — redirect, pass-through,
 * fail-open — rather than restating that matrix.
 *
 * Mock layout copied from `hooks-public-path-identity.test.ts`.
 */
process.env.PI_SKIP_INIT = "1";

import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Mock state, reset per test ────────────────────────────────────
/** What the mocked `getUserById` does: return a row, or throw. */
let userRow: (() => { id: string; onboardedAt: Date | null }) | null = null;
let getUserByIdCalls = 0;

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

const jwtMock = () => ({
  getJwtSecret: async () => "test-hs256-secret",
  verifyJWT: async () => ({ id: "u-1", email: "u@x", name: "U", role: "member" }),
  signJWT: async () => "rotated-token",
});
mock.module("$server/auth/jwt", jwtMock);
mock.module("../auth/jwt", jwtMock);

const usersMock = () => ({
  getUserCount: async () => 1,
  getUserById: async () => {
    getUserByIdCalls++;
    return userRow?.();
  },
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
  hashToken: async (t: string) => `hash:${t}`,
  lookupSessionByTokenHash: async () => ({
    session: { id: "sess-1" },
    viaPrevious: false,
  }),
  touchSession: async () => {},
  rotateSessionToken: async () => null,
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

/** Authenticated (cookie-bearing) RequestEvent stub for a PAGE path. */
function makePageEvent(path: string) {
  const href = `http://localhost${path}`;
  return {
    request: new Request(href, {
      method: "GET",
      headers: { cookie: "ezcorp_session=valid-token" },
    }),
    url: new URL(href),
    params: {},
    route: { id: path },
    cookies: {
      get: (name: string) => (name === "ezcorp_session" ? "valid-token" : undefined),
      set: () => {},
      delete: () => {},
      getAll: () => [],
      serialize: () => "",
    },
    locals: {} as { user?: { id: string }; onboardedAt?: Date | null },
    platform: {},
    isDataRequest: false,
    isSubRequest: false,
    fetch: globalThis.fetch,
    setHeaders: () => {},
    getClientAddress: () => "127.0.0.1",
  };
}

/** Drive `handle`, unwrapping SvelteKit's `redirect()` throw shape. */
async function callHandle(event: unknown) {
  let resolveCalls = 0;
  const resolve = async () => {
    resolveCalls++;
    return new Response("ok", { status: 200 });
  };
  try {
    const response = (await handle({ event, resolve } as never)) as Response;
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

describe("hooks.server.ts — first-time onboarding gate", () => {
  beforeEach(() => {
    userRow = null;
    getUserByIdCalls = 0;
  });

  test("onboardedAt still null → 302 /onboarding and the page never resolves", async () => {
    userRow = () => ({ id: "u-1", onboardedAt: null });
    const event = makePageEvent("/projects/abc");

    const { redirect, resolveCalls } = await callHandle(event);

    expect(redirect).not.toBeNull();
    expect(redirect!.status).toBe(302);
    expect(redirect!.location).toBe("/onboarding");
    // The whole point of redirecting here rather than in a load: the page
    // body is never rendered for a half-set-up account.
    expect(resolveCalls).toBe(0);
    // …and locals still carries the null the wizard's load reads.
    expect(event.locals.onboardedAt).toBeNull();
  });

  test("onboardedAt set → passes through and stashes the stamp on locals", async () => {
    const stamp = new Date("2026-04-25T12:00:00Z");
    userRow = () => ({ id: "u-1", onboardedAt: stamp });
    const event = makePageEvent("/projects/abc");

    const { response, redirect, resolveCalls } = await callHandle(event);

    expect(redirect).toBeNull();
    expect(response!.status).toBe(200);
    expect(resolveCalls).toBe(1);
    // Locks the contract the wizard's +page.server.ts load reads, so it
    // never has to re-query getUserById.
    expect(event.locals.onboardedAt).toEqual(stamp);
    expect(getUserByIdCalls).toBe(1);
  });

  test("the lookup throws (DB down) → fail OPEN: no redirect, no stamp", async () => {
    userRow = () => {
      throw new Error("DB down");
    };
    const event = makePageEvent("/projects/abc");

    const { response, redirect, resolveCalls } = await callHandle(event);

    // A dead DB must not lock every user behind the wizard — the gate is
    // an onboarding nicety, not an authorization boundary.
    expect(redirect).toBeNull();
    expect(response!.status).toBe(200);
    expect(resolveCalls).toBe(1);
    expect(event.locals.onboardedAt).toBeUndefined();
    expect(getUserByIdCalls).toBe(1);
  });
});
