/**
 * Server-handler integration tests for the sliding-session-refresh branch in
 * `src/hooks.server.ts`. Specifically exercises the post-`getSessionByTokenHash`
 * refresh logic:
 *   - JWT iat older than REFRESH_AFTER → signs new token, CAS-rotates, sets cookie
 *   - JWT iat fresh (just-issued) → no rotation, no Set-Cookie
 *   - CAS lost the race (rotateSessionToken returns null) → no Set-Cookie, no error
 *   - rotateSessionToken throws → no Set-Cookie, request still resolves
 *   - DB unavailable (getSessionByTokenHash threw) → JWT-only fallback, no rotation
 *   - Missing session row → no rotation (already handled as revoked upstream)
 *
 * Mirrors the mock layout of hooks-server-onboarding-redirect.server.test.ts.
 */

// CRITICAL: must run BEFORE the dynamic `await import(...)` of hooks.server,
// because that module has top-level side effects gated on this env var.
process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(async () => 1),
  // Onboarding gate runs after our refresh code; return an onboarded user
  // so we never branch off into a redirect that masks Set-Cookie behavior.
  getUserById: vi.fn(async () => ({
    id: "u-1",
    email: "u@test.com",
    name: "U",
    role: "member",
    onboardedAt: new Date("2026-01-01"),
  })),
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
  hashToken: vi.fn(async (token: string) => `hash:${token}`),
  // Default lookup: matched on the current tokenHash (not via grace window).
  // Tests that exercise the revoked / DB-down / grace branches override
  // this mock per-test.
  lookupSessionByTokenHash: vi.fn(async () => ({
    session: { id: "sess-1", userId: "u-1" },
    viaPrevious: false,
  })),
  touchSession: vi.fn(async () => {}),
  rotateSessionToken: vi.fn(async () => ({
    id: "sess-1",
    tokenHash: "hash:rotated-token",
    expiresAt: new Date(),
  })),
}));
vi.mock("$server/auth/jwt", () => ({
  verifyJWT: vi.fn(),
  getJwtSecret: vi.fn(async () => "secret"),
  signJWT: vi.fn(async () => "rotated-token"),
}));
vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(async () => undefined),
}));

import { verifyJWT, signJWT } from "$server/auth/jwt";
import { rotateSessionToken, lookupSessionByTokenHash } from "$server/db/queries/sessions";
const { handle, __sessionRefreshConfig } = await import("../hooks.server");

const { REFRESH_AFTER_SECONDS, NEW_LIFETIME_SECONDS } = __sessionRefreshConfig;

