/**
 * End-to-end protocol test for sliding session refresh.
 *
 * Unlike the integration test in `hooks-server-session-refresh.server.test.ts`
 * (which mocks `signJWT`/`verifyJWT`/`hashToken`), this test drives the real
 * crypto chain through `handle()` and only mocks the DB boundary. It proves:
 *
 *   1. A REAL stale JWT actually triggers refresh end-to-end.
 *   2. The Set-Cookie value is itself a valid, signed JWT carrying the same
 *      identity claims and a NEW iat / exp ~30d in the future.
 *   3. The `rotateSessionToken` call site receives the SHA-256 hash of the
 *      newly-issued token (i.e. the cookie the browser will send next time
 *      will hash to a row that exists in the DB).
 *   4. A fresh JWT is left untouched — no rotation, no Set-Cookie.
 *
 * Why "e2e": this is the highest-fidelity refresh test we can run without
 * spinning up a real Docker backend. Playwright's default harness mocks all
 * /api/* routes so the real `handle()` chain never executes — that path
 * would not have caught a bug in `hashToken(...)` or `signJWT(...)`. This
 * test does.
 */

process.env.PI_SKIP_INIT = "1";
process.env.EZCORP_JWT_SECRET = "e2e-refresh-test-secret-must-be-32-chars-min-AAAA";

import { test, expect, describe, vi, beforeEach } from "vitest";

// Onboarding gate dependencies — return an onboarded user so we never
// branch off to /onboarding before the refresh code runs.
vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(async () => 1),
  getUserById: vi.fn(async () => ({
    id: "u-e2e",
    email: "e2e@test.com",
    name: "E2E",
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
vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(async () => undefined),
}));

// DB-only mock — keep hashToken / rotate / lookup but use real crypto for
// hashToken via the `vi.importActual` route.
vi.mock("$server/db/queries/sessions", async (importActual) => {
  const actual = await importActual<typeof import("$server/db/queries/sessions")>();
  return {
    hashToken: actual.hashToken,
    getSessionByTokenHash: vi.fn(async () => ({ id: "sess-e2e", userId: "u-e2e" })),
    touchSession: vi.fn(async () => {}),
    rotateSessionToken: vi.fn(async () => ({
      id: "sess-e2e",
      tokenHash: "placeholder",
      expiresAt: new Date(),
    })),
  };
});

import { signJWT, verifyJWT } from "$server/auth/jwt";
import { hashToken, rotateSessionToken, getSessionByTokenHash } from "$server/db/queries/sessions";
const { handle, __sessionRefreshConfig } = await import("../hooks.server");
const { REFRESH_AFTER_SECONDS, NEW_LIFETIME_SECONDS } = __sessionRefreshConfig;

const SECRET = process.env.EZCORP_JWT_SECRET!;
const IDENTITY = {
  id: "u-e2e",
  email: "e2e@test.com",
  name: "E2E",
  role: "member" as const,
};

function makeEvent(opts: { cookie: string; path?: string }) {
  // Captured cookies — Set-Cookie writes land here so the test can assert.
  const setCookies: Array<{ name: string; value: string; opts: any }> = [];
  const cookies = {
    get: vi.fn((name: string) => (name === "ezcorp_session" ? opts.cookie : undefined)),
    set: vi.fn((name: string, value: string, o: any) => {
      setCookies.push({ name, value, opts: o });
    }),
    delete: vi.fn(),
  };
  const path = opts.path ?? "/projects/abc";
  return {
    event: {
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
    } as any,
    setCookies,
  };
}

// Mint a real, signed JWT with a backdated iat. The signJWT API computes
// `exp = iat + expiresInSeconds` and uses Date.now() for iat — so to
// manufacture a stale iat we have to bypass the helper and sign manually.
async function mintBackdatedJWT(iatSecondsAgo: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = now - iatSecondsAgo;
  // Use signJWT with a positive expiresInSeconds so exp is in the future,
  // then rewrite the iat by re-signing the modified payload manually.
  // Easier path: just call signJWT with a very long lifetime, decode iat
  // off the result, and time-travel later. But we need iat to actually
  // be in the past. Build the JWT inline using the same primitives.
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    ...IDENTITY,
    iat,
    exp: iat + 30 * 24 * 3600, // still in the future even with backdate
  };
  const encoder = new TextEncoder();
  const b64url = (data: Uint8Array): string => {
    let bin = "";
    for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]!);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const headerB64 = b64url(encoder.encode(JSON.stringify(header)));
  const payloadB64 = b64url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

