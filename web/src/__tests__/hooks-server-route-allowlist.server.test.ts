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
 *
 * AND the fifth arm, added with the second Boundary-1 rule: a LOCK-ONLY key
 * (`{lockedModeId}`, no allowlist) starts no run. The hook used to read
 * `policy?.routeAllowlist` and branch on it, so that policy — which the mint
 * now refuses, but which existing keys still carry — was enforced on nothing.
 * The hook passes the WHOLE policy to `toolPolicyRouteDenial` for that reason;
 * this file is where "the hook wires it" is proved.
 *
 * And the SIXTH: a lock WITH an allowlist that names an unguardable run-start
 * route (`ezk_lock_bundled` below). That shape was mintable before this PR and
 * is not now, and it is served by every other layer — the allowlist arm
 * permits, and the route has no Boundary 2 — so the lock was advertised and
 * enforced nowhere. It must be refused on the unguardable route and STILL
 * served on the guarded one it also names, or the rule has broken the very key
 * `--route-bundle` exists to produce.
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
      const KNOWN = [
        "Bearer ezk_policied",
        "Bearer ezk_plain",
        "Bearer ezk_locked",
        "Bearer ezk_lock_bundled",
      ];
      if (!authHeader || !KNOWN.includes(authHeader)) return false;
      evt.locals.user = { id: "key-user", email: "", name: "Key", role: "member" };
      evt.locals.apiKeyScopes = ["read", "write", "chat"];
      evt.locals.authMethod = "api-key";
      if (authHeader === "Bearer ezk_policied") {
        evt.locals.apiKeyToolPolicy = { routeAllowlist: ALLOW };
      }
      // The key ALREADY IN THE WILD: `ezcorp key mint --locked-mode <id>` with
      // no `--route-bundle`. The mint refuses this shape now; a key minted
      // before it does not re-validate itself, so the hook has to.
      if (authHeader === "Bearer ezk_locked") {
        evt.locals.apiKeyToolPolicy = { lockedModeId: "mode-1" };
      }
      // The SECOND key in the wild: a lock plus a hand-written allowlist that
      // names a run-start route no mode can gate. Also mintable before this PR,
      // also served by every other layer.
      if (authHeader === "Bearer ezk_lock_bundled") {
        evt.locals.apiKeyToolPolicy = {
          lockedModeId: "mode-1",
          routeAllowlist: ["POST /api/briefing/run-now", "POST /api/conversations/[id]/messages"],
        };
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
const LOCKED = "Bearer ezk_locked";
const LOCK_BUNDLED = "Bearer ezk_lock_bundled";

beforeEach(() => vi.clearAllMocks());

describe("a LOCK + ALLOWLIST key that names an unguardable run start", () => {
  test("is 403 on that route, and never reaches the handler", async () => {
    // The residual the FIRST version of this rule left: it returned null the
    // moment a `routeAllowlist` was present, so this key — allowlist says yes,
    // no Boundary 2 on the route — was served with its lock enforced nowhere.
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = (await handle({
      event: makeEvent({
        routeId: "/api/briefing/run-now",
        method: "POST",
        authHeader: LOCK_BUNDLED,
      }),
      resolve,
    } as any)) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        "This key is locked to a mode that cannot be enforced on this run-start route — re-mint it without that route",
      route: "POST /api/briefing/run-now",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("is STILL SERVED on the mode-guarded run-start route it also names", async () => {
    // The half that keeps the rule honest. `POST …/messages` reads the
    // conversation's persisted `mode_id` and runs `runStartPolicyDenial`, so
    // the lock applies there for real — refusing it would break the only lock
    // shape the mint accepts and make `--locked-mode` unusable.
    expect(
      await run(
        makeEvent({
          routeId: "/api/conversations/[id]/messages",
          path: "/api/conversations/abc/messages",
          method: "POST",
          authHeader: LOCK_BUNDLED,
        }),
      ),
    ).toEqual({ status: 200, resolved: true });
  });

  test("is 403 on a run-start route it does NOT name — the allowlist arm, unchanged", async () => {
    // Ordering is observable through the message: the allowlist refusal is the
    // actionable one ("widen the bundle"), so it must still win when both arms
    // would fire.
    const res = (await handle({
      event: makeEvent({
        routeId: "/api/agents/[name]/run",
        method: "POST",
        authHeader: LOCK_BUNDLED,
      }),
      resolve: vi.fn(async () => new Response("ok", { status: 200 })),
    } as any)) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Route not permitted for this key",
      route: "POST /api/agents/[name]/run",
    });
  });
});

describe("a LOCK-ONLY key (minted before the mint refused the shape)", () => {
  test("is 403 on a run-start route it used to reach, and never reaches the handler", async () => {
    // The residual the mint fix could not close. `if (routeAllow)` was the
    // whole of Boundary 1, and this policy has no `routeAllowlist` — so the
    // hook read nothing, the key reached `POST /api/briefing/run-now`, and the
    // run it started skipped `mayUseMode` entirely.
    const resolve = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = (await handle({
      event: makeEvent({
        routeId: "/api/briefing/run-now",
        method: "POST",
        authHeader: LOCKED,
      }),
      resolve,
    } as any)) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        "This key is locked to a mode but names no routeAllowlist, so it may not start a run — re-mint it with a route bundle",
      route: "POST /api/briefing/run-now",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("is 403 on the hub actions route — the second door to the same run", async () => {
    expect(
      (
        await run(
          makeEvent({
            routeId: "/api/hub/pages/[id]/actions/[action]",
            path: "/api/hub/pages/core:briefing/actions/run-now",
            method: "POST",
            authHeader: LOCKED,
          }),
        )
      ).status,
    ).toBe(403);
  });

  test("is 403 on the conversation run-start routes too — the runtime matches the mint", async () => {
    // Refused on EVERY run-start route, not just the unguardable ones: the
    // mint would reject this policy outright, so nothing it could have minted
    // may start a run. A narrower rule would be a third reading of one shape.
    for (const routeId of [
      "/api/conversations/[id]/messages",
      "/api/agents/[name]/run",
      "/api/workflows/[name]/run",
      "/api/integrations/github-projects/proposals/[id]/approve",
    ]) {
      expect(
        (await run(makeEvent({ routeId, method: "POST", authHeader: LOCKED }))).status,
      ).toBe(403);
    }
  });

  test("still reaches everything that starts no run", async () => {
    // Not a quarantine — the key keeps reading its own conversations. A rule
    // that bricked the credential would be traded for one nobody deploys.
    expect(
      await run(makeEvent({ routeId: "/api/conversations/[id]", authHeader: LOCKED })),
    ).toEqual({ status: 200, resolved: true });
    expect(
      (await run(makeEvent({ routeId: "/api/runtime-events", authHeader: LOCKED }))).status,
    ).toBe(200);
  });
});

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

  test("an UNPOLICIED key and a COOKIE SESSION both still trigger a briefing", async () => {
    // The new lock rule keys on `lockedModeId`, so a principal that carries no
    // policy at all must be byte-for-byte unchanged on the route the rule
    // guards — including the human whose own session drives the Hub tab.
    expect(
      await run(makeEvent({ routeId: "/api/briefing/run-now", method: "POST", authHeader: PLAIN })),
    ).toEqual({ status: 200, resolved: true });
    expect(
      await run(
        makeEvent({ routeId: "/api/briefing/run-now", method: "POST", cookie: "valid-cookie" }),
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
