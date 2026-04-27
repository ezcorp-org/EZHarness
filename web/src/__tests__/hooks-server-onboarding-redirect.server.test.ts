/**
 * Server-handler unit tests for the onboarding-gate branch in
 * `src/hooks.server.ts`. Specifically exercises the
 * `locals.user.onboardedAt === null` redirect:
 *   - cookie-auth user with null onboardedAt requesting / → 302 /onboarding
 *   - same user requesting /onboarding → passes through (no redirect loop)
 *   - same user requesting /api/* → passes through (programmatic clients)
 *   - same user requesting /_app/* → passes through (asset paths)
 *   - cookie-auth user with onboardedAt set → passes through everywhere
 *   - DB lookup fails → fail-open, passes through
 *   - unauthenticated → existing /login redirect still wins
 *
 * Mirrors hooks-server-setup-redirect.server.test.ts conventions.
 */

process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(),
  getUserById: vi.fn(),
}));
vi.mock("$lib/server/context", () => ({
  ensureInitialized: vi.fn(async () => {}),
}));
vi.mock("$server/startup/background-timers", () => ({
  startBackgroundTimers: vi.fn(async () => {}),
}));
vi.mock("$lib/server/security/bearer-auth", () => ({
  attachBearerAuth: vi.fn(async () => {}),
}));
vi.mock("$server/db/queries/sessions", () => ({
  hashToken: vi.fn(async () => "hash"),
  // Auth path: present session row so the JWT branch sets locals.user.
  getSessionByTokenHash: vi.fn(async () => ({ id: "sess-1", userId: "u-1" })),
  touchSession: vi.fn(async () => {}),
}));
vi.mock("$server/auth/jwt", () => ({
  // Authenticated payload — gets written to event.locals.user at L302.
  verifyJWT: vi.fn(async () => ({
    id: "u-1",
    email: "u@test.com",
    name: "U",
    role: "member",
  })),
  getJwtSecret: vi.fn(async () => "secret"),
}));
vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(async () => undefined),
}));

import { getUserById, getUserCount } from "$server/db/queries/users";
import { verifyJWT } from "$server/auth/jwt";
const { handle } = await import("../hooks.server");

function isRedirect(err: unknown): err is { status: number; location: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as any).status === "number" &&
    typeof (err as any).location === "string"
  );
}