function makeEvent(opts: { cookie?: string; path?: string } = {}) {
  const cookies = {
    get: vi.fn((name: string) =>
      name === "ezcorp_session" ? (opts.cookie ?? "incoming-token") : undefined,
    ),
    set: vi.fn(),
    delete: vi.fn(),
  };
  const path = opts.path ?? "/projects/abc";
  return {
    request: new Request(`http://localhost${path}`, { method: "GET" }),
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

const BASE_PAYLOAD = {
  id: "u-1",
  email: "u@test.com",
  name: "U",
  role: "member" as const,
};

function nowSeconds() { return Math.floor(Date.now() / 1000); }

describe("hooks.server.ts — sliding session refresh", () => {
  beforeEach(() => {
    vi.mocked(verifyJWT).mockReset();
    vi.mocked(signJWT).mockReset();
    vi.mocked(rotateSessionToken).mockReset();
    vi.mocked(lookupSessionByTokenHash).mockReset();

    // Defaults: rotated row, fresh signed token, present session row matched
    // on the current tokenHash (not via the rotation grace window).
    vi.mocked(signJWT).mockResolvedValue("rotated-token");
    vi.mocked(rotateSessionToken).mockResolvedValue({
      id: "sess-1",
      tokenHash: "hash:rotated-token",
      expiresAt: new Date(),
    } as any);
    vi.mocked(lookupSessionByTokenHash).mockResolvedValue({
      session: { id: "sess-1", userId: "u-1" } as any,
      viaPrevious: false,
    });
  });

  test("stale JWT (iat older than REFRESH_AFTER) → signs new token + Set-Cookie with fresh maxAge", async () => {
    const staleIat = nowSeconds() - (REFRESH_AFTER_SECONDS + 60);
    vi.mocked(verifyJWT).mockResolvedValue({
      ...BASE_PAYLOAD,
      iat: staleIat,
      exp: staleIat + 30 * 24 * 3600,
    } as any);

    const event = makeEvent();
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = (await handle({ event, resolve } as any)) as Response;

    expect(res.status).toBe(200);
    expect(vi.mocked(signJWT)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rotateSessionToken)).toHaveBeenCalledTimes(1);

    // CAS predicate uses the OLD hash (derived from the inbound cookie),
    // and the new row carries the new hash + a future expiresAt.
    const callArgs = vi.mocked(rotateSessionToken).mock.calls[0]![0];
    expect(callArgs.id).toBe("sess-1");
    expect(callArgs.oldTokenHash).toBe("hash:incoming-token");
    expect(callArgs.newTokenHash).toBe("hash:rotated-token");
    const expiresInSeconds =
      Math.floor(callArgs.newExpiresAt.getTime() / 1000) - nowSeconds();
    // Allow a few seconds of test drift around the lifetime budget.
    expect(expiresInSeconds).toBeGreaterThan(NEW_LIFETIME_SECONDS - 5);
    expect(expiresInSeconds).toBeLessThanOrEqual(NEW_LIFETIME_SECONDS + 5);

    // Cookie set with fresh full lifetime — this is the bit that prevents
    // the user from being logged out 30d after their FIRST login.
    expect(event.cookies.set).toHaveBeenCalledWith(
      "ezcorp_session",
      "rotated-token",
      expect.objectContaining({
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        maxAge: NEW_LIFETIME_SECONDS,
      }),
    );
  });

  test("fresh JWT (iat just now) → no rotation, no Set-Cookie", async () => {
    vi.mocked(verifyJWT).mockResolvedValue({
      ...BASE_PAYLOAD,
      iat: nowSeconds() - 60, // 1 minute old, well under threshold
      exp: nowSeconds() + 30 * 24 * 3600,
    } as any);

    const event = makeEvent();
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    await handle({ event, resolve } as any);

    expect(vi.mocked(signJWT)).not.toHaveBeenCalled();
    expect(vi.mocked(rotateSessionToken)).not.toHaveBeenCalled();
    expect(event.cookies.set).not.toHaveBeenCalled();
  });

  test("non-data route keeps the global Permissions-Policy camera deny", async () => {
    // The extension data route opts camera back IN (camera=(self)); every
    // OTHER route keeps hooks.server.ts's global deny, which is applied only
    // when the response hasn't already set Permissions-Policy. This proves
    // the data-route opt-in (Phase D) did not widen the default elsewhere.
    vi.mocked(verifyJWT).mockResolvedValue({
      ...BASE_PAYLOAD,
      iat: nowSeconds() - 60,
      exp: nowSeconds() + 30 * 24 * 3600,
    } as any);

    const event = makeEvent({ path: "/projects/abc" }); // not the data route
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = (await handle({ event, resolve } as any)) as Response;

    expect(res.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  test("CAS race lost (rotateSessionToken returns null) → no Set-Cookie, request still succeeds", async () => {
    const staleIat = nowSeconds() - (REFRESH_AFTER_SECONDS + 60);
    vi.mocked(verifyJWT).mockResolvedValue({
      ...BASE_PAYLOAD,
      iat: staleIat,
      exp: staleIat + 30 * 24 * 3600,
    } as any);
    // Simulate concurrent rotation winning the race first.
    vi.mocked(rotateSessionToken).mockResolvedValue(null);

    const event = makeEvent();
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = (await handle({ event, resolve } as any)) as Response;

    expect(res.status).toBe(200);
    expect(vi.mocked(signJWT)).toHaveBeenCalledTimes(1); // we still signed
    expect(event.cookies.set).not.toHaveBeenCalled();    // but didn't bind
  });

  test("rotateSessionToken throws → request still succeeds, no Set-Cookie", async () => {
    const staleIat = nowSeconds() - (REFRESH_AFTER_SECONDS + 60);
    vi.mocked(verifyJWT).mockResolvedValue({
      ...BASE_PAYLOAD,
      iat: staleIat,
      exp: staleIat + 30 * 24 * 3600,
    } as any);
    vi.mocked(rotateSessionToken).mockRejectedValue(new Error("DB blew up"));

    const event = makeEvent();
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = (await handle({ event, resolve } as any)) as Response;

    expect(res.status).toBe(200);
    expect(event.cookies.set).not.toHaveBeenCalled();
  });

  test("DB unavailable (lookupSessionByTokenHash throws) → JWT-only fallback, no rotation attempt", async () => {
    const staleIat = nowSeconds() - (REFRESH_AFTER_SECONDS + 60);
    vi.mocked(verifyJWT).mockResolvedValue({
      ...BASE_PAYLOAD,
      iat: staleIat,
      exp: staleIat + 30 * 24 * 3600,
    } as any);
    vi.mocked(lookupSessionByTokenHash).mockRejectedValue(new Error("DB down"));

    const event = makeEvent();
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = (await handle({ event, resolve } as any)) as Response;

    expect(res.status).toBe(200);
    // We can't rotate without a known session id — skip silently.
    expect(vi.mocked(signJWT)).not.toHaveBeenCalled();
    expect(vi.mocked(rotateSessionToken)).not.toHaveBeenCalled();
    expect(event.cookies.set).not.toHaveBeenCalled();
  });

  test("session row missing → revoked path runs, no rotation", async () => {
    const staleIat = nowSeconds() - (REFRESH_AFTER_SECONDS + 60);
    vi.mocked(verifyJWT).mockResolvedValue({
      ...BASE_PAYLOAD,
      iat: staleIat,
      exp: staleIat + 30 * 24 * 3600,
    } as any);
    vi.mocked(lookupSessionByTokenHash).mockResolvedValue(null);

    const event = makeEvent();
    const resolve = vi.fn();

    let thrown: unknown;
    try { await handle({ event, resolve } as any); } catch (err) { thrown = err; }

    expect(thrown).toBeDefined();
    // Revoked redirect wins; refresh code is never reached.
    expect(vi.mocked(signJWT)).not.toHaveBeenCalled();
    expect(vi.mocked(rotateSessionToken)).not.toHaveBeenCalled();
  });

  test("inbound matched on previous-token grace → no rotation, no Set-Cookie", async () => {
    // Peer request just rotated the row; this request still carries the old
    // cookie. The lookup matched it via the grace column. Hooks must serve
    // the user normally and skip a redundant rotation — otherwise concurrent
    // refresh attempts thrash the row and lose the grace bridge.
    const staleIat = nowSeconds() - (REFRESH_AFTER_SECONDS + 60);
    vi.mocked(verifyJWT).mockResolvedValue({
      ...BASE_PAYLOAD,
      iat: staleIat,
      exp: staleIat + 30 * 24 * 3600,
    } as any);
    vi.mocked(lookupSessionByTokenHash).mockResolvedValue({
      session: { id: "sess-1", userId: "u-1" } as any,
      viaPrevious: true,
    });

    const event = makeEvent();
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = (await handle({ event, resolve } as any)) as Response;

    expect(res.status).toBe(200);
    expect(vi.mocked(signJWT)).not.toHaveBeenCalled();
    expect(vi.mocked(rotateSessionToken)).not.toHaveBeenCalled();
    expect(event.cookies.set).not.toHaveBeenCalled();
  });

  test("rotation passes the previous-token grace seconds to rotateSessionToken", async () => {
    const staleIat = nowSeconds() - (REFRESH_AFTER_SECONDS + 60);
    vi.mocked(verifyJWT).mockResolvedValue({
      ...BASE_PAYLOAD,
      iat: staleIat,
      exp: staleIat + 30 * 24 * 3600,
    } as any);

    const event = makeEvent();
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    await handle({ event, resolve } as any);

    const callArgs = vi.mocked(rotateSessionToken).mock.calls[0]![0];
    // Locks the contract that hooks always passes a positive grace value —
    // a missing or zero value would re-introduce the spurious-revoke bug
    // this whole change is meant to fix.
    expect(callArgs.previousTokenGraceSeconds).toBeGreaterThan(0);
  });

  test("rotation re-signs with the same identity claims (no privilege drift)", async () => {
    const staleIat = nowSeconds() - (REFRESH_AFTER_SECONDS + 60);
    vi.mocked(verifyJWT).mockResolvedValue({
      ...BASE_PAYLOAD,
      role: "admin",
      iat: staleIat,
      exp: staleIat + 30 * 24 * 3600,
    } as any);

    const event = makeEvent();
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    await handle({ event, resolve } as any);

    // Lock the contract that we re-sign with EXACTLY the verified payload's
    // identity fields — never read fresh from DB, never silently elevate role.
    expect(vi.mocked(signJWT)).toHaveBeenCalledWith(
      { id: "u-1", email: "u@test.com", name: "U", role: "admin" },
      "secret",
      NEW_LIFETIME_SECONDS,
    );
  });
});
