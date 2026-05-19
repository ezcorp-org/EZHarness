/**
 * Server-handler tests for the `returnTo` query param that hooks.server.ts
 * appends to its `/login` redirect targets so users land back on the page
 * they were trying to reach.
 *
 * Covers all three redirect points in `handle()`:
 *   - No auth + non-zero user count (line ~276): `/login?returnTo=...`
 *   - JWT verification failure (line ~293): `/login?reason=session_expired&returnTo=...`
 *   - Session row missing / revoked (line ~326): `/login?reason=session_revoked&returnTo=...`
 *
 * And the rules for whether `returnTo` is included at all:
 *   - GET only — POST/PUT/PATCH navigations don't have a "page the user was on"
 *   - Pathname must not equal `/login` (defense in depth — `/login` is in
 *     PUBLIC_PATHS so this branch shouldn't normally fire, but the closure
 *     guards against future changes)
 *   - Query string is preserved alongside the pathname
 *   - Special characters get URL-encoded by URLSearchParams
 *
 * Mirrors the mock layout of hooks-server-setup-redirect.server.test.ts and
 * hooks-server-session-refresh.server.test.ts.
 */

// CRITICAL: must run BEFORE the dynamic `await import(...)` of hooks.server,
// because that module has top-level side effects gated on this env var.
process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(async () => 1),
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
  lookupSessionByTokenHash: vi.fn(),
  touchSession: vi.fn(async () => {}),
  rotateSessionToken: vi.fn(),
}));
vi.mock("$server/auth/jwt", () => ({
  verifyJWT: vi.fn(),
  getJwtSecret: vi.fn(async () => "secret"),
  signJWT: vi.fn(async () => "rotated-token"),
}));
vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(async () => undefined),
}));

import { verifyJWT } from "$server/auth/jwt";
import { lookupSessionByTokenHash } from "$server/db/queries/sessions";
const { handle } = await import("../hooks.server");

function isRedirect(err: unknown): err is { status: number; location: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as any).status === "number" &&
    typeof (err as any).location === "string"
  );
}

function makeEvent(opts: { path?: string; method?: string; cookie?: string } = {}) {
  const path = opts.path ?? "/projects/abc";
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

async function captureRedirect(event: any): Promise<{ status: number; location: string }> {
  let thrown: unknown;
  try {
    await handle({ event, resolve: vi.fn() } as any);
  } catch (err) {
    thrown = err;
  }
  if (!isRedirect(thrown)) {
    throw new Error(`expected redirect, got: ${String(thrown)}`);
  }
  return thrown;
}

describe("hooks.server.ts — returnTo on /login redirects", () => {
  beforeEach(() => {
    vi.mocked(verifyJWT).mockReset();
    vi.mocked(lookupSessionByTokenHash).mockReset();
  });

  // ── No auth (no cookie, attachBearerAuth no-op) ───────────────────

  describe("no-auth branch (cookie missing)", () => {
    test("GET /projects/abc → /login?returnTo=%2Fprojects%2Fabc", async () => {
      const r = await captureRedirect(makeEvent({ path: "/projects/abc" }));
      expect(r.status).toBe(302);
      expect(r.location).toBe("/login?returnTo=%2Fprojects%2Fabc");
    });

    test("GET preserves query string in returnTo", async () => {
      const r = await captureRedirect(makeEvent({ path: "/chat/xyz?tab=files" }));
      // URLSearchParams percent-encodes /, ?, = → returnTo round-trips through
      // the consumer (login +page.server.ts) which calls searchParams.get()
      // and gets back "/chat/xyz?tab=files".
      expect(r.location).toBe("/login?returnTo=%2Fchat%2Fxyz%3Ftab%3Dfiles");
    });

    test("POST /projects/abc → /login (no returnTo, POST is not a 'page')", async () => {
      const r = await captureRedirect(makeEvent({ path: "/projects/abc", method: "POST" }));
      expect(r.location).toBe("/login");
    });

    test("PUT /api/foo (non-API path treated as page) → no returnTo", async () => {
      // /api/* paths return 401 JSON instead of redirecting — choose a
      // non-/api path so we exercise the PUT-no-returnTo branch.
      const r = await captureRedirect(makeEvent({ path: "/projects/abc", method: "PUT" }));
      expect(r.location).toBe("/login");
    });
  });

  // ── Session-expired branch (verifyJWT returns null) ───────────────

  describe("session-expired branch (JWT invalid)", () => {
    beforeEach(() => {
      vi.mocked(verifyJWT).mockResolvedValue(null);
    });

    test("GET /chat/abc → reason=session_expired&returnTo=...", async () => {
      const r = await captureRedirect(
        makeEvent({ path: "/chat/abc", cookie: "stale-jwt" }),
      );
      expect(r.location).toBe("/login?reason=session_expired&returnTo=%2Fchat%2Fabc");
    });

    test("POST /chat/abc → reason=session_expired only (no returnTo)", async () => {
      const r = await captureRedirect(
        makeEvent({ path: "/chat/abc", method: "POST", cookie: "stale-jwt" }),
      );
      expect(r.location).toBe("/login?reason=session_expired");
    });

    test("path with hash-fragment-like char preserved correctly", async () => {
      // url.search captures only ?... — the # fragment is browser-side and
      // never reaches the server, so we don't need to test it. This test
      // pins down what we DO carry: pathname + search.
      const r = await captureRedirect(
        makeEvent({ path: "/projects/abc?step=2&filter=open", cookie: "stale-jwt" }),
      );
      expect(r.location).toBe(
        "/login?reason=session_expired&returnTo=%2Fprojects%2Fabc%3Fstep%3D2%26filter%3Dopen",
      );
    });
  });

  // ── Session-revoked branch (valid JWT, missing session row) ──────

  describe("session-revoked branch (JWT valid, row missing)", () => {
    beforeEach(() => {
      vi.mocked(verifyJWT).mockResolvedValue({
        id: "u-1",
        email: "u@test.com",
        name: "U",
        role: "member",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      } as any);
      vi.mocked(lookupSessionByTokenHash).mockResolvedValue(null);
    });

    test("GET /admin → reason=session_revoked&returnTo=...", async () => {
      const r = await captureRedirect(
        makeEvent({ path: "/admin", cookie: "valid-but-revoked" }),
      );
      expect(r.location).toBe("/login?reason=session_revoked&returnTo=%2Fadmin");
    });

    test("POST /admin → reason=session_revoked only (no returnTo)", async () => {
      const r = await captureRedirect(
        makeEvent({ path: "/admin", method: "POST", cookie: "valid-but-revoked" }),
      );
      expect(r.location).toBe("/login?reason=session_revoked");
    });
  });

  // ── Round-trip sanity ─────────────────────────────────────────────

  test("returnTo round-trips through URL parsing", async () => {
    const r = await captureRedirect(
      makeEvent({ path: "/chat/xyz?tab=files&q=hello%20world" }),
    );
    // The browser will GET this Location URL, hit the login load(), which
    // calls url.searchParams.get("returnTo") → expects to recover the
    // original path verbatim. Verify here so the contract is locked.
    const parsed = new URL(`http://localhost${r.location}`);
    expect(parsed.searchParams.get("returnTo")).toBe(
      "/chat/xyz?tab=files&q=hello%20world",
    );
  });
});
