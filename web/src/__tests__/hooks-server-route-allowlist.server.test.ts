/**
 * Boundary 1 END TO END through the real `handle` hook in
 * `src/hooks.server.ts` — the pure predicate is unit-tested next to its module
 * (`__tests__/security/route-allowlist.test.ts`); this file proves the hook
 * WIRES it at a point where the principal is already resolved and `resolve()`
 * has not yet run.
 *
 * Four arms on every guard, and the last two are the back-compat contract:
 *
 *   1. a policied key on a non-allowlisted route → 403, `resolve()` never runs;
 *   2. a policied key on an allowlisted route    → served;
 *   3. an UNPOLICIED key                          → served, unchanged;
 *   4. a COOKIE SESSION                           → served, unchanged.
 *
 * Plus the two fail-closed properties that make the gate worth having: an
 * unmatched path (`route.id === null`) is denied, and the SSE stream at
 * `/api/runtime-events` is gated at connection OPEN — the only point it can
 * be, since the stream is produced by `resolve()` and never re-enters here.
 */

// CRITICAL: set BEFORE the dynamic import of hooks.server — that module's
// top-level `await ensureInitialized()` / background timers are gated on it.
process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";
process.env.TRUSTED_PROXY_COUNT = "0";

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(async () => 1),
  getUserById: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/context", () => ({ ensureInitialized: vi.fn(async () => {}) }));
vi.mock("$server/startup/background-timers", () => ({
  startBackgroundTimers: vi.fn(async () => {}),
}));

/** The `desktop-companion` reach, as it is stored on a minted key. */
const ALLOW = [
  "POST /api/conversations",
  "POST /api/conversations/[id]/messages",
  "GET /api/runtime-events",
];

/**
 * Stand-in bearer router. `ezk_policied` authenticates AND stamps a policy;
 * `ezk_plain` authenticates with no policy at all. Mocked rather than real so
 * the assertion is about the HOOK's wiring, not about `verifyApiKey`.
 */
vi.mock("$lib/server/security/bearer-auth", () => ({
  attachBearerAuth: vi.fn(
    async (
      evt: {
        locals: {
          user?: unknown;
          apiKeyScopes?: unknown;
          apiKeyToolPolicy?: unknown;
          authMethod?: string;
        };
      },
      authHeader: string | null | undefined,
    ) => {
      if (authHeader !== "Bearer ezk_policied" && authHeader !== "Bearer ezk_plain") {
        return false;
      }
      evt.locals.user = { id: "key-user", email: "", name: "Key", role: "member" };
      evt.locals.apiKeyScopes = ["read", "write", "chat"];
      evt.locals.authMethod = "api-key";
      if (authHeader === "Bearer ezk_policied") {
        evt.locals.apiKeyToolPolicy = { routeAllowlist: ALLOW };
      }
      return true;
    },
  ),
}));

