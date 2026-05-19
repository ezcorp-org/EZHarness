import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

// Must be at module level BEFORE handler imports
mockDbConnection();

import { users } from "../db/schema";
import { updateUserPassword, updateUserEmail, updateUserName } from "../db/queries/users";
import { hashPassword, verifyPassword } from "../auth/password";

let testUserId: string;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(users);

  // Seed a test user
  const hash = await hashPassword("password123");
  const [user] = await db.insert(users).values({
    email: "user@example.com",
    passwordHash: hash,
    name: "Test User",
    role: "member",
  }).returning();
  testUserId = user!.id;
});

describe("updateUserPassword", () => {
  test("updates password_hash for given userId, returns true", async () => {
    const newHash = await hashPassword("newpassword456");
    const result = await updateUserPassword(testUserId, newHash);
    expect(result).toBe(true);

    // Verify the password was actually updated
    const db = getTestDb();
    const [row] = await db.select().from(users);
    const matches = await verifyPassword("newpassword456", row!.passwordHash);
    expect(matches).toBe(true);
  });

  test("returns false for nonexistent user", async () => {
    const newHash = await hashPassword("newpassword456");
    const result = await updateUserPassword("nonexistent-id", newHash);
    expect(result).toBe(false);
  });
});

describe("updateUserEmail", () => {
  test("updates email (lowercased), returns true", async () => {
    const result = await updateUserEmail(testUserId, "NEW@EXAMPLE.COM");
    expect(result).toBe(true);

    const db = getTestDb();
    const [row] = await db.select().from(users);
    expect(row!.email).toBe("new@example.com");
  });

  test("returns false for nonexistent user", async () => {
    const result = await updateUserEmail("nonexistent-id", "any@test.com");
    expect(result).toBe(false);
  });
});

describe("updateUserName", () => {
  test("updates name, returns true", async () => {
    const result = await updateUserName(testUserId, "New Name");
    expect(result).toBe(true);

    const db = getTestDb();
    const [row] = await db.select().from(users);
    expect(row!.name).toBe("New Name");
  });
});
