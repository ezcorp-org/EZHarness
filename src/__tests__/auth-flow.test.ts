import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection(); // Must be at module level BEFORE imports that use db

import { signJWT, verifyJWT, getJwtSecret, _resetSecretCache } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";
import { createUser, getUserByEmail, getUserById, listUsers, updateUserStatus, getUserCount } from "../db/queries/users";
import { createInvite, getInviteByToken, markInviteUsed, listInvites, deleteInvite } from "../db/queries/invites";
import { getTestDb } from "./helpers/test-pglite";
import { users, invites, settings } from "../db/schema";

beforeAll(async () => { await setupTestDb(); });
afterAll(async () => { await closeTestDb(); });

// ── JWT ─────────────────────────────────────────────────────────────

describe("JWT", () => {
  const secret = "test-secret-key-for-jwt";
  const payload = { id: "u1", email: "test@example.com", name: "Test User", role: "admin" as const };

  test("signJWT creates a valid token string with 3 dot-separated parts", async () => {
    const token = await signJWT(payload, secret);
    expect(typeof token).toBe("string");
    const parts = token.split(".");
    expect(parts.length).toBe(3);
    // Each part should be non-empty base64url
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
    }
  });

  test("verifyJWT with valid token returns payload with id, email, name, role, iat, exp", async () => {
    const token = await signJWT(payload, secret);
    const decoded = await verifyJWT(token, secret);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe("u1");
    expect(decoded!.email).toBe("test@example.com");
    expect(decoded!.name).toBe("Test User");
    expect(decoded!.role).toBe("admin");
    expect(typeof decoded!.iat).toBe("number");
    expect(typeof decoded!.exp).toBe("number");
    expect(decoded!.exp).toBeGreaterThan(decoded!.iat);
  });

  test("verifyJWT returns null for tampered token", async () => {
    const token = await signJWT(payload, secret);
    // Tamper with the payload portion
    const parts = token.split(".");
    const tampered = parts[0] + "." + parts[1] + "x" + "." + parts[2];
    const result = await verifyJWT(tampered, secret);
    expect(result).toBeNull();
  });

  test("verifyJWT returns null for expired token", async () => {
    const token = await signJWT(payload, secret, -1); // already expired
    const result = await verifyJWT(token, secret);
    expect(result).toBeNull();
  });

  test("verifyJWT returns null for wrong secret", async () => {
    const token = await signJWT(payload, secret);
    const result = await verifyJWT(token, "wrong-secret");
    expect(result).toBeNull();
  });

  describe("getJwtSecret", () => {
    beforeEach(async () => {
      _resetSecretCache();
      delete process.env.EZCORP_JWT_SECRET;
      await getTestDb().delete(settings);
    });

    test("auto-generates and persists secret in settings store", async () => {
      const secret1 = await getJwtSecret();
      expect(typeof secret1).toBe("string");
      expect(secret1.length).toBe(64); // 32 bytes as hex
    });

    test("returns same secret on second call (cached)", async () => {
      const secret1 = await getJwtSecret();
      const secret2 = await getJwtSecret();
      expect(secret1).toBe(secret2);
    });

    test("_resetSecretCache then getJwtSecret re-reads from settings", async () => {
      const secret1 = await getJwtSecret();
      _resetSecretCache();
      const secret2 = await getJwtSecret();
      // Should read back the same persisted secret
      expect(secret2).toBe(secret1);
    });
  });
});

// ── Password ────────────────────────────────────────────────────────

