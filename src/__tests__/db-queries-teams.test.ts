import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  createTeam,
  getTeam,
  listTeams,
  updateTeamName,
  deleteTeam,
  addTeamMember,
  removeTeamMember,
  updateTeamMemberRole,
  getTeamMembers,
  getUserTeams,
  getTeamMembership,
} = await import("../db/queries/teams");
const { createUser } = await import("../db/queries/users");

describe("teams queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("createTeam inserts and returns row", async () => {
    const t = await createTeam("eng");
    expect(t.id).toBeDefined();
    expect(t.name).toBe("eng");
    expect(t.createdAt).toBeInstanceOf(Date);
  });

  test("getTeam returns row by id, undefined when missing", async () => {
    const t = await createTeam("ops");
    const fetched = await getTeam(t.id);
    expect(fetched!.name).toBe("ops");
    expect(await getTeam(crypto.randomUUID())).toBeUndefined();
  });

  test("listTeams returns all teams", async () => {
    await createTeam("t1");
    await createTeam("t2");
    const all = await listTeams();
    expect(all.length).toBe(2);
    expect(all.map((r) => r.name).sort()).toEqual(["t1", "t2"]);
  });

  test("updateTeamName changes name", async () => {
    const t = await createTeam("old-name");
    const updated = await updateTeamName(t.id, "new-name");
    expect(updated!.name).toBe("new-name");
    expect((await getTeam(t.id))!.name).toBe("new-name");
  });

  test("updateTeamName returns undefined for missing id", async () => {
    expect(await updateTeamName(crypto.randomUUID(), "x")).toBeUndefined();
  });

  test("deleteTeam removes row, second call returns false", async () => {
    const t = await createTeam("doomed");
    expect(await deleteTeam(t.id)).toBe(true);
    expect(await getTeam(t.id)).toBeUndefined();
    expect(await deleteTeam(t.id)).toBe(false);
  });

  test("addTeamMember inserts membership row", async () => {
    const u = await createUser({ email: "a@t.com", passwordHash: "h", name: "A" });
    const t = await createTeam("members-team");
    const m = await addTeamMember(t.id, u.id, "owner");
    expect(m.teamId).toBe(t.id);
    expect(m.userId).toBe(u.id);
    expect(m.role).toBe("owner");
  });

  test("getTeamMembers returns members with user details", async () => {
    const u1 = await createUser({ email: "u1@t.com", passwordHash: "h", name: "User One" });
    const u2 = await createUser({ email: "u2@t.com", passwordHash: "h", name: "User Two" });
    const t = await createTeam("hydra");
    await addTeamMember(t.id, u1.id, "owner");
    await addTeamMember(t.id, u2.id, "viewer");

    const members = await getTeamMembers(t.id);
    expect(members.length).toBe(2);
    const byUserId = Object.fromEntries(members.map((m) => [m.userId, m]));
    expect(byUserId[u1.id]!.userName).toBe("User One");
    expect(byUserId[u1.id]!.role).toBe("owner");
    expect(byUserId[u2.id]!.userEmail).toBe("u2@t.com");
    expect(byUserId[u2.id]!.role).toBe("viewer");
  });

  test("getTeamMembers returns empty for team with no members", async () => {
    const t = await createTeam("lonely");
    expect(await getTeamMembers(t.id)).toEqual([]);
  });

  test("updateTeamMemberRole changes role, returns false for missing", async () => {
    const u = await createUser({ email: "r@t.com", passwordHash: "h", name: "R" });
    const t = await createTeam("role-team");
    await addTeamMember(t.id, u.id, "viewer");

    expect(await updateTeamMemberRole(t.id, u.id, "editor")).toBe(true);
    const membership = await getTeamMembership(u.id, t.id);
    expect(membership!.role).toBe("editor");

    expect(await updateTeamMemberRole(t.id, crypto.randomUUID(), "owner")).toBe(false);
  });

  test("removeTeamMember deletes row, returns false on missing", async () => {
    const u = await createUser({ email: "rm@t.com", passwordHash: "h", name: "Rm" });
    const t = await createTeam("rm-team");
    await addTeamMember(t.id, u.id, "owner");

    expect(await removeTeamMember(t.id, u.id)).toBe(true);
    expect(await getTeamMembership(u.id, t.id)).toBeUndefined();
    expect(await removeTeamMember(t.id, u.id)).toBe(false);
  });

  test("getUserTeams returns teams with role for a user", async () => {
    const u = await createUser({ email: "ut@t.com", passwordHash: "h", name: "UT" });
    const t1 = await createTeam("alpha-team");
    const t2 = await createTeam("beta-team");
    await addTeamMember(t1.id, u.id, "editor");
    await addTeamMember(t2.id, u.id, "viewer");

    const teams = await getUserTeams(u.id);
    expect(teams.length).toBe(2);
    const byName = Object.fromEntries(teams.map((t) => [t.name, t]));
    expect(byName["alpha-team"]!.role).toBe("editor");
    expect(byName["beta-team"]!.role).toBe("viewer");
  });

  test("getUserTeams returns empty for user with no memberships", async () => {
    const u = await createUser({ email: "lone@t.com", passwordHash: "h", name: "Lone" });
    expect(await getUserTeams(u.id)).toEqual([]);
  });

  test("getTeamMembership returns membership row, undefined when missing", async () => {
    const u = await createUser({ email: "mem@t.com", passwordHash: "h", name: "Mem" });
    const t = await createTeam("memship");
    await addTeamMember(t.id, u.id, "owner");

    const m = await getTeamMembership(u.id, t.id);
    expect(m!.role).toBe("owner");
    expect(await getTeamMembership(crypto.randomUUID(), t.id)).toBeUndefined();
  });
});