describe("hooks.server.ts — E2E sliding refresh (real crypto)", () => {
  beforeEach(() => {
    vi.mocked(rotateSessionToken).mockReset();
    vi.mocked(getSessionByTokenHash).mockReset();
    vi.mocked(rotateSessionToken).mockResolvedValue({
      id: "sess-e2e",
      tokenHash: "placeholder",
      expiresAt: new Date(),
    } as any);
    vi.mocked(getSessionByTokenHash).mockResolvedValue({
      id: "sess-e2e",
      userId: "u-e2e",
    } as any);
  });

  test("stale REAL JWT → Set-Cookie carries a freshly-signed REAL JWT (same identity, new iat)", async () => {
    const staleToken = await mintBackdatedJWT(REFRESH_AFTER_SECONDS + 3600);
    const stalePayload = await verifyJWT(staleToken, SECRET);
    expect(stalePayload).not.toBeNull();
    const staleIat = stalePayload!.iat;

    const { event, setCookies } = makeEvent({ cookie: staleToken });
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = (await handle({ event, resolve } as any)) as Response;
    expect(res.status).toBe(200);

    // Exactly one Set-Cookie for the session, carrying a parseable JWT.
    const sessionWrites = setCookies.filter(c => c.name === "ezcorp_session");
    expect(sessionWrites).toHaveLength(1);
    const newToken = sessionWrites[0]!.value;
    expect(newToken).not.toBe(staleToken);
    expect(newToken.split(".")).toHaveLength(3); // looks like a JWT

    // Verify the new token under the SAME secret — this is the contract
    // the browser will rely on next request.
    const newPayload = await verifyJWT(newToken, SECRET);
    expect(newPayload).not.toBeNull();
    expect(newPayload).toMatchObject(IDENTITY);
    expect(newPayload!.iat).toBeGreaterThan(staleIat);
    // Lifetime budget: exp - iat should equal NEW_LIFETIME_SECONDS exactly.
    expect(newPayload!.exp - newPayload!.iat).toBe(NEW_LIFETIME_SECONDS);

    // Cookie maxAge matches the JWT lifetime (else the browser drops the
    // cookie before the JWT expires, defeating the whole refresh).
    expect(sessionWrites[0]!.opts.maxAge).toBe(NEW_LIFETIME_SECONDS);
    expect(sessionWrites[0]!.opts.httpOnly).toBe(true);
    expect(sessionWrites[0]!.opts.sameSite).toBe("lax");

    // CAS contract: rotateSessionToken received SHA-256(newToken) as the
    // newTokenHash and SHA-256(staleToken) as the oldTokenHash. If we got
    // either wrong, the next request would 401 with session_revoked.
    const callArgs = vi.mocked(rotateSessionToken).mock.calls[0]![0];
    expect(callArgs.oldTokenHash).toBe(await hashToken(staleToken));
    expect(callArgs.newTokenHash).toBe(await hashToken(newToken));
  });

  test("fresh REAL JWT → no rotation, no Set-Cookie, request still authenticates", async () => {
    // Sign normally — iat = now, well under threshold.
    const freshToken = await signJWT(IDENTITY, SECRET, 30 * 24 * 3600);

    const { event, setCookies } = makeEvent({ cookie: freshToken });
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = (await handle({ event, resolve } as any)) as Response;
    expect(res.status).toBe(200);

    expect(vi.mocked(rotateSessionToken)).not.toHaveBeenCalled();
    const sessionWrites = setCookies.filter(c => c.name === "ezcorp_session");
    expect(sessionWrites).toHaveLength(0);
    // locals.user populated as the downstream contract requires.
    expect(event.locals.user).toMatchObject(IDENTITY);
  });

  test("rotated cookie chains: 2nd request with the new cookie does NOT re-rotate", async () => {
    // First pass: stale → get rotated cookie.
    const staleToken = await mintBackdatedJWT(REFRESH_AFTER_SECONDS + 3600);
    const first = makeEvent({ cookie: staleToken });
    await handle({ event: first.event, resolve: vi.fn(async () => new Response("ok")) } as any);
    const newToken = first.setCookies.find(c => c.name === "ezcorp_session")!.value;

    // Second pass: present the rotated cookie. Must be considered fresh
    // (no rotation triggered) — proves the new iat was actually written.
    vi.mocked(rotateSessionToken).mockClear();
    const second = makeEvent({ cookie: newToken });
    await handle({ event: second.event, resolve: vi.fn(async () => new Response("ok")) } as any);

    expect(vi.mocked(rotateSessionToken)).not.toHaveBeenCalled();
    expect(second.setCookies.filter(c => c.name === "ezcorp_session")).toHaveLength(0);
  });
});
