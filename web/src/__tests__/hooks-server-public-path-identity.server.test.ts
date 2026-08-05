/**
 * Public `/api/*` paths identify their caller without ever requiring one —
 * exercised through the REAL `hooks.server.ts` `handle`.
 *
 * The defect: `event.locals.user` was assigned ONLY inside the
 * `if (!isPublic)` branch, so a PUBLIC_PATHS entry could never see a
 * principal. `GET /api/health?detail=true` gates on `role === "admin"`, so it
 * answered 401 to admins too and the Settings → System Health card
 * (`SystemHealth.svelte` polls exactly that URL) could only render
 * "Unable to load health status."
 *
 * F5's remedy — move the bare path into PUBLIC_SUBPATHS_ONLY, as was done for
 * `/api/auth/invite` and `POST /api/auth/reset-password` — cannot apply here:
 * `/api/health` is a liveness probe and its bare path must answer an
 * anonymous caller forever. So enforcement and identification were split
 * instead, and the three properties that split has to keep are pinned below:
 *
 *   1. the cookieless probe does ZERO I/O (no secret read, no session lookup);
 *   2. no verdict can ever fail the request — not a bad cookie, not a revoked
 *      session, not a dead DB (which is exactly when a probe matters most);
 *   3. the principal is no weaker than the enforcing branch's — same
 *      signature check, same revoked-row check.
 *
 * The second describe block re-proves every outcome of the ENFORCING branch,
 * which was refactored onto the same shared `verifySessionCookie`. Those
 * assertions are the regression net for that refactor: identical behaviour,
 * one implementation.
 */

// CRITICAL: must run BEFORE the dynamic import of hooks.server — that module
// has top-level side effects gated on this env var.
process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(async () => 1),
  // The onboarding gate runs for authenticated PAGE navigations; return an
  // onboarded row so it never redirects and masks what we're asserting.
  getUserById: vi.fn(async () => ({
    id: "admin-1",
    email: "a@x",
    name: "A",
    role: "admin",
    onboardedAt: new Date("2026-01-01"),
  })),
}));
vi.mock("$lib/server/context", () => ({ ensureInitialized: vi.fn(async () => {}) }));
vi.mock("$server/startup/background-timers", () => ({
  startBackgroundTimers: vi.fn(async () => {}),
}));
vi.mock("$lib/server/security/bearer-auth", () => ({
  // No-op: leaves locals.user undefined so the COOKIE path is what's tested.
  attachBearerAuth: vi.fn(async () => {}),
}));
vi.mock("$server/db/queries/sessions", () => ({
  hashToken: vi.fn(async (token: string) => `hash:${token}`),
  lookupSessionByTokenHash: vi.fn(),
  touchSession: vi.fn(async () => {}),
  rotateSessionToken: vi.fn(async () => null),
}));
vi.mock("$server/auth/jwt", () => ({
  verifyJWT: vi.fn(),
  getJwtSecret: vi.fn(async () => "secret"),
  signJWT: vi.fn(async () => "rotated-token"),
}));
vi.mock("$server/db/queries/settings", () => ({ getSetting: vi.fn(async () => undefined) }));

import { getUserCount } from "$server/db/queries/users";
import {
  hashToken,
  lookupSessionByTokenHash,
  rotateSessionToken,
  touchSession,
} from "$server/db/queries/sessions";
import { getJwtSecret, signJWT, verifyJWT } from "$server/auth/jwt";
const { handle } = await import("../hooks.server");

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

const MEMBER_PAYLOAD = { ...ADMIN_PAYLOAD, id: "member-1", role: "member" };

function makeEvent(path: string, opts: { method?: string; cookie?: string } = {}) {
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
      headers: opts.cookie ? { cookie: `ezcorp_session=${opts.cookie}` } : {},
    }),
    url: new URL(`http://localhost${path}`),
    cookies,
    locals: {} as Record<string, unknown>,
    getClientAddress: () => "127.0.0.1",
    route: { id: path },
    params: {},
    setHeaders: vi.fn(),
    fetch: vi.fn(),
    isDataRequest: false,
    isSubRequest: false,
  } as never as {
    locals: Record<string, unknown>;
    cookies: { set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  };
}

