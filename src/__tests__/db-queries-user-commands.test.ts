import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  createUserCommand,
  getUserCommand,
  listUserCommands,
  updateUserCommand,
  deleteUserCommand,
} = await import("../db/queries/user-commands");
const { createUser } = await import("../db/queries/users");

describe("user-commands queries", () => {
  let userId: string;
  let otherUserId: string;

  beforeEach(async () => {
    await setupTestDb();
    const u = await createUser({ email: "uc@test.com", passwordHash: "h", name: "UC" });
    userId = u.id;
    const o = await createUser({ email: "uc2@test.com", passwordHash: "h", name: "UC2" });
    otherUserId = o.id;
  });
  afterAll(async () => await closeTestDb());

  test("createUserCommand inserts with defaults", async () => {
    const cmd = await createUserCommand({
      userId,
      name: "summarize",
      body: "Summarize the thing",
    });
    expect(cmd.id).toBeDefined();
    expect(cmd.userId).toBe(userId);
    expect(cmd.name).toBe("summarize");
    expect(cmd.body).toBe("Summarize the thing");
    expect(cmd.description).toBe("");
    expect(cmd.frontmatter).toEqual({});
    expect(cmd.createdAt).toBeInstanceOf(Date);
  });

  test("createUserCommand stores description and frontmatter", async () => {
    const cmd = await createUserCommand({
      userId,
      name: "review",
      body: "review body",
      description: "code review",
      frontmatter: { tone: "strict" },
    });
    expect(cmd.description).toBe("code review");
    expect(cmd.frontmatter).toEqual({ tone: "strict" });
  });

  test("getUserCommand returns row scoped by user+name", async () => {
    await createUserCommand({ userId, name: "g1", body: "a" });
    const got = await getUserCommand(userId, "g1");
    expect(got).toBeDefined();
    expect(got!.body).toBe("a");
    expect(await getUserCommand(userId, "missing")).toBeUndefined();
    // same name under another user is isolated
    expect(await getUserCommand(otherUserId, "g1")).toBeUndefined();
  });

  test("listUserCommands returns only the calling user's commands", async () => {
    await createUserCommand({ userId, name: "u-a", body: "x" });
    await createUserCommand({ userId, name: "u-b", body: "y" });
    await createUserCommand({ userId: otherUserId, name: "u-a", body: "z" });

    const list = await listUserCommands(userId);
    expect(list.length).toBe(2);
    expect(list.map((c) => c.name).sort()).toEqual(["u-a", "u-b"]);
  });

  test("updateUserCommand patches and bumps updatedAt", async () => {
    const cmd = await createUserCommand({ userId, name: "up", body: "old" });
    const originalTs = cmd.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 5));

    const updated = await updateUserCommand(userId, "up", {
      body: "new",
      description: "new desc",
      frontmatter: { k: "v" },
    });
    expect(updated).toBeDefined();
    expect(updated!.body).toBe("new");
    expect(updated!.description).toBe("new desc");
    expect(updated!.frontmatter).toEqual({ k: "v" });
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(originalTs);
  });

  test("updateUserCommand returns undefined when row missing", async () => {
    const result = await updateUserCommand(userId, "nope", { body: "x" });
    expect(result).toBeUndefined();
  });

  test("deleteUserCommand removes the row, false on second call", async () => {
    await createUserCommand({ userId, name: "del", body: "x" });
    expect(await deleteUserCommand(userId, "del")).toBe(true);
    expect(await getUserCommand(userId, "del")).toBeUndefined();
    expect(await deleteUserCommand(userId, "del")).toBe(false);
  });

  test("createUserCommand auto-suffixes on collision (review → review-2 → review-3)", async () => {
    const a = await createUserCommand({ userId, name: "review", body: "a" });
    const b = await createUserCommand({ userId, name: "review", body: "b" });
    const c = await createUserCommand({ userId, name: "review", body: "c" });
    expect(a.name).toBe("review");
    expect(b.name).toBe("review-2");
    expect(c.name).toBe("review-3");
    // Each row distinct, all persisted, no constraint violation thrown.
    const list = await listUserCommands(userId);
    expect(list.map((c) => c.name).sort()).toEqual(["review", "review-2", "review-3"]);
  });

  test("createUserCommand auto-suffix respects gaps (a + a-3 → next is a-2)", async () => {
    await createUserCommand({ userId, name: "a", body: "x" });
    // Manually create an `a-3` to leave the `a-2` slot open.
    await createUserCommand({ userId, name: "a-3", body: "y" });
    const c = await createUserCommand({ userId, name: "a", body: "z" });
    expect(c.name).toBe("a-2");
  });

  test("auto-suffix is per-user (other users keep their own namespace)", async () => {
    await createUserCommand({ userId, name: "share", body: "u1" });
    // Other user can still take the unsuffixed name.
    const otherUserCmd = await createUserCommand({
      userId: otherUserId,
      name: "share",
      body: "u2",
    });
    expect(otherUserCmd.name).toBe("share");
  });

  test("updateUserCommand can rename via patch.name with auto-suffix on collision", async () => {
    await createUserCommand({ userId, name: "a", body: "x" });
    await createUserCommand({ userId, name: "b", body: "y" });

    // Rename `a` → free name `c` keeps the requested name.
    const renamed = await updateUserCommand(userId, "a", { name: "c" });
    expect(renamed?.name).toBe("c");
    expect(await getUserCommand(userId, "a")).toBeUndefined();

    // Renaming `c` → `b` (taken) auto-suffixes to `b-2`.
    const collided = await updateUserCommand(userId, "c", { name: "b" });
    expect(collided?.name).toBe("b-2");
    expect(await getUserCommand(userId, "b")).toBeDefined();
    expect(await getUserCommand(userId, "b-2")).toBeDefined();
  });

  test("updateUserCommand with patch.name === current name is a no-op rename", async () => {
    await createUserCommand({ userId, name: "keep", body: "x" });
    const r = await updateUserCommand(userId, "keep", {
      name: "keep",
      body: "new",
    });
    expect(r?.name).toBe("keep");
    expect(r?.body).toBe("new");
  });
});
