import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

// Must be at module level BEFORE handler imports
mockDbConnection();

import { users, passwordResetTokens } from "../db/schema";
import { createPasswordResetToken, claimPasswordResetToken, deleteExpiredResetTokens } from "../db/queries/password-resets";
import { hashToken } from "../db/queries/sessions";
import { hashPassword } from "../auth/password";


let testUserId: string;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(passwordResetTokens);
  await db.delete(users);

  // Seed a test user
  const hash = await hashPassword("password123");
  const [user] = await db.insert(users).values({
    email: "test@example.com",
    passwordHash: hash,
    name: "Test User",
    role: "member",
  }).returning();
  testUserId = user!.id;
});

describe("createPasswordResetToken", () => {
  test("stores hashed token with userId and 1-hour expiry", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = "abc123tokenvalue";

    const result = await createPasswordResetToken({
      userId: testUserId,
      token,
      expiresAt,
    });

    const expectedHash = await hashToken(token);
    expect(result.userId).toBe(testUserId);
    expect(result.token).toBe(expectedHash);
    expect(result.token).not.toBe(token); // raw token must NOT be stored
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.usedAt).toBeNull();
    expect(result.id).toBeDefined();
  });
});

describe("claimPasswordResetToken", () => {
  test("returns token data and marks used_at atomically", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = "claim-token-123";

    await createPasswordResetToken({ userId: testUserId, token, expiresAt });

    const claimed = await claimPasswordResetToken(token);
    const expectedHash = await hashToken(token);
    expect(claimed).toBeDefined();
    expect(claimed!.token).toBe(expectedHash);
    expect(claimed!.userId).toBe(testUserId);
    expect(claimed!.usedAt).toBeInstanceOf(Date);
  });

  test("returns undefined for already-used tokens", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const token = "single-use-token";

    await createPasswordResetToken({ userId: testUserId, token, expiresAt });

    // First claim succeeds
    const first = await claimPasswordResetToken(token);
    expect(first).toBeDefined();

    // Second claim fails
    const second = await claimPasswordResetToken(token);
    expect(second).toBeUndefined();
  });

  test("returns undefined for expired tokens", async () => {
    const expiresAt = new Date(Date.now() - 1000); // expired 1 second ago
    const token = "expired-token";

    await createPasswordResetToken({ userId: testUserId, token, expiresAt });

    const result = await claimPasswordResetToken(token);
    expect(result).toBeUndefined();
  });
});

describe("deleteExpiredResetTokens", () => {
  test("cleans up old entries", async () => {
    const db = getTestDb();

    // Create an expired token
    await createPasswordResetToken({
      userId: testUserId,
      token: "expired-cleanup",
      expiresAt: new Date(Date.now() - 60 * 1000), // expired 1 minute ago
    });

    // Create a valid token
    await createPasswordResetToken({
      userId: testUserId,
      token: "still-valid",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await deleteExpiredResetTokens();

    const remaining = await db.select().from(passwordResetTokens);
    expect(remaining).toHaveLength(1);
    const expectedHash = await hashToken("still-valid");
    expect(remaining[0]!.token).toBe(expectedHash);
  });
});
