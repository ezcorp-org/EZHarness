/**
 * query-aux (db-audit): getUserCount must answer via a SQL `count(*)`
 * aggregate, not by materializing every `users` row (password hashes and
 * all) just to read `.length`. It is the first-run gate on a request-level
 * hot path (hooks.server.ts on every unauthenticated request).
 *
 * We assert the OBSERVABLE contract that only the aggregate shape can keep
 * honest: an exact count that excludes synthetic `sys-*` users, returned as a
 * real number (the `count(*)::int` cast — a regression to a bigint/string
 * would fail the strict `toBe`).
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "../../../__tests__/helpers/test-pglite";

mockDbConnection();

const { getUserCount } = await import("../users");

async function seedUser(id: string): Promise<void> {
  await getTestDb().insert((await import("../../schema")).users).values({
    id,
    email: `${id}@test.com`,
    passwordHash: "secret-hash",
    name: id,
    role: "member",
  });
}

describe("getUserCount — aggregate, sys-user-excluding", () => {
  beforeEach(async () => { await setupTestDb(); });
  afterAll(async () => { await closeTestDb(); });

  test("returns 0 on an empty users table", async () => {
    const n = await getUserCount();
    expect(n).toBe(0);
    expect(typeof n).toBe("number");
  });

  test("counts only real users and returns a number", async () => {
    await seedUser(crypto.randomUUID());
    await seedUser(crypto.randomUUID());
    const n = await getUserCount();
    expect(n).toBe(2);
    // `count(*)::int` — a real JS number, not a bigint or a stringy count.
    expect(Number.isInteger(n)).toBe(true);
  });

  test("excludes synthetic `sys-*` users from the first-run gate", async () => {
    await seedUser("sys-ai-kit");
    await seedUser("sys-obo");
    expect(await getUserCount()).toBe(0);
    await seedUser(crypto.randomUUID());
    expect(await getUserCount()).toBe(1);
  });
});