vi.mock("$server/db/queries/sessions", () => ({
  hashToken: vi.fn(async () => "hash"),
  lookupSessionByTokenHash: vi.fn(async () => ({ session: { id: "sess-1" }, viaPrevious: false })),
  touchSession: vi.fn(async () => {}),
  rotateSessionToken: vi.fn(async () => null),
}));
vi.mock("$server/auth/jwt", () => ({
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
vi.mock("$server/db/queries/settings", () => ({ getSetting: vi.fn(async () => undefined) }));

const { handle } = await import("../hooks.server");

/**
 * A fake `RequestEvent`. `route` is stamped the way SvelteKit stamps it —
 * `{ id }` before `handle` runs, with `id === null` for an unmatched path.
 */
function makeEvent(opts: {
  routeId: string | null;
  path?: string;
  method?: string;
  authHeader?: string;
  cookie?: string;
}) {
  const path = opts.path ?? (opts.routeId ?? "/nope");
  const headers: Record<string, string> = {};
  if (opts.authHeader) headers.authorization = opts.authHeader;
  if (opts.cookie) headers.cookie = `ezcorp_session=${opts.cookie}`;
  return {
    request: new Request(`http://localhost${path}`, { method: opts.method ?? "GET", headers }),
    url: new URL(`http://localhost${path}`),
    cookies: {
      get: vi.fn((name: string) =>
        opts.cookie && name === "ezcorp_session" ? opts.cookie : undefined,
      ),
      set: vi.fn(),
      delete: vi.fn(),
    },
    locals: {},
    getClientAddress: () => "127.0.0.1",
    route: { id: opts.routeId },
    params: {},
    setHeaders: vi.fn(),
    fetch: vi.fn(),
    isDataRequest: false,
    isSubRequest: false,
  } as any;
}

/** Run the hook and report the status plus whether `resolve()` was reached. */
async function run(event: unknown): Promise<{ status: number; resolved: boolean }> {
  const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
  const res = (await handle({ event, resolve } as any)) as Response;
  return { status: res.status, resolved: resolve.mock.calls.length > 0 };
}

const POLICIED = "Bearer ezk_policied";
const PLAIN = "Bearer ezk_plain";

beforeEach(() => vi.clearAllMocks());

describe("a POLICIED key", () => {
  test("is served on an allowlisted route", async () => {
    expect(
      await run(
        makeEvent({
          routeId: "/api/conversations/[id]/messages",
          path: "/api/conversations/abc/messages",
          method: "POST",
          authHeader: POLICIED,
        }),
      ),
    ).toEqual({ status: 200, resolved: true });
  });

  test("is 403 on an HTTP-initiated spawn route, and never reaches the handler", async () => {
    // The bypass class Boundary 1 exists for: `POST /api/workflows/:name/run`
    // starts a run with no LLM tool call, so no tool-surface filter can see it.
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = (await handle({
      event: makeEvent({
        routeId: "/api/workflows/[name]/run",
        path: "/api/workflows/my-flow/run",
        method: "POST",
        authHeader: POLICIED,
      }),
      resolve,
    } as any)) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Route not permitted for this key",
      route: "POST /api/workflows/[name]/run",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("is 403 on the same route with a different METHOD", async () => {
    const { status } = await run(
      makeEvent({
        routeId: "/api/conversations/[id]/messages",
        path: "/api/conversations/abc/messages",
        method: "DELETE",
        authHeader: POLICIED,
      }),
    );
    expect(status).toBe(403);
  });

  test("is 403 on an UNMATCHED path (route.id === null) — fail-closed for free", async () => {
    const { status, resolved } = await run(
      makeEvent({ routeId: null, path: "/api/does-not-exist", authHeader: POLICIED }),
    );
    expect(status).toBe(403);
    expect(resolved).toBe(false);
  });

  test("opens the SSE stream only when it is allowlisted", async () => {
    // Gated at connection OPEN because the stream body is produced by
    // resolve() and never re-enters the hook.
    expect(
      (await run(makeEvent({ routeId: "/api/runtime-events", authHeader: POLICIED }))).status,
    ).toBe(200);
  });

  test("reaches the liveness probe regardless of its allowlist", async () => {
    expect((await run(makeEvent({ routeId: "/api/health", authHeader: POLICIED }))).status).toBe(200);
  });
});

describe("back-compat — nothing else is confined", () => {
  test("an UNPOLICIED key reaches the spawn route exactly as before", async () => {
    expect(
      await run(
        makeEvent({
          routeId: "/api/workflows/[name]/run",
          path: "/api/workflows/my-flow/run",
          method: "POST",
          authHeader: PLAIN,
        }),
      ),
    ).toEqual({ status: 200, resolved: true });
  });

  test("a COOKIE SESSION reaches the spawn route exactly as before", async () => {
    expect(
      await run(
        makeEvent({
          routeId: "/api/workflows/[name]/run",
          path: "/api/workflows/my-flow/run",
          method: "POST",
          cookie: "valid-cookie",
        }),
      ),
    ).toEqual({ status: 200, resolved: true });
  });

  test("an unpolicied principal is served even on an unmatched path", async () => {
    // The gate must not turn a 404-to-be into a 403 for anybody it does not
    // confine — `route.id === null` is only meaningful when an allowlist exists.
    expect(
      (await run(makeEvent({ routeId: null, path: "/api/does-not-exist", authHeader: PLAIN })))
        .resolved,
    ).toBe(true);
  });
});
