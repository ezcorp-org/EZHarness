import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mockDbConnection(); // Must be at module level BEFORE imports that use db

import {
  requireAuth,
  requireRole,
  checkRole,
  requireAdminSession,
  requireSessionAuth,
  isInteractiveSession,
  requireTeamRole,
} from "../auth/middleware";
import { hasRequiredScope } from "../auth/api-key";
import { createUser } from "../db/queries/users";
import { createTeam, addTeamMember } from "../db/queries/teams";
import { users, teams, teamMembers } from "../db/schema";
import type { AuthUser } from "../auth/types";

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => { await closeTestDb(); });

function makeLocals(user?: AuthUser) {
  return { user } as App.Locals;
}

const adminUser: AuthUser = { id: "u-admin", email: "admin@test.com", name: "Admin", role: "admin" };
const memberUser: AuthUser = { id: "u-member", email: "member@test.com", name: "Member", role: "member" };

// ── requireAuth ─────────────────────────────────────────────────────

describe("requireAuth", () => {
  test("returns user when locals.user is set", () => {
    const result = requireAuth(makeLocals(adminUser));
    expect(result).toEqual(adminUser);
  });

  test("throws Response with status 401 when locals.user is undefined", () => {
    try {
      requireAuth(makeLocals(undefined));
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(401);
    }
  });
});

// ── requireRole ─────────────────────────────────────────────────────

