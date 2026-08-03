/**
 * F5 — `/api/auth/invite` public-path scoping, exercised through the REAL
 * `hooks.server.ts` `handle`.
 *
 * The bug: `/api/auth/invite` was a PUBLIC_PATHS entry, and `isPublic`
 * matches an entry exactly OR as a prefix (`p + "/"`). But
 * `event.locals.user` is only ever assigned inside the `if (!isPublic)`
 * block — the cookie branch at its end, and `attachBearerAuth` near its
 * top. So a public path skipped auth entirely, `locals.user` stayed
 * undefined, and the ADMIN invite create/list handlers (which call
 * `requireRole(locals, "admin")`) always 401'd. Unreachable over HTTP.
 *
 * Why the existing coverage missed it: the e2e stubs the response
 * (`web/e2e/teams.spec.ts`) and the handler unit test injects a synthetic
 * `locals` (`api-auth-invite.server.test.ts`). Neither crosses the hook, so
 * neither could see that nothing populates `locals` on this path. This file
 * therefore drives `handle` itself and asserts on what the hook does to
 * `event.locals` — the exact seam both other suites skip.
 *
 * Both directions are proven:
 *   - `/api/auth/invite/:token`  → still public (resolve, no auth work).
 *   - `/api/auth/invite`  (bare) → authenticated; 401 without a session,
 *     and WITH a valid admin session the hook populates `locals.user`, so
 *     the admin handler is finally reachable.
 */

// CRITICAL: must run BEFORE the dynamic import of hooks.server — that
// module has top-level side effects gated on this env var.
process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({ getUserCount: vi.fn() }));
vi.mock("$lib/server/context", () => ({ ensureInitialized: vi.fn(async () => {}) }));
vi.mock("$server/startup/background-timers", () => ({
  startBackgroundTimers: vi.fn(async () => {}),
}));
vi.mock("$lib/server/security/bearer-auth", () => ({
  // No-op: leaves locals.user undefined so the cookie path is what's tested.
  attachBearerAuth: vi.fn(async () => {}),
}));
vi.mock("$server/db/queries/sessions", () => ({
  hashToken: vi.fn(async () => "hash"),
  lookupSessionByTokenHash: vi.fn(),
  touchSession: vi.fn(async () => {}),
  rotateSessionToken: vi.fn(async () => null),
}));
vi.mock("$server/auth/jwt", () => ({
  verifyJWT: vi.fn(),
  getJwtSecret: vi.fn(async () => "secret"),
}));
vi.mock("$server/db/queries/settings", () => ({ getSetting: vi.fn(async () => undefined) }));

import { getUserCount } from "$server/db/queries/users";
import { lookupSessionByTokenHash } from "$server/db/queries/sessions";
import { verifyJWT } from "$server/auth/jwt";
const { handle } = await import("../hooks.server");

const ADMIN_PAYLOAD = {
  id: "admin-1",
  email: "a@x",
  name: "A",
  role: "admin",
  // Fresh enough that the sliding-refresh branch is skipped.
  iat: Math.floor(Date.now() / 1000),
};

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
  } as never as { locals: Record<string, unknown> };
}

describe("hooks.server.ts — /api/auth/invite public-path scoping (F5)", () => {
  beforeEach(() => {
    vi.mocked(getUserCount).mockReset().mockResolvedValue(1);
    vi.mocked(verifyJWT).mockReset().mockResolvedValue(null);
    vi.mocked(lookupSessionByTokenHash).mockReset().mockResolvedValue(null);
  });

  // ── Direction 1: the TOKEN sub-path stays anonymous ────────────────
  test.each([
    ["GET", "/api/auth/invite/tok-abc"],
    ["POST", "/api/auth/invite/tok-abc"],
  ])("%s %s → still public: resolves without any auth work", async (method, path) => {
    const event = makeEvent(path, { method });
    const expected = new Response("ok", { status: 200 });
    const resolve = vi.fn(async () => expected);

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    // A public path must not consult the user table at all.
    expect(getUserCount).not.toHaveBeenCalled();
  });

  // ── Direction 2: the BARE path is authenticated ────────────────────
  test.each([["GET"], ["POST"]])(
    "%s /api/auth/invite with no session → 401, never reaches the handler",
    async (method) => {
      const event = makeEvent("/api/auth/invite", { method });
      const resolve = vi.fn();

      const res = (await handle({ event, resolve } as never)) as Response;

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Authentication required");
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  // The regression that matters: pre-fix the hook skipped its whole auth
  // block for this path, so `locals.user` was undefined even WITH a valid
  // admin cookie and `requireRole` 401'd forever.
  test.each([["GET"], ["POST"]])(
    "%s /api/auth/invite with a valid admin session → hook populates locals.user",
    async (method) => {
      vi.mocked(verifyJWT).mockResolvedValue(ADMIN_PAYLOAD as never);
      vi.mocked(lookupSessionByTokenHash).mockResolvedValue({
        session: { id: "sess-1" },
        viaPrevious: false,
      } as never);

      const event = makeEvent("/api/auth/invite", { method, cookie: "jwt-token" });
      const expected = new Response("ok", { status: 200 });
      const resolve = vi.fn(async () => expected);

      const res = (await handle({ event, resolve } as never)) as Response;

      expect(res.status).toBe(200);
      expect(resolve).toHaveBeenCalledTimes(1);
      // This is the assertion the pre-fix tree cannot satisfy.
      expect(event.locals.user).toEqual({
        id: "admin-1",
        email: "a@x",
        name: "A",
        role: "admin",
      });
    },
  );

  // Guard the matcher itself: a prefix that merely SHARES the string must
  // not be swept in as public by the new sub-path rule.
  test("a sibling path that only shares the prefix is NOT public", async () => {
    const event = makeEvent("/api/auth/invitations");
    const resolve = vi.fn();

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(res.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  // The other PUBLIC_PATHS entries keep exact-OR-prefix semantics — the new
  // list must not have narrowed them.
  test.each([
    ["/api/auth/login"],
    ["/api/auth/reset-password"],
    ["/api/auth/reset-password/tok-1"],
    ["/api/health"],
  ])("%s stays public (exact and sub-path semantics preserved)", async (path) => {
    const event = makeEvent(path, { method: "POST" });
    const expected = new Response("ok", { status: 200 });
    const resolve = vi.fn(async () => expected);

    const res = (await handle({ event, resolve } as never)) as Response;

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(getUserCount).not.toHaveBeenCalled();
  });
});