/** A live, non-revoked session row for the inbound cookie. */
function liveSessionRow() {
  return { session: { id: "sess-1", userId: "admin-1" }, viaPrevious: false } as never;
}

beforeEach(() => {
  vi.mocked(getUserCount).mockReset().mockResolvedValue(1);
  vi.mocked(getJwtSecret).mockReset().mockResolvedValue("secret");
  vi.mocked(verifyJWT).mockReset().mockResolvedValue(null);
  vi.mocked(signJWT).mockReset().mockResolvedValue("rotated-token");
  vi.mocked(hashToken).mockReset().mockImplementation(async (t: string) => `hash:${t}`);
  vi.mocked(lookupSessionByTokenHash).mockReset().mockResolvedValue(null);
  vi.mocked(touchSession).mockReset().mockResolvedValue(null);
  vi.mocked(rotateSessionToken).mockReset().mockResolvedValue(null);
});

describe("hooks.server.ts — opportunistic identification on public /api/* paths", () => {
  // ── Property 1: the probe still costs nothing ──────────────────────
  test.each([["/api/health"], ["/api/ready"], ["/api/version"]])(
    "%s with NO cookie: anonymous, and not one byte of I/O",
    async (path) => {
      const event = makeEvent(path);
      const resolve = vi.fn(async () => new Response("ok", { status: 200 }));

      const res = (await handle({ event, resolve } as never)) as Response;

      expect(res.status).toBe(200);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(event.locals.user).toBeUndefined();
      expect(event.locals.authMethod).toBeUndefined();
      // The whole point: an orchestrator polling this path every few seconds
      // must not be charged a JWT-secret read or a session lookup for it.
      expect(getJwtSecret).not.toHaveBeenCalled();
      expect(hashToken).not.toHaveBeenCalled();
      expect(lookupSessionByTokenHash).not.toHaveBeenCalled();
      expect(getUserCount).not.toHaveBeenCalled();
    },
  );

  // ── The regression that matters ────────────────────────────────────
  test("GET /api/health?detail=true with a valid ADMIN cookie → hook populates locals.user", async () => {
    vi.mocked(verifyJWT).mockResolvedValue(ADMIN_PAYLOAD as never);
    vi.mocked(lookupSessionByTokenHash).mockResolvedValue(liveSessionRow());

    const event = makeEvent("/api/health?detail=true", { cookie: "jwt-token" });
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    // This is the assertion the pre-fix tree cannot satisfy — and it is the
    // whole reason the admin System Health card could never load.
    expect(event.locals.user).toEqual({
      id: "admin-1",
      email: "a@x",
      name: "A",
      role: "admin",
    });
    // Property 3: the principal came through the same verification the
    // enforcing branch uses, so it carries the same method stamp.
    expect(event.locals.authMethod).toBe("session");
  });

  test("a MEMBER cookie is identified as a member, not silently promoted", async () => {
    // The detail gate is `role === "admin"`; a hook that stamped a principal
    // without carrying its role would hand every logged-in user the detailed
    // probe. The role must survive the trip verbatim.
    vi.mocked(verifyJWT).mockResolvedValue(MEMBER_PAYLOAD as never);
    vi.mocked(lookupSessionByTokenHash).mockResolvedValue(liveSessionRow());

    const event = makeEvent("/api/health?detail=true", { cookie: "jwt-token" });
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));

    await handle({ event, resolve } as never);

    expect(event.locals.user).toMatchObject({ id: "member-1", role: "member" });
  });

  // ── Property 3: no weaker than the enforcing branch ────────────────
  test("a REVOKED session identifies nobody (and the request still succeeds)", async () => {
    // Logout / admin force-logout deletes the row while the JWT stays within
    // its 90-day lifetime. If the public branch skipped the row check, a
    // force-logged-out admin would keep reading the detailed probe.
    vi.mocked(verifyJWT).mockResolvedValue(ADMIN_PAYLOAD as never);
    vi.mocked(lookupSessionByTokenHash).mockResolvedValue(null);

    const event = makeEvent("/api/health?detail=true", { cookie: "jwt-token" });
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(res.status).toBe(200);
    expect(event.locals.user).toBeUndefined();
    expect(event.locals.authMethod).toBeUndefined();
  });

  // ── Property 2: never fails the request ────────────────────────────
  test("an UNVERIFIABLE cookie is ignored — anonymous 200, and the cookie is NOT cleared", async () => {
    // The enforcing branch answers 401 and clears the cookie here. A public
    // path must do neither: a garbage cookie on a liveness probe is not a
    // reason to log the user out of the app.
    vi.mocked(verifyJWT).mockResolvedValue(null as never);

    const event = makeEvent("/api/health", { cookie: "garbage" });
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(event.locals.user).toBeUndefined();
    expect(event.cookies.set).not.toHaveBeenCalled();
    expect(event.cookies.delete).not.toHaveBeenCalled();
  });

  test("DB down (getJwtSecret throws) → probe still answers 200, anonymously", async () => {
    // The moment a liveness probe earns its keep. `getJwtSecret` reads the
    // settings table when the secret isn't cached yet, so a cold process
    // meeting a dead DB hits exactly this. It must not become a 500.
    vi.mocked(getJwtSecret).mockRejectedValue(new Error("DB down"));

    const event = makeEvent("/api/health?detail=true", { cookie: "jwt-token" });
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(event.locals.user).toBeUndefined();
  });

  test("DB down (session lookup throws) → JWT-only fallback still identifies the admin", async () => {
    // Same fallback the enforcing branch takes: a verified signature is
    // enough when the revocation table cannot be consulted. Without it, the
    // detailed probe would go dark during precisely the outage it exists to
    // describe.
    vi.mocked(verifyJWT).mockResolvedValue(ADMIN_PAYLOAD as never);
    vi.mocked(lookupSessionByTokenHash).mockRejectedValue(new Error("DB down"));

    const event = makeEvent("/api/health?detail=true", { cookie: "jwt-token" });
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(res.status).toBe(200);
    expect(event.locals.user).toMatchObject({ id: "admin-1", role: "admin" });
  });

  // ── Scope guards ───────────────────────────────────────────────────
  test("a public PAGE route with a valid cookie stays principal-free", async () => {
    // `/login` and friends are the pre-auth funnel. Handing them a principal
    // would pull them under the onboarding-redirect gate and change
    // navigation for a half-onboarded user — a behaviour change this defect
    // never needed. The `/api/` scoping is what prevents it.
    vi.mocked(verifyJWT).mockResolvedValue(ADMIN_PAYLOAD as never);
    vi.mocked(lookupSessionByTokenHash).mockResolvedValue(liveSessionRow());

    const event = makeEvent("/login", { cookie: "jwt-token" });
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(res.status).toBe(200);
    expect(event.locals.user).toBeUndefined();
    expect(getJwtSecret).not.toHaveBeenCalled();
  });

  test("a public API path never re-issues the cookie (no sliding refresh)", async () => {
    // A path that does not REQUIRE a session has no business rotating one.
    // The inbound JWT here is well past the refresh threshold, which on a
    // protected path would sign a new token and Set-Cookie.
    const staleIat = nowSeconds() - 400 * 24 * 3600;
    vi.mocked(verifyJWT).mockResolvedValue({
      ...ADMIN_PAYLOAD,
      iat: staleIat,
      exp: nowSeconds() + 3600,
    } as never);
    vi.mocked(lookupSessionByTokenHash).mockResolvedValue(liveSessionRow());

    const event = makeEvent("/api/health?detail=true", { cookie: "jwt-token" });
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));

    await handle({ event, resolve } as never);

    expect(event.locals.user).toMatchObject({ role: "admin" });
    expect(signJWT).not.toHaveBeenCalled();
    expect(rotateSessionToken).not.toHaveBeenCalled();
    expect(event.cookies.set).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The enforcing branch was refactored onto the SAME `verifySessionCookie`
