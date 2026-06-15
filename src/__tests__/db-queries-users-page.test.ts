/**
 * DB-level tests for listUsersPage (Settings v2 opt-in pagination).
 * Exercises limit/offset windowing, case-insensitive name/email `q`
 * filtering, and the total count (pre-limit) against a real PGlite DB.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { createUser, listUsersPage, listUsers } from "../db/queries/users";

beforeAll(async () => {
  await setupTestDb();
  // 25 users: 20 "Member NN" + 5 with "alice" in name/email for q-filter.
  for (let i = 0; i < 20; i++) {
    await createUser({
      email: `member${String(i).padStart(2, "0")}@page-test.local`,
      passwordHash: "hashed",
      name: `Member ${String(i).padStart(2, "0")}`,
      role: "member",
    });
  }
  for (let i = 0; i < 5; i++) {
    await createUser({
      email: `alice${i}@page-test.local`,
      passwordHash: "hashed",
      name: `Alice Number ${i}`,
      role: "member",
    });
  }
});

afterAll(async () => {
  await closeTestDb();
});

describe("listUsersPage", () => {
  test("returns total = full set and a window of `limit` rows", async () => {
    const { users, total } = await listUsersPage({ limit: 10, offset: 0 });
    expect(total).toBe(25);
    expect(users).toHaveLength(10);
  });

  test("offset advances the window without changing total", async () => {
    const first = await listUsersPage({ limit: 10, offset: 0 });
    const second = await listUsersPage({ limit: 10, offset: 10 });
    expect(second.total).toBe(25);
    expect(second.users).toHaveLength(10);
    // No overlap between the two consecutive pages.
    const firstIds = new Set(first.users.map((u) => u.id));
    expect(second.users.every((u) => !firstIds.has(u.id))).toBe(true);
  });

  test("offset past the end yields an empty page but the true total", async () => {
    const { users, total } = await listUsersPage({ limit: 10, offset: 100 });
    expect(users).toHaveLength(0);
    expect(total).toBe(25);
  });

  test("q filters by name (case-insensitive) and counts only matches", async () => {
    const { users, total } = await listUsersPage({ limit: 10, offset: 0, q: "alice" });
    expect(total).toBe(5);
    expect(users).toHaveLength(5);
    expect(users.every((u) => u.name.toLowerCase().includes("alice"))).toBe(true);
  });

  test("q filters by email substring", async () => {
    const { users, total } = await listUsersPage({ limit: 10, offset: 0, q: "alice3@page" });
    expect(total).toBe(1);
    expect(users[0]?.email).toBe("alice3@page-test.local");
  });

  test("q honours limit/offset over the filtered set", async () => {
    const { users, total } = await listUsersPage({ limit: 2, offset: 2, q: "alice" });
    expect(total).toBe(5);
    expect(users).toHaveLength(2);
  });

  test("no-match q returns an empty page and zero total", async () => {
    const { users, total } = await listUsersPage({ limit: 10, offset: 0, q: "zzz-nobody" });
    expect(users).toHaveLength(0);
    expect(total).toBe(0);
  });

  test("listUsers (no-param contract) still returns every row unpaged", async () => {
    const all = await listUsers();
    expect(all.length).toBe(25);
  });
});
