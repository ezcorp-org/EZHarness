/**
 * Server-handler unit tests for the auth-gate branches in
 * `src/hooks.server.ts`. Specifically exercises the
 * `users.length === 0 → /setup` path:
 *   - browser request → `throw redirect(302, "/setup")`
 *   - `/api/*` request → 401 JSON `{ error: "Setup required" }`
 *   - `PUBLIC_PATHS` (e.g. `/setup`, `/api/auth/setup`) → bypass the gate
 *   - DB unavailable (getUserCount rejects) → fall through to `resolve`
 *   - non-zero count + no session → `throw redirect(302, "/login")`
 *
 * Mocks every DB / init / auth boundary the hook touches so the module
 * imports cleanly without PGlite or a JWT secret. PI_SKIP_INIT is set
 * before the dynamic import of the hook to short-circuit the top-level
 * `await ensureInitialized()` / `await startBackgroundTimers()` block.
 */

// CRITICAL: must run BEFORE the dynamic `await import(...)` of hooks.server,
// because that module has top-level side effects gated on this env var.
process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(),
}));
vi.mock("$lib/server/context", () => ({
  ensureInitialized: vi.fn(async () => {}),
}));
vi.mock("$server/startup/background-timers", () => ({
  startBackgroundTimers: vi.fn(async () => {}),
}));
vi.mock("$lib/server/security/bearer-auth", () => ({
  // No-op: leaves event.locals.user undefined so the auth gate engages.
  attachBearerAuth: vi.fn(async () => {}),
}));
vi.mock("$server/db/queries/sessions", () => ({
  hashToken: vi.fn(async () => "hash"),
  lookupSessionByTokenHash: vi.fn(async () => null),
  touchSession: vi.fn(async () => {}),
  rotateSessionToken: vi.fn(async () => null),
}));
vi.mock("$server/auth/jwt", () => ({
  verifyJWT: vi.fn(async () => null),
  getJwtSecret: vi.fn(async () => "secret"),
}));
vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(async () => undefined),
}));

// Static import is safe: vi.mock() is hoisted above import statements by
// vitest, so getUserCount resolves to the mock. The hook stays dynamic
// because its top-level `await ensureInitialized()` is gated on
// PI_SKIP_INIT, which is set just above (top-level assignment is NOT
// hoisted, so the env must run before the import).
import { getUserCount } from "$server/db/queries/users";
const { handle } = await import("../hooks.server");

// ── Helpers ──────────────────────────────────────────────────────────

/** Detect a redirect thrown by SvelteKit (real Redirect class or shape). */
function isRedirect(err: unknown): err is { status: number; location: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as any).status === "number" &&
    typeof (err as any).location === "string"
  );
}

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

describe("hooks.server.ts — setup redirect branch", () => {
  beforeEach(() => {
    vi.mocked(getUserCount).mockReset();
  });

  test("browser request to / with no session and zero users → throws 302 redirect to /setup", async () => {
    vi.mocked(getUserCount).mockResolvedValue(0);
    const event = makeEvent("/");
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
    expect(thrown.location).toBe("/setup");
    expect(resolve).not.toHaveBeenCalled();
  });

  test("api request to /api/conversations with no session and zero users → 401 JSON 'Setup required'", async () => {
    vi.mocked(getUserCount).mockResolvedValue(0);
    const event = makeEvent("/api/conversations");
    const resolve = vi.fn();

    const res = (await handle({ event, resolve } as any)) as Response;
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = (await res.json()) as { error?: string };
    expect(body).toEqual({ error: "Setup required" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("public path /setup → bypasses gate and calls resolve", async () => {
    vi.mocked(getUserCount).mockResolvedValue(0);
    const event = makeEvent("/setup");
    const expected = new Response("ok", { status: 200 });
    const resolve = vi.fn(async () => expected);

    const res = (await handle({ event, resolve } as any)) as Response;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(event, expect.anything());
    expect(res.status).toBe(200);
    // getUserCount should NOT be consulted on a public path.
    expect(vi.mocked(getUserCount)).not.toHaveBeenCalled();
  });

  test("public path /api/auth/setup → bypasses gate and calls resolve", async () => {
    vi.mocked(getUserCount).mockResolvedValue(0);
    const event = makeEvent("/api/auth/setup", { method: "POST" });
    const expected = new Response("ok", { status: 200 });
    const resolve = vi.fn(async () => expected);

    const res = (await handle({ event, resolve } as any)) as Response;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(event, expect.anything());
    expect(res.status).toBe(200);
    expect(vi.mocked(getUserCount)).not.toHaveBeenCalled();
  });

  test("DB unavailable (getUserCount rejects) → falls through to resolve, no redirect / 401", async () => {
    vi.mocked(getUserCount).mockRejectedValue(new Error("DB down"));
    const event = makeEvent("/projects/abc");
    const expected = new Response("ok", { status: 200 });
    const resolve = vi.fn(async () => expected);

    const res = (await handle({ event, resolve } as any)) as Response;
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  test("browser request to /projects/abc with no session and one user → 302 redirect to /login", async () => {
    vi.mocked(getUserCount).mockResolvedValue(1);
    const event = makeEvent("/projects/abc");
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
    // GET → returnTo is included so the user lands back on /projects/abc after login
    expect(thrown.location).toBe("/login?returnTo=%2Fprojects%2Fabc");
    expect(resolve).not.toHaveBeenCalled();
  });
});
