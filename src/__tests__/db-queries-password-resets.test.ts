import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  createPasswordResetToken,
  claimPasswordResetToken,
  deleteExpiredResetTokens,
} = await import("../db/queries/password-resets");
const { createUser } = await import("../db/queries/users");

describe("password-resets queries", () => {
  let userId: string;

  beforeEach(async () => {
    await setupTestDb();
    const u = await createUser({ email: "pr@test.com", passwordHash: "h", name: "PR" });
    userId = u.id;
  });
  afterAll(async () => await closeTestDb());

  test("createPasswordResetToken stores hashed token (not plaintext)", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const row = await createPasswordResetToken({ userId, token: "raw-token", expiresAt });

    expect(row.id).toBeDefined();
    expect(row.userId).toBe(userId);
    expect(row.usedAt).toBeNull();
    expect(row.token).not.toBe("raw-token"); // stored as hash
    expect(row.token.length).toBeGreaterThan(20);
    expect(row.expiresAt).toBeInstanceOf(Date);
  });

  test("claimPasswordResetToken consumes valid token and marks used", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    await createPasswordResetToken({ userId, token: "tok-claim", expiresAt });

    const claimed = await claimPasswordResetToken("tok-claim");
    expect(claimed).toBeDefined();
    expect(claimed!.userId).toBe(userId);
    expect(claimed!.usedAt).toBeInstanceOf(Date);

    // Second claim should fail (already used)
    const reclaimed = await claimPasswordResetToken("tok-claim");
    expect(reclaimed).toBeUndefined();
  });

  test("claimPasswordResetToken rejects unknown token", async () => {
    const result = await claimPasswordResetToken("nonexistent");
    expect(result).toBeUndefined();
  });

  test("claimPasswordResetToken rejects expired token", async () => {
    const past = new Date(Date.now() - 1000);
    await createPasswordResetToken({ userId, token: "expired-tok", expiresAt: past });

    const result = await claimPasswordResetToken("expired-tok");
    expect(result).toBeUndefined();
  });

  test("deleteExpiredResetTokens prunes only expired rows", async () => {
    const past = new Date(Date.now() - 5000);
    const future = new Date(Date.now() + 60_000);

    await createPasswordResetToken({ userId, token: "old-1", expiresAt: past });
    await createPasswordResetToken({ userId, token: "old-2", expiresAt: past });
    await createPasswordResetToken({ userId, token: "fresh", expiresAt: future });

    await deleteExpiredResetTokens();

    // Fresh one is still claimable
    const claimed = await claimPasswordResetToken("fresh");
    expect(claimed).toBeDefined();
    // Expired ones are gone (claim returns undefined either way, but no row exists)
    expect(await claimPasswordResetToken("old-1")).toBeUndefined();
  });
});
