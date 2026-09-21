/**
 * Server-handler tests for five branches of `src/hooks.server.ts` that no
 * suite reached: the legacy `pi_session` migration on BOTH sides of its
 * sec-M4 expiry, the fail-CLOSED 503 when the user table is unreachable, the
 * unjudgeable-cookie pass-through, the loopback fallback when the adapter
 * cannot report a peer, and the HSTS header on an https request.
 *
 * WHY THESE FIVE. Each is a security control whose WRONG behaviour is silent:
 * a legacy cookie honoured past its window is an unbounded promotion of a
 * stolen credential; a transient DB failure that fell OPEN would serve every
 * protected route unauthenticated for the length of the outage; a cookie the
 * server cannot judge must neither authenticate nor bounce a legitimate user;
 * and a missing HSTS header downgrades every later request. They were
 * reachable before and are reachable now — the refactor that gave each of them
 * a name is what made their absence from the suite visible.
 *
 * THE CLOCK IS PINNED, NEVER MEASURED. `PI_SESSION_MIGRATION_EXPIRES_AT` is a
 * fixed date in the module, so whether the window is open depends on the
 * wall clock. `vi.setSystemTime` fixes it either side of that date, which
 * turns "usually true today" into an equality the test owns.
 */

// CRITICAL: must run BEFORE the dynamic `await import(...)` of hooks.server,
// because that module has top-level side effects gated on this env var.
process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  getUserCount: vi.fn(),
  getUserById: vi.fn(async () => undefined),
}));
vi.mock("$lib/server/context", () => ({
  ensureInitialized: vi.fn(async () => {}),
}));
vi.mock("$server/startup/background-timers", () => ({
  startBackgroundTimers: vi.fn(async () => {}),
  stopBackgroundTimers: vi.fn(async () => {}),
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
  signJWT: vi.fn(async () => "signed"),
}));
vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(async () => undefined),
}));
// One shared logger stub for every `child(...)` call, because the module under
// test holds its OWN child and a child built here would be a different object.
// Only `logger` is replaced: the module also exports `extensionLogger`, which
// unrelated modules in this import graph call at load time.
vi.mock("$server/logger", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const sink: Record<string, unknown> = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  sink.child = vi.fn(() => sink);
  return { ...actual, logger: sink };
});

import { getUserCount } from "$server/db/queries/users";
import { getJwtSecret } from "$server/auth/jwt";
import { logger } from "$server/logger";

const log = logger.child("hooks.server");
const { handle } = await import("../hooks.server");

/** Milliseconds either side of the sec-M4 expiry (2026-06-01T00:00:00Z). */
const WINDOW_OPEN = Date.parse("2026-05-31T23:00:00Z");
const WINDOW_CLOSED = Date.parse("2026-06-01T01:00:00Z");

type CookieJar = { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; serialize: ReturnType<typeof vi.fn> };

function makeEvent(
  path: string,
  opts: { method?: string; cookies?: Record<string, string>; clientAddress?: () => string; protocol?: string; headers?: Record<string, string> } = {},
): { event: any; cookies: CookieJar } {
  const jar = opts.cookies ?? {};
  const cookies: CookieJar = {
    get: vi.fn((name: string) => jar[name]),
    set: vi.fn(),
    delete: vi.fn(),
    serialize: vi.fn(() => "pi_session=; Max-Age=0"),
  };
  const origin = `${opts.protocol ?? "http"}://localhost`;
  return {
    cookies,
    event: {
      request: new Request(`${origin}${path}`, { method: opts.method ?? "GET", headers: opts.headers ?? {} }),
      url: new URL(`${origin}${path}`),
      cookies,
      locals: {},
      getClientAddress: opts.clientAddress ?? (() => "127.0.0.1"),
      route: { id: path },
      params: {},
      setHeaders: vi.fn(),
      fetch: vi.fn(),
      isDataRequest: false,
      isSubRequest: false,
    } as any,
  };
}

/** Detect a redirect thrown by SvelteKit (real Redirect class or shape). */
function isRedirect(err: unknown): err is { status: number; location: string } {
  return typeof err === "object" && err !== null && typeof (err as any).status === "number" && typeof (err as any).location === "string";
}

/** Run the hook and return whatever it produced: a response or a thrown redirect. */
async function run(event: any, resolve: ReturnType<typeof vi.fn>): Promise<{ response?: Response; thrown?: unknown }> {
  try {
    return { response: (await handle({ event, resolve } as any)) as Response };
  } catch (err) {
    return { thrown: err };
  }
}