describe("Password", () => {
  test("hashPassword returns a string that is NOT the original password", async () => {
    const hash = await hashPassword("mypassword");
    expect(typeof hash).toBe("string");
    expect(hash).not.toBe("mypassword");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("verifyPassword returns true for correct password", async () => {
    const hash = await hashPassword("correcthorse");
    const result = await verifyPassword("correcthorse", hash);
    expect(result).toBe(true);
  });

  test("verifyPassword returns false for wrong password", async () => {
    const hash = await hashPassword("correcthorse");
    const result = await verifyPassword("wrongpassword", hash);
    expect(result).toBe(false);
  });
});

// ── User queries ────────────────────────────────────────────────────

describe("User queries", () => {
  beforeEach(async () => {
    await getTestDb().delete(invites);
    await getTestDb().delete(users);
  });

  test("createUser inserts and returns user with id", async () => {
    const user = await createUser({
      email: "alice@example.com",
      passwordHash: "hash123",
      name: "Alice",
    });
    expect(user.id).toBeDefined();
    expect(typeof user.id).toBe("string");
    expect(user.email).toBe("alice@example.com");
    expect(user.name).toBe("Alice");
    expect(user.role).toBe("member");
    expect(user.status).toBe("active");
  });

  test("getUserByEmail finds user by email (case insensitive)", async () => {
    await createUser({ email: "bob@example.com", passwordHash: "h", name: "Bob" });
    const found = await getUserByEmail("BOB@EXAMPLE.COM");
    expect(found).toBeDefined();
    expect(found!.name).toBe("Bob");
  });

  test("getUserById finds user by id", async () => {
    const created = await createUser({ email: "carol@example.com", passwordHash: "h", name: "Carol" });
    const found = await getUserById(created.id);
    expect(found).toBeDefined();
    expect(found!.email).toBe("carol@example.com");
  });

  test("listUsers returns all users", async () => {
    await createUser({ email: "a@example.com", passwordHash: "h", name: "A" });
    await createUser({ email: "b@example.com", passwordHash: "h", name: "B" });
    const all = await listUsers();
    expect(all.length).toBe(2);
  });

  test("updateUserStatus changes status", async () => {
    const user = await createUser({ email: "dave@example.com", passwordHash: "h", name: "Dave" });
    expect(user.status).toBe("active");
    const updated = await updateUserStatus(user.id, "inactive");
    expect(updated).toBe(true);
    const fetched = await getUserById(user.id);
    expect(fetched!.status).toBe("inactive");
  });

  test("getUserCount returns correct count", async () => {
    expect(await getUserCount()).toBe(0);
    await createUser({ email: "x@example.com", passwordHash: "h", name: "X" });
    expect(await getUserCount()).toBe(1);
    await createUser({ email: "y@example.com", passwordHash: "h", name: "Y" });
    expect(await getUserCount()).toBe(2);
  });
});

// ── Invite queries ──────────────────────────────────────────────────

describe("Invite queries", () => {
  let creatorId: string;

  beforeEach(async () => {
    await getTestDb().delete(invites);
    await getTestDb().delete(users);
    const creator = await createUser({ email: "admin@example.com", passwordHash: "h", name: "Admin", role: "admin" });
    creatorId = creator.id;
  });

  test("createInvite generates a token and returns invite", async () => {
    const invite = await createInvite({ role: "member", createdBy: creatorId });
    expect(invite.id).toBeDefined();
    expect(invite.token).toBeDefined();
    expect(invite.token.length).toBe(64); // 32 bytes as hex
    expect(invite.role).toBe("member");
    expect(invite.createdBy).toBe(creatorId);
    expect(invite.expiresAt).toBeInstanceOf(Date);
  });

  test("getInviteByToken returns valid unexpired invite", async () => {
    const invite = await createInvite({ role: "member", createdBy: creatorId });
    const found = await getInviteByToken(invite.token);
    expect(found).toBeDefined();
    expect(found!.id).toBe(invite.id);
  });

  test("getInviteByToken returns undefined for expired invite", async () => {
    const invite = await createInvite({ role: "member", createdBy: creatorId, expiresInDays: 0 });
    // expiresInDays: 0 sets expiresAt to now, which is already past by the time we query
    const found = await getInviteByToken(invite.token);
    expect(found).toBeUndefined();
  });

  test("markInviteUsed marks invite, making it invisible to getInviteByToken", async () => {
    const invite = await createInvite({ role: "member", createdBy: creatorId });
    const marked = await markInviteUsed(invite.id);
    expect(marked).toBe(true);
    const found = await getInviteByToken(invite.token);
    expect(found).toBeUndefined();
  });

  test("listInvites returns invites", async () => {
    await createInvite({ role: "member", createdBy: creatorId });
    await createInvite({ role: "admin", createdBy: creatorId });
    const all = await listInvites();
    expect(all.length).toBe(2);
  });

  test("listInvites filters by createdBy", async () => {
    const other = await createUser({ email: "other@example.com", passwordHash: "h", name: "Other" });
    await createInvite({ role: "member", createdBy: creatorId });
    await createInvite({ role: "member", createdBy: other.id });
    const filtered = await listInvites(creatorId);
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.createdBy).toBe(creatorId);
  });

  test("deleteInvite removes invite", async () => {
    const invite = await createInvite({ role: "member", createdBy: creatorId });
    const deleted = await deleteInvite(invite.id);
    expect(deleted).toBe(true);
    const all = await listInvites();
    expect(all.length).toBe(0);
  });

  test("deleteInvite returns false for nonexistent id", async () => {
    const deleted = await deleteInvite("nonexistent-id");
    expect(deleted).toBe(false);
  });
});
