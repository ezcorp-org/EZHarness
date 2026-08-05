/**
 * `project_members` query layer, against a real PGlite that has run the
 * real `migrate()`.
 *
 * DB-backed rather than mocked on purpose: half of what this module relies
 * on is DDL — the `(project_id, user_id)` unique index that makes the upsert
 * an upsert, and the two CASCADE foreign keys. A mocked drizzle handle would
 * let every one of those assertions pass while the shipped migration was
 * wrong.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  getProjectMembership,
  listProjectIdsForUser,
  listProjectMembers,
  upsertProjectMember,
  removeProjectMember,
  countProjectMembers,
} = await import("../db/queries/project-members");
const { createProject, deleteProject } = await import("../db/queries/projects");
const { createUser } = await import("../db/queries/users");
const { rawQuery } = await import("../db/connection");

/** There is no `deleteUser` query helper, so the CASCADE test drops the row
 *  directly — the FK is the thing under test, not any query module. */
const deleteUserRow = (id: string) => rawQuery("DELETE FROM users WHERE id = $1", [id]);

let seq = 0;
const newUser = () =>
  createUser({ email: `u${++seq}@members.test`, passwordHash: "h", name: `U${seq}` });

describe("project_members queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("upsertProjectMember inserts a row with the role it was given", async () => {
    const u = await newUser();
    const p = await createProject({ name: "alpha", path: "/tmp/alpha" });
    const m = await upsertProjectMember(p.id, u.id, "owner");
    expect(m.projectId).toBe(p.id);
    expect(m.userId).toBe(u.id);
    expect(m.role).toBe("owner");
    expect(m.createdAt).toBeInstanceOf(Date);
  });

  test("a second upsert for the same pair UPDATES the role, never duplicates", async () => {
    // The property the unique index buys. Without it the "add Bob as an
    // owner" request would silently write a second row and every membership
    // read would become order-dependent.
    const u = await newUser();
    const p = await createProject({ name: "beta", path: "/tmp/beta" });
    await upsertProjectMember(p.id, u.id, "member");
    const promoted = await upsertProjectMember(p.id, u.id, "owner");
    expect(promoted.role).toBe("owner");
    expect(await countProjectMembers(p.id)).toBe(1);
    expect((await getProjectMembership(u.id, p.id))!.role).toBe("owner");
  });

  test("getProjectMembership returns undefined for a non-member", async () => {
    // `undefined` is the only "not a member" representation, which is what
    // lets `checkProjectRole` fail closed by construction.
    const u = await newUser();
    const p = await createProject({ name: "gamma", path: "/tmp/gamma" });
    expect(await getProjectMembership(u.id, p.id)).toBeUndefined();
  });

  test("getProjectMembership does not leak across projects or users", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const p1 = await createProject({ name: "p1", path: "/tmp/p1" });
    const p2 = await createProject({ name: "p2", path: "/tmp/p2" });
    await upsertProjectMember(p1.id, a.id, "owner");
    expect(await getProjectMembership(a.id, p1.id)).toBeDefined();
    expect(await getProjectMembership(a.id, p2.id)).toBeUndefined();
    expect(await getProjectMembership(b.id, p1.id)).toBeUndefined();
  });

  test("listProjectIdsForUser returns exactly that user's projects", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const p1 = await createProject({ name: "l1", path: "/tmp/l1" });
    const p2 = await createProject({ name: "l2", path: "/tmp/l2" });
    const p3 = await createProject({ name: "l3", path: "/tmp/l3" });
    await upsertProjectMember(p1.id, a.id, "owner");
    await upsertProjectMember(p2.id, a.id, "member");
    await upsertProjectMember(p3.id, b.id, "owner");

    expect((await listProjectIdsForUser(a.id)).sort()).toEqual([p1.id, p2.id].sort());
    expect(await listProjectIdsForUser(b.id)).toEqual([p3.id]);
  });

  test("listProjectIdsForUser is empty for a user with no memberships", async () => {
    const u = await newUser();
    expect(await listProjectIdsForUser(u.id)).toEqual([]);
  });

  test("listProjectMembers joins the user's name and email", async () => {
    const u = await newUser();
    const p = await createProject({ name: "listed", path: "/tmp/listed" });
    await upsertProjectMember(p.id, u.id, "owner");
    const rows = await listProjectMembers(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(u.id);
    expect(rows[0]!.userEmail).toBe(u.email);
    expect(rows[0]!.userName).toBe(u.name);
    expect(rows[0]!.role).toBe("owner");
  });

  test("listProjectMembers is empty for a project nobody joined", async () => {
    const p = await createProject({ name: "lonely", path: "/tmp/lonely" });
    expect(await listProjectMembers(p.id)).toEqual([]);
    expect(await countProjectMembers(p.id)).toBe(0);
  });

  test("removeProjectMember deletes the row; a second call is false", async () => {
    const u = await newUser();
    const p = await createProject({ name: "leaving", path: "/tmp/leaving" });
    await upsertProjectMember(p.id, u.id, "member");
    expect(await removeProjectMember(p.id, u.id)).toBe(true);
    expect(await getProjectMembership(u.id, p.id)).toBeUndefined();
    expect(await removeProjectMember(p.id, u.id)).toBe(false);
  });

  test("countProjectMembers counts only that project's rows", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const p1 = await createProject({ name: "c1", path: "/tmp/c1" });
    const p2 = await createProject({ name: "c2", path: "/tmp/c2" });
    await upsertProjectMember(p1.id, a.id, "owner");
    await upsertProjectMember(p1.id, b.id, "member");
    await upsertProjectMember(p2.id, a.id, "owner");
    expect(await countProjectMembers(p1.id)).toBe(2);
    expect(await countProjectMembers(p2.id)).toBe(1);
  });

  test("deleting the PROJECT cascades its membership rows away", async () => {
    // A membership row missing either end is not a weaker grant, it is a
    // meaningless one — so both FKs cascade rather than SET NULL.
    const u = await newUser();
    const p = await createProject({ name: "doomed", path: "/tmp/doomed" });
    await upsertProjectMember(p.id, u.id, "owner");
    expect(await deleteProject(p.id)).toBe(true);
    expect(await listProjectIdsForUser(u.id)).toEqual([]);
  });

  test("deleting the USER cascades their membership rows away", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const p = await createProject({ name: "survivor", path: "/tmp/survivor" });
    await upsertProjectMember(p.id, a.id, "owner");
    await upsertProjectMember(p.id, b.id, "member");
    await deleteUserRow(a.id);
    expect(await countProjectMembers(p.id)).toBe(1);
    expect((await listProjectMembers(p.id))[0]!.userId).toBe(b.id);
  });

  test("createProject stamps its creator as an owner when one is given", async () => {
    // The writer that makes the `owner` rung reachable on the ordinary path.
    const u = await newUser();
    const p = await createProject({ name: "mine", path: "/tmp/mine" }, u.id);
    expect((await getProjectMembership(u.id, p.id))!.role).toBe("owner");
  });

  test("createProject with no creator leaves the project memberless", async () => {
    // Safe rather than a hole: an ownerless project is still mutable through
    // the instance-admin override, and `migrate()`'s backfill attributes it
    // to the first admin on the next boot.
    const p = await createProject({ name: "orphan", path: "/tmp/orphan" });
    expect(await countProjectMembers(p.id)).toBe(0);
    const withNull = await createProject({ name: "orphan2", path: "/tmp/orphan2" }, null);
    expect(await countProjectMembers(withNull.id)).toBe(0);
  });
});