describe("requireRole", () => {
  test("returns user when role matches", () => {
    const result = requireRole(makeLocals(adminUser), "admin");
    expect(result).toEqual(adminUser);
  });

  test("throws Response with status 403 when role does not match", () => {
    try {
      requireRole(makeLocals(memberUser), "admin");
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  test("throws 401 when no user at all", () => {
    try {
      requireRole(makeLocals(undefined), "admin");
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(401);
    }
  });
});

// ── requireSessionAuth (the consent-boundary gate, R-4) ─────────────
//
// One property per test, each killing a distinct mutation of the helper.
// The gate exists because `requireScope(locals,"chat")` — the thing the
// approval-answer route used to use — passes for an API key, which made a
// leaked `chat` key a consent-MINTING key.

describe("requireSessionAuth", () => {
  /** Locals as an auth site would leave them. `authMethod` is deliberately
   *  `string` so a test can pass a value that is not (yet) in `AuthMethod` —
   *  the "future auth mode nobody has thought of" case is the whole point of
   *  an allowlist and must be expressible. */
  function sessionLocals(user: AuthUser | undefined, authMethod?: string) {
    return { user, authMethod } as unknown as App.Locals;
  }

  test("returns the user for a cookie SESSION — the one allowed method", () => {
    const result = requireSessionAuth(sessionLocals(memberUser, "session"));
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toEqual(memberUser);
  });

  test("RETURNS a 403 for an `api-key` principal — the R-4 hole itself", () => {
    // A `chat`-scoped key reaches every other gate on this route. This is
    // the only one that stops it.
    const result = requireSessionAuth(sessionLocals(memberUser, "api-key"));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  test("RETURNS a 403 for an `internal` (bundled-extension) principal", () => {
    // Loopback and system-owned is not the same as human-and-present.
    const result = requireSessionAuth(sessionLocals(memberUser, "internal"));
    expect((result as Response).status).toBe(403);
  });

  test("RETURNS a 403 when the auth method was never stamped", () => {
    // Fail-closed on the UNKNOWN case. A denylist (`!== "api-key"`) would
    // ALLOW here, which is exactly how this gate would rot: the next auth
    // site to forget a stamp would silently inherit session authority.
    const result = requireSessionAuth(sessionLocals(memberUser));
    expect((result as Response).status).toBe(403);
  });

  test("RETURNS a 403 for an auth method that does not exist yet", () => {
    // The allowlist's reason for being: a value nobody has thought of is
    // refused by DEFAULT, without anyone remembering to deny it.
    const result = requireSessionAuth(sessionLocals(memberUser, "oauth-device-code"));
    expect((result as Response).status).toBe(403);
  });

  test("an ADMIN with an api-key is still refused — method beats role", () => {
    // Role is a different axis. `answerApproval`'s ownership branch
    // short-circuits on `isAdmin`, so an admin-role key that got past here
    // could clear any user's gate on any run.
    const result = requireSessionAuth(sessionLocals(adminUser, "api-key"));
    expect((result as Response).status).toBe(403);
  });

  test("a SESSION admin is allowed, so the refusal above is about the method", () => {
    // Control for the previous test: same user, same role, different method.
    expect(requireSessionAuth(sessionLocals(adminUser, "session"))).toEqual(adminUser);
  });

  test("RETURNS a 401 (not 403) when there is no principal at all", () => {
    // Distinct status: "log in" and "you may not do this" are different
    // instructions, and only the second implies the caller authenticated.
    const result = requireSessionAuth(sessionLocals(undefined, "session"));
    expect((result as Response).status).toBe(401);
  });

  test("the 401 body is byte-identical to requireAuth's", async () => {
    // So swapping `requireAuth` for this helper at a call site changes
    // nothing an unauthenticated client can observe except the 500→401 fix.
    const result = requireSessionAuth(sessionLocals(undefined)) as Response;
    expect(await result.json()).toEqual({ error: "Authentication required" });
  });

  test("the 403 body names the requirement", async () => {
    const result = requireSessionAuth(sessionLocals(memberUser, "api-key")) as Response;
    expect(await result.json()).toEqual({ error: "Interactive session required" });
  });

  test("NEVER throws — a thrown Response is a 500 from a +server.ts handler", () => {
    // The bug `checkRole`'s docblock exists to prevent. The route this gate
    // replaced called `requireAuth`, which throws: an unauthenticated
    // caller was told "server error" instead of "log in".
    expect(() => requireSessionAuth(sessionLocals(undefined))).not.toThrow();
    expect(() => requireSessionAuth(sessionLocals(memberUser, "api-key"))).not.toThrow();
  });

  test("api-key SCOPES are irrelevant — every scope set is still refused", () => {
    // Proves the gate is not secretly the scope check wearing a new name. A
    // key holding literally every scope is refused for the same reason a
    // read-only one is: it is not a person.
    for (const scopes of [[], ["read"], ["chat"], ["read", "chat", "extensions", "admin"]]) {
      const locals = {
        user: memberUser,
        authMethod: "api-key",
        apiKeyScopes: scopes,
      } as unknown as App.Locals;
      expect((requireSessionAuth(locals) as Response).status).toBe(403);
    }
  });

  test("a session with NO apiKeyScopes and one WITH them both resolve on method", () => {
    // The discriminator is `authMethod`, not `apiKeyScopes === undefined`.
    // An (impossible today) session that carried scopes must still pass, or
    // the implementation is sniffing the wrong field.
    const withScopes = {
      user: memberUser,
      authMethod: "session",
      apiKeyScopes: ["read"],
    } as unknown as App.Locals;
    expect(requireSessionAuth(withScopes)).toEqual(memberUser);
  });
});

// ── isInteractiveSession (the predicate half of the same allowlist) ──
//
// Two gates BRANCH on the answer rather than refusing outright — the
// permission-mode ceiling on the chat send body, and the consent-gate
// confinement on the tool-permission route. They must read the SAME
// allowlist, or the fail-closed reasoning above stops applying to them.

describe("isInteractiveSession", () => {
  test("true only for `session`", () => {
    expect(isInteractiveSession({ authMethod: "session" })).toBe(true);
  });

  test("false for every other stamped method, and for an unstamped request", () => {
    expect(isInteractiveSession({ authMethod: "api-key" })).toBe(false);
    expect(isInteractiveSession({ authMethod: "internal" })).toBe(false);
    expect(isInteractiveSession({})).toBe(false);
  });

  test("a method nobody has invented yet lands on the DENY side", () => {
    // The property that makes this an allowlist rather than a denylist: a
    // new `AuthMethod` is refused until someone deliberately adds it.
    const future = { authMethod: "oauth-device-code" } as unknown as { authMethod?: never };
    expect(isInteractiveSession(future)).toBe(false);
  });

  test("agrees with requireSessionAuth on every input — one allowlist, not two", () => {
    for (const authMethod of [undefined, "session", "api-key", "internal", "future"]) {
      const locals = { user: memberUser, authMethod } as unknown as App.Locals;
      const allowedByPredicate = isInteractiveSession(locals);
      const allowedByGate = !(requireSessionAuth(locals) instanceof Response);
      expect(allowedByPredicate).toBe(allowedByGate);
    }
  });
});

// ── checkRole (non-throwing sibling for +server.ts handlers) ─────────

describe("checkRole", () => {
  test("returns the user (not a Response) when role matches", () => {
    const result = checkRole(makeLocals(adminUser), "admin");
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toEqual(adminUser);
  });

  test("RETURNS a 403 Response when role does not match (does not throw)", () => {
    const result = checkRole(makeLocals(memberUser), "admin");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  test("RETURNS a 401 Response when there is no user (does not throw)", () => {
    const result = checkRole(makeLocals(undefined), "admin");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  test("re-throws a non-Response error unchanged", () => {
    // Passing a locals whose `user` getter throws a plain Error proves the
    // catch only swallows Responses — any other throw propagates.
    const boom = new Error("boom");
    const locals = { get user(): AuthUser { throw boom; } } as unknown as App.Locals;
    expect(() => checkRole(locals, "admin")).toThrow(boom);
  });

  // ── Second axis: SCOPE gating for API-key principals ──────────────
  // The role wall alone let an admin-role key minted with a narrow scope
  // (`ezcorp key mint --scopes read --role admin`) reach admin writes it was
  // never scoped for. checkRole now also requires the `admin` SCOPE — but only
  // for key-authed requests (cookie sessions carry no apiKeyScopes).

  test("admin role + API-key WITHOUT admin scope RETURNS a 403 (scope axis)", async () => {
    const locals = { user: adminUser, apiKeyScopes: ["read"] } as unknown as App.Locals;
    const result = checkRole(locals, "admin");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    const body = (await (result as Response).json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("admin");
  });

  test("admin role + API-key WITH admin scope returns the user (both axes pass)", () => {
    const locals = { user: adminUser, apiKeyScopes: ["read", "admin"] } as unknown as App.Locals;
    const result = checkRole(locals, "admin");
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toEqual(adminUser);
  });

  test("admin role + cookie session (no apiKeyScopes) is unaffected — returns the user", () => {
    // apiKeyScopes undefined => not scope-gated (role alone authorizes).
    const result = checkRole(makeLocals(adminUser), "admin");
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toEqual(adminUser);
  });

  test("member role + admin scope is still 403 (role axis holds independently)", () => {
    const locals = { user: memberUser, apiKeyScopes: ["admin"] } as unknown as App.Locals;
    const result = checkRole(locals, "admin");
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });
});

// ── requireAdminSession (both axes, one call) ────────────────────────
//
// The pair the C3 service-account routes carried a private copy of. It is
// worth its own tests rather than "it's just two calls" because the ORDER
// is load-bearing and because a composition can lose a half silently: a
// version that ran only `checkRole` would still look gated and would admit
// every admin-scoped API key.

describe("requireAdminSession", () => {
  function locals(user: AuthUser | undefined, authMethod?: string, apiKeyScopes?: string[]) {
    return { user, authMethod, apiKeyScopes } as unknown as App.Locals;
  }

  test("the legitimate caller — an admin AT A BROWSER — gets through", () => {
    // Paired with every refusal below, so a deny-everyone mutation cannot
    // pass this block.
    const result = requireAdminSession(locals(adminUser, "session"));
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toEqual(adminUser);
  });

  test("an admin-role API KEY WITH the admin scope is still refused (session axis)", async () => {
    // The half that a `checkRole`-only composition would lose. This caller
    // passes both of checkRole's axes and must still be refused.
    const result = requireAdminSession(locals(adminUser, "api-key", ["admin"])) as Response;
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(403);
    expect(((await result.json()) as { error: string }).error).toBe("Interactive session required");
  });

  test("a NON-admin session is refused (role axis)", async () => {
    // The half a `requireSessionAuth`-only composition would lose.
    const result = requireAdminSession(locals(memberUser, "session")) as Response;
    expect(result.status).toBe(403);
    expect(((await result.json()) as { error: string }).error).toBe("Insufficient permissions");
  });

  test("no principal at all is 401, not 403", async () => {
    const result = requireAdminSession(locals(undefined)) as Response;
    expect(result.status).toBe(401);
    expect(((await result.json()) as { error: string }).error).toBe("Authentication required");
  });

  test("SESSION runs FIRST: a non-admin key hears about the session, not the role", async () => {
    // The order, pinned. Reversed, this caller would be told "Insufficient
    // permissions" — which confirms the key's ROLE to someone who should not
    // have learned anything beyond "no key reaches this".
    const result = requireAdminSession(locals(memberUser, "api-key", ["read"])) as Response;
    expect(((await result.json()) as { error: string }).error).toBe("Interactive session required");
  });

  test("an UNSTAMPED principal is refused — the negative-inference killer", () => {
    // No `authMethod` and no `apiKeyScopes`: the inference
    // `apiKeyScopes === undefined` would read this as a session and ALLOW it.
    expect(requireAdminSession(locals(adminUser))).toBeInstanceOf(Response);
  });

  test("every denial is RETURNED, never thrown (a thrown Response is a 500)", () => {
    expect(() => requireAdminSession(locals(undefined))).not.toThrow();
    expect(() => requireAdminSession(locals(adminUser, "api-key", ["admin"]))).not.toThrow();
    expect(() => requireAdminSession(locals(memberUser, "session"))).not.toThrow();
  });
});

// ── hasRequiredScope (pure predicate shared by requireScope + checkRole) ──

describe("hasRequiredScope", () => {
  test("undefined scopes (cookie session) always satisfies — allow-all", () => {
    expect(hasRequiredScope(undefined, "admin")).toBe(true);
  });

  test("returns true when the required scope is present", () => {
    expect(hasRequiredScope(["read", "admin"], "admin")).toBe(true);
  });

  test("returns false when the required scope is absent", () => {
    expect(hasRequiredScope(["read"], "admin")).toBe(false);
  });
});

// ── requireTeamRole ─────────────────────────────────────────────────

describe("requireTeamRole", () => {
  let teamId: string;
  let dbUserId: string;
  let dbAdminId: string;

  beforeEach(async () => {
    await getTestDb().delete(teamMembers);
    await getTestDb().delete(teams);
    await getTestDb().delete(users);

    const dbUser = await createUser({ email: "member@test.com", passwordHash: "h", name: "Member" });
    dbUserId = dbUser.id;
    const dbAdmin = await createUser({ email: "admin@test.com", passwordHash: "h", name: "Admin", role: "admin" });
    dbAdminId = dbAdmin.id;

    const team = await createTeam("Test Team");
    teamId = team.id;
  });

  test("returns user when membership role >= minRole", async () => {
    await addTeamMember(teamId, dbUserId, "editor");
    const locals = makeLocals({ id: dbUserId, email: "member@test.com", name: "Member", role: "member" });
    const result = await requireTeamRole(locals, teamId, "viewer");
    expect(result.id).toBe(dbUserId);
  });

  test("returns user when membership role equals minRole", async () => {
    await addTeamMember(teamId, dbUserId, "editor");
    const locals = makeLocals({ id: dbUserId, email: "member@test.com", name: "Member", role: "member" });
    const result = await requireTeamRole(locals, teamId, "editor");
    expect(result.id).toBe(dbUserId);
  });

  test("throws 403 when membership role < minRole", async () => {
    await addTeamMember(teamId, dbUserId, "viewer");
    const locals = makeLocals({ id: dbUserId, email: "member@test.com", name: "Member", role: "member" });
    try {
      await requireTeamRole(locals, teamId, "owner");
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  test("instance admin bypasses team role check", async () => {
    // Admin user has no team membership at all, but should still pass
    const locals = makeLocals({ id: dbAdminId, email: "admin@test.com", name: "Admin", role: "admin" });
    const result = await requireTeamRole(locals, teamId, "owner");
    expect(result.id).toBe(dbAdminId);
  });

  test("throws 403 when user has no membership at all", async () => {
    const locals = makeLocals({ id: dbUserId, email: "member@test.com", name: "Member", role: "member" });
    try {
      await requireTeamRole(locals, teamId, "viewer");
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });
});
