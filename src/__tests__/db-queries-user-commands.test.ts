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
});
