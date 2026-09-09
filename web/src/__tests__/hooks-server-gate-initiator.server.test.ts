/**
 * `hooks.server.ts` is the ONE writer of the ambient gate initiator (PR-11).
 *
 * Every permission gate a route raises is created inside the async subtree of
 * the post-auth `resolve(event)` — including gates opened many awaits deep
 * inside a `streamChat` promise the route deliberately never awaits. Recording
 * the principal here, rather than at each `executor.streamChat(...)` call
 * site, is what makes a route that has not heard of consent confinement
 * attributed anyway; there are three such call sites today and a fourth would
 * otherwise ship unattributed and silently fail-closed.
 *
 * These tests use the REAL permissions module and the REAL `principalId`, and
 * read the initiator back off an actual gate — a spy on `runWithGateInitiator`
 * would pass even if the store never reached a gate, which is the only thing
 * that matters.
 */

process.env.PI_SKIP_INIT = "1";
process.env.JWT_SECRET = "test-secret-with-32-chars-minimum-12345";

import { test, expect, describe, beforeEach, vi } from "vitest";

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
vi.mock("$server/db/queries/sessions", () => ({
  hashToken: vi.fn(async () => "hash"),
  lookupSessionByTokenHash: vi.fn(async () => ({
    session: { id: "sess-1", userId: "u-1" },
    viaPrevious: false,
  })),
  touchSession: vi.fn(async () => {}),
  rotateSessionToken: vi.fn(async () => null),
}));
vi.mock("$server/auth/jwt", () => ({
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
vi.mock("$server/dev-git-info", () => ({
  devPageTransform: vi.fn(() => undefined),
}));

// Stamps whatever the current test asked for, standing in for the real
// bearer router (whose own stamping is pinned in security/bearer-auth.test.ts).
let bearerStamp: Record<string, unknown> | null = null;
vi.mock("$lib/server/security/bearer-auth", () => ({
  attachBearerAuth: vi.fn(async (event: { locals: Record<string, unknown> }) => {
    if (!bearerStamp) return false;
    Object.assign(event.locals, bearerStamp);
    return true;
  }),
}));

import { getUserById, getUserCount } from "$server/db/queries/users";
import {
  createPermissionGate,
  getPendingApprovalInitiator,
  resolvePermission,
} from "$server/runtime/tools/permissions";
const { handle } = await import("../hooks.server");

const ONBOARDED = {
  id: "u-1",
  email: "u@test.com",
  name: "U",
  role: "member" as const,
  status: "active" as const,
  passwordHash: "x",
  createdAt: new Date(),
  onboardedAt: new Date(),
};

function makeEvent(opts: { cookie?: boolean; bearer?: boolean }) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = "ezcorp_session=valid-jwt-token";
  if (opts.bearer) headers.authorization = "Bearer ezk_x";
  const url = "http://localhost/api/conversations/c1/messages";
  return {
    request: new Request(url, { method: "GET", headers }),
    url: new URL(url),
    cookies: {
      get: vi.fn((name: string) =>
        opts.cookie && name === "ezcorp_session" ? "valid-jwt-token" : undefined,
      ),
      set: vi.fn(),
      delete: vi.fn(),
    },
    locals: {},
    getClientAddress: () => "127.0.0.1",
    route: { id: "/api/conversations/[id]/messages" },
    params: {},
    setHeaders: vi.fn(),
    fetch: vi.fn(),
    isDataRequest: false,
    isSubRequest: false,
  } as any;
}

/**
 * Drive one request whose handler opens a gate the way a run does — after an
 * await, and WITHOUT the caller awaiting the work that opens it. Returns the
 * initiator the gate recorded.
 */
async function initiatorSeenByAGateRaisedDuring(
  event: any,
  toolCallId: string,
): Promise<string | undefined> {
  let detached: Promise<void> | undefined;
  const resolve = vi.fn(async () => {
    // Exactly the route's shape: start the work, do NOT await it, return.
    detached = (async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      createPermissionGate(toolCallId, "conv-1").catch(() => {});
    })();
    return new Response("ok", { status: 200 });
  });

  await handle({ event, resolve });
  await detached;
  const initiator = getPendingApprovalInitiator(toolCallId);
  resolvePermission(toolCallId, false);
  return initiator;
}

describe("hooks.server.ts — ambient gate initiator", () => {
  beforeEach(() => {
    bearerStamp = null;
    vi.mocked(getUserById).mockReset();
    vi.mocked(getUserById).mockResolvedValue(ONBOARDED as never);
    vi.mocked(getUserCount).mockResolvedValue(1);
  });

  test("public and authenticated handlers cannot read chunked or undersized-header bodies over their route cap", async () => {
    for (const pathname of ["/api/auth/setup", "/api/settings/developer"]) {
      for (const length of [undefined, "1"]) {
        const event = makeEvent({ cookie: true });
        event.url = new URL(`http://localhost${pathname}`);
        event.request = new Request(event.url, { method: "POST", headers: { cookie: "ezcorp_session=valid-jwt-token", ...(length ? { "content-length": length } : {}) }, body: new Uint8Array(1024 * 1024 + 1) });
        const resolve = vi.fn(async () => new Response("must not run"));
        expect((await handle({ event, resolve })).status).toBe(413);
        expect(resolve).not.toHaveBeenCalled();
      }
    }
  });

  test("unauthenticated and unscoped control requests are denied before body allocation", async () => {
    for (const authenticated of [false, true]) {
      bearerStamp = authenticated ? { user: { id: "u-1", role: "member" }, apiKeyScopes: ["read"], authMethod: "api-key", apiKeyId: "restricted" } : null;
      const event = makeEvent({ bearer: authenticated });
      event.url = new URL("http://localhost/api/extensions/control");
      event.request = new Request(event.url, { method: "POST", headers: authenticated ? { authorization: "Bearer ezk_x" } : {}, body: "{}" });
      const read = vi.spyOn(event.request.body!, "getReader");
      const resolve = vi.fn(async () => new Response("must not run"));
      expect((await handle({ event, resolve })).status).toBe(authenticated ? 403 : 401);
      expect(read).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  test("a cookie session stamps session:<userId> onto gates its request raises", async () => {
    const initiator = await initiatorSeenByAGateRaisedDuring(
      makeEvent({ cookie: true }),
      "tc-hooks-session",
    );
    expect(initiator).toBe("session:u-1");
  });

  test("an API key stamps api-key:<keyId>, not its owner's user id", async () => {
    // The distinction the whole confinement rests on: this must NOT equal
    // the session id above, even though both principals are user `u-1`.
    bearerStamp = {
      user: { id: "u-1", email: "", name: "K", role: "member" },
      apiKeyScopes: ["chat"],
      authMethod: "api-key",
      apiKeyId: "key-7",
    };
    const initiator = await initiatorSeenByAGateRaisedDuring(
      makeEvent({ bearer: true }),
      "tc-hooks-key",
    );
    expect(initiator).toBe("api-key:key-7");
    expect(initiator).not.toBe("session:u-1");
  });

  test("two different keys of the same user produce different initiators", async () => {
    bearerStamp = {
      user: { id: "u-1", email: "", name: "K", role: "member" },
      apiKeyScopes: ["chat"],
      authMethod: "api-key",
      apiKeyId: "key-8",
    };
    const initiator = await initiatorSeenByAGateRaisedDuring(
      makeEvent({ bearer: true }),
      "tc-hooks-key-2",
    );
    expect(initiator).toBe("api-key:key-8");
  });

  test("the scope does not leak past the request — a gate raised afterwards is unattributed", async () => {
    await initiatorSeenByAGateRaisedDuring(makeEvent({ cookie: true }), "tc-hooks-scoped");
    createPermissionGate("tc-hooks-after", "conv-1").catch(() => {});
    expect(getPendingApprovalInitiator("tc-hooks-after")).toBeUndefined();
    resolvePermission("tc-hooks-after", false);
  });
});