describe("hooks.server.ts — legacy pi_session migration (sec-M4)", () => {
  beforeEach(() => {
    vi.mocked(getUserCount).mockReset();
    vi.mocked(getUserCount).mockResolvedValue(1);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("past the expiry the legacy cookie is ignored, purged, and warned about exactly once", async () => {
    vi.setSystemTime(WINDOW_CLOSED);
    vi.mocked(log.warn).mockClear();

    // Two requests in the same module instance: the warning latches, and a
    // per-request warning on a closed window would flood the log for every
    // client still presenting the old cookie.
    for (const _ of [0, 1]) {
      const { event, cookies } = makeEvent("/projects/abc", { cookies: { pi_session: "legacy-token" } });
      const { thrown } = await run(event, vi.fn());
      if (!isRedirect(thrown)) throw thrown ?? new Error("expected a redirect");
      // Ignored, so the request is unauthenticated and bounces to /login.
      expect(thrown.location).toBe("/login?returnTo=%2Fprojects%2Fabc");
      // Purged, so the client stops presenting it.
      expect(cookies.set).toHaveBeenCalledWith("pi_session", "", { path: "/", httpOnly: true, sameSite: "lax", maxAge: 0 });
    }

    const migrationWarnings = vi.mocked(log.warn).mock.calls.filter(([message]) => String(message).includes("pi_session migration window closed"));
    expect(migrationWarnings).toHaveLength(1);
  });

  test("inside the window the legacy cookie is promoted to the current one and retired", async () => {
    vi.setSystemTime(WINDOW_OPEN);
    const { event, cookies } = makeEvent("/projects/abc", { cookies: { pi_session: "legacy-token" } });

    // verifyJWT still answers null, so the promoted token fails verification
    // and the request is refused. What this pins is the PROMOTION: the hook
    // adopted the legacy value and re-issued it under the current name.
    const { thrown } = await run(event, vi.fn());
    if (!isRedirect(thrown)) throw thrown ?? new Error("expected a redirect");

    expect(cookies.set).toHaveBeenCalledWith("pi_session", "", { path: "/", httpOnly: true, sameSite: "lax", maxAge: 0 });
    // The current cookie is re-issued with the legacy token's own value.
    const promoted = cookies.set.mock.calls.find(([name]) => name !== "pi_session");
    expect(promoted?.[1]).toBe("legacy-token");
    // A rejected session clears the cookie and bounces with the expired reason.
    expect(thrown.location).toBe("/login?reason=session_expired&returnTo=%2Fprojects%2Fabc");
  });
});

describe("hooks.server.ts — fail-closed and unjudgeable-credential branches", () => {
  beforeEach(() => {
    vi.mocked(getUserCount).mockReset();
    vi.mocked(getJwtSecret).mockReset();
    vi.mocked(getJwtSecret).mockResolvedValue("secret");
  });

  test("an unreachable user table answers 503 rather than serving the route unauthenticated", async () => {
    // PI_SKIP_INIT is the E2E escape hatch, and it is what the existing suite
    // exercises. Unset, a transient DB failure must NOT fall open.
    const saved = process.env.PI_SKIP_INIT;
    delete process.env.PI_SKIP_INIT;
    try {
      vi.mocked(getUserCount).mockRejectedValue(new Error("DB down"));
      const { event } = makeEvent("/api/conversations");
      const resolve = vi.fn();
      const { response } = await run(event, resolve);

      expect(response?.status).toBe(503);
      expect(await response?.json()).toEqual({ error: "Service unavailable" });
      // The decisive part: the route never ran.
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      process.env.PI_SKIP_INIT = saved;
    }
  });

  test("a cookie the server cannot judge serves the request instead of bouncing the user", async () => {
    // getJwtSecret failing means the secret was never cached and the DB is
    // down: the cookie is neither valid nor invalid, so an infrastructure
    // blip must not log everybody out.
    vi.mocked(getJwtSecret).mockRejectedValue(new Error("secret unreachable"));
    const { event, cookies } = makeEvent("/projects/abc", { cookies: { ezcorp_session: "some-token" } });
    const served = new Response("ok", { status: 200 });
    const resolve = vi.fn(async () => served);

    const { response } = await run(event, resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(response?.status).toBe(200);
    // No principal was stamped, and no cookie was cleared.
    expect(event.locals.user).toBeUndefined();
    expect(cookies.delete).not.toHaveBeenCalled();
  });

  test("an adapter that cannot report a peer address still answers, failing loopback gating closed", async () => {
    // getClientAddress throws under the prerender path. Both call sites must
    // absorb it: leaving the address undefined makes internal-auth's loopback
    // check fail closed instead of throwing a 500 out of the hook.
    vi.mocked(getUserCount).mockResolvedValue(1);
    const { event } = makeEvent("/api/conversations", {
      clientAddress: () => { throw new Error("no peer under prerender"); },
      headers: { authorization: "Bearer ezk_nope" },
    });
    const resolve = vi.fn();

    const { response } = await run(event, resolve);
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: "Authentication required" });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("hooks.server.ts — transport security header", () => {
  beforeEach(() => {
    vi.mocked(getUserCount).mockReset();
    vi.mocked(getUserCount).mockResolvedValue(1);
  });

  test("an https request gets HSTS; the same public route over http does not", async () => {
    const secure = makeEvent("/api/health", { protocol: "https" });
    const secureResponse = (await run(secure.event, vi.fn(async () => new Response("ok")))).response;
    expect(secureResponse?.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");

    const plain = makeEvent("/api/health");
    const plainResponse = (await run(plain.event, vi.fn(async () => new Response("ok")))).response;
    expect(plainResponse?.headers.get("Strict-Transport-Security")).toBeNull();
    // The other defaults are unconditional, so the https case is the only difference.
    expect(plainResponse?.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
