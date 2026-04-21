import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { requireAuth, requireRole, requireTeamRole } from "../auth/middleware";
import { createUser } from "../db/queries/users";
import { createTeam, addTeamMember } from "../db/queries/teams";

let adminUser: { id: string; email: string; name: string; role: "admin" | "member" };
let memberUser: { id: string; email: string; name: string; role: "admin" | "member" };
let editorUser: { id: string; email: string; name: string; role: "admin" | "member" };
let viewerUser: { id: string; email: string; name: string; role: "admin" | "member" };
let teamId: string;

function makeLocals(user: { id: string; email: string; name: string; role: "admin" | "member" } | null) {
  return { user } as App.Locals;
}

beforeAll(async () => {
  await setupTestDb();

  const admin = await createUser({ email: "admin@test.com", passwordHash: "hash", name: "Admin", role: "admin" });
  adminUser = { id: admin.id, email: admin.email, name: admin.name, role: admin.role };

  const member = await createUser({ email: "member@test.com", passwordHash: "hash", name: "Member", role: "member" });
  memberUser = { id: member.id, email: member.email, name: member.name, role: member.role };

  const editor = await createUser({ email: "editor@test.com", passwordHash: "hash", name: "Editor", role: "member" });
  editorUser = { id: editor.id, email: editor.email, name: editor.name, role: editor.role };

  const viewer = await createUser({ email: "viewer@test.com", passwordHash: "hash", name: "Viewer", role: "member" });
  viewerUser = { id: viewer.id, email: viewer.email, name: viewer.name, role: viewer.role };

  const team = await createTeam("RBAC Test Team");
  teamId = team.id;

  // adminUser is instance admin — no membership needed (bypasses check)
  await addTeamMember(teamId, memberUser.id, "owner");
  await addTeamMember(teamId, editorUser.id, "editor");
  await addTeamMember(teamId, viewerUser.id, "viewer");
});

afterAll(async () => { await closeTestDb(); });

describe("RBAC Enforcement", () => {
  describe("requireAuth", () => {
    test("returns user when authenticated", () => {
      const result = requireAuth(makeLocals(adminUser));
      expect(result.id).toBe(adminUser.id);
    });

    test("throws 401 when no user in locals", () => {
      try {
        requireAuth(makeLocals(null));
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(401);
      }
    });
  });

  describe("Instance roles", () => {
    test("admin can call requireRole('admin') without error", () => {
      const result = requireRole(makeLocals(adminUser), "admin");
      expect(result.id).toBe(adminUser.id);
    });

    test("member calling requireRole('admin') throws 403", () => {
      try {
        requireRole(makeLocals(memberUser), "admin");
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(403);
      }
    });
  });

  describe("Team roles", () => {
    test("owner passes owner check", async () => {
      const result = await requireTeamRole(makeLocals(memberUser), teamId, "owner");
      expect(result.id).toBe(memberUser.id);
    });

    test("owner passes editor check (higher role passes lower)", async () => {
      const result = await requireTeamRole(makeLocals(memberUser), teamId, "editor");
      expect(result.id).toBe(memberUser.id);
    });

    test("owner passes viewer check (higher role passes lower)", async () => {
      const result = await requireTeamRole(makeLocals(memberUser), teamId, "viewer");
      expect(result.id).toBe(memberUser.id);
    });

    test("editor passes editor check", async () => {
      const result = await requireTeamRole(makeLocals(editorUser), teamId, "editor");
      expect(result.id).toBe(editorUser.id);
    });

    test("editor passes viewer check (higher role passes lower)", async () => {
      const result = await requireTeamRole(makeLocals(editorUser), teamId, "viewer");
      expect(result.id).toBe(editorUser.id);
    });

    test("editor fails owner check (throws 403)", async () => {
      try {
        await requireTeamRole(makeLocals(editorUser), teamId, "owner");
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(403);
      }
    });

    test("viewer fails editor check (throws 403)", async () => {
      try {
        await requireTeamRole(makeLocals(viewerUser), teamId, "editor");
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(403);
      }
    });

    test("viewer fails owner check (throws 403)", async () => {
      try {
        await requireTeamRole(makeLocals(viewerUser), teamId, "owner");
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(403);
      }
    });

    test("instance admin bypasses team role check entirely (no membership needed)", async () => {
      const result = await requireTeamRole(makeLocals(adminUser), teamId, "owner");
      expect(result.id).toBe(adminUser.id);
    });

    test("user with no team membership throws 403", async () => {
      const outsider = await createUser({ email: "outsider@test.com", passwordHash: "hash", name: "Outsider", role: "member" });
      const outsiderAuth = { id: outsider.id, email: outsider.email, name: outsider.name, role: outsider.role } as const;
      try {
        await requireTeamRole(makeLocals(outsiderAuth), teamId, "viewer");
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(403);
      }
    });
  });
});
