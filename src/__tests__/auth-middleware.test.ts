import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mockDbConnection(); // Must be at module level BEFORE imports that use db

import { requireAuth, requireRole, checkRole, requireTeamRole } from "../auth/middleware";
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