// used above, so every one of its outcomes is re-pinned here. A shared
// verifier is only an improvement if it provably did not move any of these.
// ───────────────────────────────────────────────────────────────────────────
describe("hooks.server.ts — the enforcing branch keeps every outcome", () => {
  test("valid session on a protected API path → principal stamped, request served", async () => {
    vi.mocked(verifyJWT).mockResolvedValue(ADMIN_PAYLOAD as never);
    vi.mocked(lookupSessionByTokenHash).mockResolvedValue(liveSessionRow());

    const event = makeEvent("/api/conversations", { cookie: "jwt-token" });
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(res.status).toBe(200);
    expect(event.locals.user).toMatchObject({ id: "admin-1", role: "admin" });
    expect(event.locals.authMethod).toBe("session");
    // Live sessions get their throttled activity touch.
    expect(touchSession).toHaveBeenCalledWith("sess-1");
  });

  test("unverifiable cookie on a protected API path → 401 Session expired, cookie cleared", async () => {
    vi.mocked(verifyJWT).mockResolvedValue(null as never);

    const event = makeEvent("/api/conversations", { cookie: "garbage" });
    const resolve = vi.fn();

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe("Session expired");
    expect(resolve).not.toHaveBeenCalled();
    expect(event.cookies.set).toHaveBeenCalledWith(
      "ezcorp_session",
      "",
      expect.objectContaining({ maxAge: 0 }),
    );
  });

  test("unverifiable cookie on a protected PAGE → redirect to /login?reason=session_expired", async () => {
    vi.mocked(verifyJWT).mockResolvedValue(null as never);

    const event = makeEvent("/projects/abc", { cookie: "garbage" });
    const resolve = vi.fn();

    await expect(handle({ event, resolve } as never)).rejects.toMatchObject({
      status: 302,
      location: "/login?reason=session_expired&returnTo=%2Fprojects%2Fabc",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("revoked session on a protected API path → 401 Session revoked, legacy cookie purged", async () => {
    vi.mocked(verifyJWT).mockResolvedValue(ADMIN_PAYLOAD as never);
    vi.mocked(lookupSessionByTokenHash).mockResolvedValue(null);

    const event = makeEvent("/api/conversations", { cookie: "jwt-token" });
    const resolve = vi.fn();

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe("Session revoked");
    expect(event.cookies.delete).toHaveBeenCalledWith("pi_session", { path: "/" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("revoked session on a protected PAGE → redirect to /login?reason=session_revoked", async () => {
    vi.mocked(verifyJWT).mockResolvedValue(ADMIN_PAYLOAD as never);
    vi.mocked(lookupSessionByTokenHash).mockResolvedValue(null);

    const event = makeEvent("/projects/abc", { cookie: "jwt-token" });
    const resolve = vi.fn();

    await expect(handle({ event, resolve } as never)).rejects.toMatchObject({
      status: 302,
      location: "/login?reason=session_revoked&returnTo=%2Fprojects%2Fabc",
    });
  });

  test("JWT secret unreachable on a protected path → request is served, not bounced", async () => {
    // "Cannot judge" is not "invalid". Bouncing every cookie-bearing user to
    // /login because the settings table blinked would turn a DB hiccup into a
    // fleet-wide logout.
    vi.mocked(getJwtSecret).mockRejectedValue(new Error("DB down"));

    const event = makeEvent("/api/conversations", { cookie: "jwt-token" });
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(res.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    // Served, but NOT authenticated — no principal is invented out of an
    // unverifiable cookie.
    expect(event.locals.user).toBeUndefined();
    expect(event.locals.authMethod).toBeUndefined();
  });
});