function makeAuthedEvent(path: string) {
  const cookies = {
    get: vi.fn((name: string) => (name === "ezcorp_session" ? "valid-jwt-token" : undefined)),
    set: vi.fn(),
    delete: vi.fn(),
  };
  return {
    request: new Request(`http://localhost${path}`, {
      method: "GET",
      headers: { cookie: "ezcorp_session=valid-jwt-token" },
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

const NOT_ONBOARDED = {
  id: "u-1",
  email: "u@test.com",
  name: "U",
  role: "member" as const,
  status: "active" as const,
  passwordHash: "x",
  createdAt: new Date(),
  onboardedAt: null,
};
const ONBOARDED = { ...NOT_ONBOARDED, onboardedAt: new Date() };

describe("hooks.server.ts — onboarding gate", () => {
  beforeEach(() => {
    vi.mocked(getUserById).mockReset();
    vi.mocked(getUserCount).mockResolvedValue(1); // bypass /setup branch
    // Re-arm verifyJWT to default authenticated payload (each test may override).
    vi.mocked(verifyJWT).mockResolvedValue({
      id: "u-1",
      email: "u@test.com",
      name: "U",
      role: "member",
    } as any);
  });

  test("authenticated, onboardedAt=null, page request → 302 /onboarding", async () => {
    vi.mocked(getUserById).mockResolvedValue(NOT_ONBOARDED as any);
    const event = makeAuthedEvent("/projects/abc");
    const resolve = vi.fn();

    let thrown: unknown;
    try {
      await handle({ event, resolve } as any);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    if (!isRedirect(thrown)) throw thrown;
    expect(thrown.status).toBe(302);
    expect(thrown.location).toBe("/onboarding");
    expect(resolve).not.toHaveBeenCalled();
  });

  test("authenticated, onboardedAt=null, hitting /onboarding itself → no redirect (passes through) AND stashes locals.onboardedAt for the wizard load", async () => {
    vi.mocked(getUserById).mockResolvedValue(NOT_ONBOARDED as any);
    const event = makeAuthedEvent("/onboarding");
    const expected = new Response("ok", { status: 200 });
    const resolve = vi.fn(async () => expected);

    const res = (await handle({ event, resolve } as any)) as Response;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    // Locks the contract that page.server.ts load reads — ensures
    // we don't have to re-query getUserById downstream.
    expect(event.locals.onboardedAt).toBeNull();
  });

  test("authenticated, onboardedAt set, page request → passes through AND stashes the Date on locals", async () => {
    const stamp = new Date("2026-04-25T12:00:00Z");
    vi.mocked(getUserById).mockResolvedValue({ ...ONBOARDED, onboardedAt: stamp } as any);
    const event = makeAuthedEvent("/projects/abc");
    const expected = new Response("ok", { status: 200 });
    const resolve = vi.fn(async () => expected);

    await handle({ event, resolve } as any);
    expect(event.locals.onboardedAt).toEqual(stamp);
  });

  test("authenticated, onboardedAt=null, hitting /api/* → passes through (programmatic clients)", async () => {
    vi.mocked(getUserById).mockResolvedValue(NOT_ONBOARDED as any);
    const event = makeAuthedEvent("/api/conversations");
    const expected = new Response("ok", { status: 200 });
    const resolve = vi.fn(async () => expected);

    const res = (await handle({ event, resolve } as any)) as Response;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  test("authenticated, onboardedAt=null, /api/onboarding/complete → passes through (wizard finalizer)", async () => {
    vi.mocked(getUserById).mockResolvedValue(NOT_ONBOARDED as any);
    const event = makeAuthedEvent("/api/onboarding/complete");
    const expected = new Response(null, { status: 204 });
    const resolve = vi.fn(async () => expected);

    const res = (await handle({ event, resolve } as any)) as Response;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(204);
  });

  test("authenticated, onboardedAt=null, /_app/* asset path → passes through (no redirect)", async () => {
    vi.mocked(getUserById).mockResolvedValue(NOT_ONBOARDED as any);
    const event = makeAuthedEvent("/_app/version.json");
    const expected = new Response("ok", { status: 200 });
    const resolve = vi.fn(async () => expected);

    const res = (await handle({ event, resolve } as any)) as Response;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  test("authenticated, onboardedAt set → passes through everywhere", async () => {
    vi.mocked(getUserById).mockResolvedValue(ONBOARDED as any);
    const event = makeAuthedEvent("/projects/abc");
    const expected = new Response("ok", { status: 200 });
    const resolve = vi.fn(async () => expected);

    const res = (await handle({ event, resolve } as any)) as Response;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  test("Bearer-authed page nav (locals.user set without cookie) with onboardedAt=null → still 302 /onboarding", async () => {
    // Watch-item regression: the gate distinguishes by path prefix
    // (`/api/`), not by auth method. A Bearer-authenticated client
    // requesting a page path (rare but possible — SSR test harness,
    // extension scraping HTML) gets redirected to /onboarding.
    // Documented as intentional; this test locks it so a future
    // refactor can't silently flip the behavior.
    vi.mocked(getUserById).mockResolvedValue(NOT_ONBOARDED as any);
    // Build an event with NO cookie but locals.user pre-populated, the
    // way attachBearerAuth would do it. verifyJWT mock won't be
    // consulted because the no-cookie branch goes through bearer auth.
    const noCookieEvent: any = makeAuthedEvent("/projects/abc");
    noCookieEvent.cookies.get = vi.fn(() => undefined);
    noCookieEvent.request = new Request("http://localhost/projects/abc", { method: "GET" });
    // Simulate attachBearerAuth populating locals.user.
    const { attachBearerAuth } = await import("$lib/server/security/bearer-auth");
    vi.mocked(attachBearerAuth).mockImplementation(async ({ locals }: any) => {
      locals.user = { id: "u-1", email: "u@test.com", name: "U", role: "member" };
      return true;
    });

    const resolve = vi.fn();
    let thrown: unknown;
    try {
      await handle({ event: noCookieEvent, resolve } as any);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    if (!isRedirect(thrown)) throw thrown;
    expect(thrown.status).toBe(302);
    expect(thrown.location).toBe("/onboarding");
    expect(resolve).not.toHaveBeenCalled();
  });

  test("getUserById rejects (DB unavailable) → fail-open, no redirect", async () => {
    vi.mocked(getUserById).mockRejectedValue(new Error("DB down"));
    const event = makeAuthedEvent("/projects/abc");
    const expected = new Response("ok", { status: 200 });
    const resolve = vi.fn(async () => expected);

    const res = (await handle({ event, resolve } as any)) as Response;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  test("unauthenticated → existing /login redirect still wins (onboarding gate is downstream of auth)", async () => {
    // Override JWT to simulate no valid session — verifyJWT returns null.
    vi.mocked(verifyJWT).mockResolvedValue(null);

    const event = makeAuthedEvent("/projects/abc");
    const resolve = vi.fn();

    let thrown: unknown;
    try {
      await handle({ event, resolve } as any);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    if (!isRedirect(thrown)) throw thrown;
    expect(thrown.location).toBe("/login?reason=session_expired");
    // getUserById must NOT have been consulted — onboarding gate runs after auth succeeds.
    expect(vi.mocked(getUserById)).not.toHaveBeenCalled();
  });
});
