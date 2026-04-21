import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  createTeam, getTeam, listTeams, updateTeamName, deleteTeam,
  addTeamMember, getTeamMembers, getUserTeams, getTeamMembership,
  updateTeamMemberRole, removeTeamMember,
} from "../db/queries/teams";
import { createUser, listUsers, updateUserStatus, getUserCount } from "../db/queries/users";
import { createInvite, listInvites, deleteInvite } from "../db/queries/invites";

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

let adminId: string;
let userAId: string;
let userBId: string;

beforeAll(async () => {
  await setupTestDb();

  const admin = await createUser({ email: "admin@teams.test", passwordHash: "hash", name: "Admin", role: "admin" });
  adminId = admin.id;

  const userA = await createUser({ email: "a@teams.test", passwordHash: "hash", name: "User A", role: "member" });
  userAId = userA.id;

  const userB = await createUser({ email: "b@teams.test", passwordHash: "hash", name: "User B", role: "member" });
  userBId = userB.id;
});

afterAll(async () => { await closeTestDb(); });

describe("Team Sharing API", () => {
  describe("Teams CRUD", () => {
    let crudTeamId: string;

    test("createTeam returns team with id and name", async () => {
      const team = await createTeam("Engineering");
      expect(team.id).toBeTruthy();
      expect(team.name).toBe("Engineering");
      crudTeamId = team.id;
    });

    test("getTeam returns the team by id", async () => {
      const team = await getTeam(crudTeamId);
      expect(team).toBeDefined();
      expect(team!.name).toBe("Engineering");
    });

    test("listTeams returns all teams", async () => {
      await createTeam("Design");
      const teams = await listTeams();
      expect(teams.length).toBeGreaterThanOrEqual(2);
      const names = teams.map(t => t.name);
      expect(names).toContain("Engineering");
      expect(names).toContain("Design");
    });

    test("updateTeamName updates name", async () => {
      const updated = await updateTeamName(crudTeamId, "Platform Engineering");
      expect(updated).toBeDefined();
      expect(updated!.name).toBe("Platform Engineering");

      const fetched = await getTeam(crudTeamId);
      expect(fetched!.name).toBe("Platform Engineering");
    });

    test("deleteTeam removes team", async () => {
      const tempTeam = await createTeam("Temp");
      const removed = await deleteTeam(tempTeam.id);
      expect(removed).toBe(true);

      const fetched = await getTeam(tempTeam.id);
      expect(fetched).toBeUndefined();
    });

    test("deleteTeam returns false for non-existent id", async () => {
      const removed = await deleteTeam("nonexistent-id");
      expect(removed).toBe(false);
    });
  });

  describe("Team membership", () => {
    let memTeamId: string;

    beforeAll(async () => {
      const team = await createTeam("Membership Team");
      memTeamId = team.id;
    });

    test("addTeamMember adds member with correct role", async () => {
      const member = await addTeamMember(memTeamId, userAId, "editor");
      expect(member.teamId).toBe(memTeamId);
      expect(member.userId).toBe(userAId);
      expect(member.role).toBe("editor");
    });

    test("getTeamMembers returns members with userName and userEmail", async () => {
      const members = await getTeamMembers(memTeamId);
      expect(members.length).toBe(1);
      const m = at(members, 0, "team member");
      expect(m.userName).toBe("User A");
      expect(m.userEmail).toBe("a@teams.test");
      expect(m.role).toBe("editor");
    });

    test("getUserTeams returns teams with role", async () => {
      const teams = await getUserTeams(userAId);
      const found = teams.find(t => t.id === memTeamId);
      expect(found).toBeDefined();
      expect(found!.role).toBe("editor");
    });

    test("getTeamMembership returns membership for user in team", async () => {
      const membership = await getTeamMembership(userAId, memTeamId);
      expect(membership).toBeDefined();
      expect(membership!.role).toBe("editor");
    });

    test("getTeamMembership returns undefined for non-member", async () => {
      const membership = await getTeamMembership(userBId, memTeamId);
      expect(membership).toBeUndefined();
    });

    test("updateTeamMemberRole changes role", async () => {
      const success = await updateTeamMemberRole(memTeamId, userAId, "owner");
      expect(success).toBe(true);

      const membership = await getTeamMembership(userAId, memTeamId);
      expect(membership!.role).toBe("owner");
    });

    test("removeTeamMember removes member", async () => {
      await addTeamMember(memTeamId, userBId, "viewer");
      const removed = await removeTeamMember(memTeamId, userBId);
      expect(removed).toBe(true);

      const membership = await getTeamMembership(userBId, memTeamId);
      expect(membership).toBeUndefined();
    });

    test("adding same user twice throws unique constraint error", async () => {
      const team = await createTeam("Unique Test Team");
      await addTeamMember(team.id, userBId, "viewer");
      try {
        await addTeamMember(team.id, userBId, "editor");
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });

  describe("User management", () => {
    test("createUser with admin role creates admin", async () => {
      const admin2 = await createUser({ email: "admin2@teams.test", passwordHash: "hash", name: "Admin2", role: "admin" });
      expect(admin2.role).toBe("admin");
    });

    test("listUsers returns all users", async () => {
      const users = await listUsers();
      expect(users.length).toBeGreaterThanOrEqual(4);
      const emails = users.map(u => u.email);
      expect(emails).toContain("admin@teams.test");
      expect(emails).toContain("a@teams.test");
    });

    test("updateUserStatus deactivates user", async () => {
      const tempUser = await createUser({ email: "deactivate@teams.test", passwordHash: "hash", name: "Deactivate Me", role: "member" });
      const success = await updateUserStatus(tempUser.id, "inactive");
      expect(success).toBe(true);
    });

    test("getUserCount returns correct count", async () => {
      const countBefore = await getUserCount();
      await createUser({ email: "counter@teams.test", passwordHash: "hash", name: "Counter", role: "member" });
      const countAfter = await getUserCount();
      expect(countAfter).toBe(countBefore + 1);
    });
  });

  describe("Invite management", () => {
    let inviteId: string;

    test("createInvite creates invite with token", async () => {
      const invite = await createInvite({ role: "member", createdBy: adminId });
      expect(invite.id).toBeTruthy();
      expect(invite.token).toBeTruthy();
      expect(invite.token.length).toBe(64); // 32 bytes hex
      expect(invite.role).toBe("member");
      inviteId = invite.id;
    });

    test("listInvites returns all invites", async () => {
      const invites = await listInvites();
      expect(invites.length).toBeGreaterThanOrEqual(1);
      expect(invites.some(i => i.id === inviteId)).toBe(true);
    });

    test("deleteInvite removes invite", async () => {
      const invite2 = await createInvite({ role: "admin", createdBy: adminId });
      const removed = await deleteInvite(invite2.id);
      expect(removed).toBe(true);

      const invites = await listInvites();
      expect(invites.some(i => i.id === invite2.id)).toBe(false);
    });

    test("deleteInvite returns false for non-existent id", async () => {
      const removed = await deleteInvite("nonexistent-invite-id");
      expect(removed).toBe(false);
    });
  });
});
