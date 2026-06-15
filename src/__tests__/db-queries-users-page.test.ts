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
  // LIKE-metacharacter fixtures: one user whose name contains a literal
  // underscore (`a_b`) and one where the underscore-slot is a different
  // char (`axb`). If `_` were treated as a wildcard, a `q=a_b` search
  // would match BOTH; with escaping it matches only the literal `a_b`.
  await createUser({ email: "lit-underscore@page-test.local", passwordHash: "hashed", name: "a_b literal", role: "member" });
  await createUser({ email: "wildcard-trap@page-test.local", passwordHash: "hashed", name: "axb decoy", role: "member" });
  // A user whose name contains a literal `%` — `q=50%` must not match
  // every row via the `%` any-run wildcard.
  await createUser({ email: "percent@page-test.local", passwordHash: "hashed", name: "50% complete", role: "member" });
});

afterAll(async () => {
  await closeTestDb();
});

describe("listUsersPage", () => {
  // 20 "Member NN" + 5 "Alice" + 3 LIKE-metacharacter fixtures = 28.
  const TOTAL = 28;

  test("returns total = full set and a window of `limit` rows", async () => {
    const { users, total } = await listUsersPage({ limit: 10, offset: 0 });
    expect(total).toBe(TOTAL);
    expect(users).toHaveLength(10);
  });

  test("offset advances the window without changing total", async () => {
    const first = await listUsersPage({ limit: 10, offset: 0 });
    const second = await listUsersPage({ limit: 10, offset: 10 });
    expect(second.total).toBe(TOTAL);
    expect(second.users).toHaveLength(10);
    // No overlap between the two consecutive pages.
    const firstIds = new Set(first.users.map((u) => u.id));
    expect(second.users.every((u) => !firstIds.has(u.id))).toBe(true);
  });

  test("offset past the end yields an empty page but the true total", async () => {
    const { users, total } = await listUsersPage({ limit: 10, offset: 100 });
    expect(users).toHaveLength(0);
    expect(total).toBe(TOTAL);
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
    expect(all.length).toBe(TOTAL);
  });

  describe("LIKE-wildcard escaping (q is matched literally)", () => {
    test("`_` in q matches the literal underscore, not as a single-char wildcard", async () => {
      const { users, total } = await listUsersPage({ limit: 10, offset: 0, q: "a_b" });
      // Only "a_b literal" — NOT "axb decoy" (which an unescaped `_`
      // wildcard would also catch).
      expect(total).toBe(1);
      expect(users).toHaveLength(1);
      expect(users[0]?.name).toBe("a_b literal");
    });

    test("`%` in q matches the literal percent, not as an any-run wildcard", async () => {
      const { users, total } = await listUsersPage({ limit: 30, offset: 0, q: "50%" });
      // Only "50% complete" — an unescaped trailing `%` would match
      // every name beginning "50" (here just one, but the literal-match
      // guarantee is what we assert), and a bare `%` would match all 28.
      expect(total).toBe(1);
      expect(users).toHaveLength(1);
      expect(users[0]?.name).toBe("50% complete");
    });

    test("a bare `%` query does not match every row", async () => {
      const { total } = await listUsersPage({ limit: 30, offset: 0, q: "%" });
      // Escaped, `%` is a literal — only "50% complete" contains one.
      expect(total).toBe(1);
    });
  });
});
