import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockDbConnection();
mockServerAlias();

// Mock $types and $lib aliases
mock.module("../../web/src/routes/api/auth/reset-password/$types", () => ({}));
mock.module("../../web/src/routes/api/auth/reset-password/[token]/$types", () => ({}));
mock.module("$lib/server/security/validation", () =>
  require("../../web/src/lib/server/security/validation"),
);

// ── Handler imports ──────────────────────────────────────────────
import { POST as generatePost } from "../../web/src/routes/api/auth/reset-password/+server";
import { POST as consumePost } from "../../web/src/routes/api/auth/reset-password/[token]/+server";

// ── DB helpers ───────────────────────────────────────────────────
import { users, passwordResetTokens, auditLog } from "../db/schema";
import { hashPassword } from "../auth/password";

let adminId: string;
let memberId: string;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(auditLog);
  await db.delete(passwordResetTokens);
  await db.delete(users);

  const hash = await hashPassword("password123");
  const [admin] = await db.insert(users).values({
    email: "admin@test.local",
    passwordHash: hash,
    name: "Test Admin",
    role: "admin",
  }).returning();
  adminId = admin!.id;

  const [member] = await db.insert(users).values({
    email: "member@test.local",
    passwordHash: hash,
    name: "Test Member",
    role: "member",
  }).returning();
  memberId = member!.id;
});

// ── POST /api/auth/reset-password (admin generates token) ────────

describe("POST /api/auth/reset-password", () => {
  test("admin generates reset token for a user", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/reset-password",
      body: { userId: memberId },
      user: { id: adminId, email: "admin@test.local", name: "Test Admin", role: "admin" },
    });

    const res = await generatePost(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    // SEC F-H4: raw token must NOT appear in the response body.
    expect(data.token).toBeUndefined();
    expect(data.resetUrl).toBeUndefined();
    expect(data.ok).toBe(true);
    expect(typeof data.masked).toBe("string");
    // Masked preview is 4 hex prefix + "..." + 4 hex suffix.
    expect(data.masked).toMatch(/^[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
  });

  test("rejects non-admin users", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/reset-password",
      body: { userId: memberId },
      user: { id: memberId, email: "member@test.local", name: "Test Member", role: "member" },
    });

    let res: Response;
    try {
      res = await generatePost(event);
    } catch (e) {
      res = e as Response;
    }
    expect(res.status).toBe(403);
  });

  test("rejects unauthenticated requests", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/reset-password",
      body: { userId: memberId },
    });

    let res: Response;
    try {
      res = await generatePost(event);
    } catch (e) {
      res = e as Response;
    }
    expect(res.status).toBe(401);
  });

  test("returns 404 for nonexistent user", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/reset-password",
      body: { userId: "nonexistent-id" },
      user: { id: adminId, email: "admin@test.local", name: "Test Admin", role: "admin" },
    });

    const res = await generatePost(event);
    expect(res.status).toBe(404);
    const data = await jsonFromResponse(res);
    expect(data.error).toBe("User not found");
  });

  test("returns 400 for missing userId", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/reset-password",
      body: {},
      user: { id: adminId, email: "admin@test.local", name: "Test Admin", role: "admin" },
    });

    const res = await generatePost(event);
    expect(res.status).toBe(400);
  });

  test("creates audit log entry", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/reset-password",
      body: { userId: memberId },
      user: { id: adminId, email: "admin@test.local", name: "Test Admin", role: "admin" },
    });

    await generatePost(event);

    const db = getTestDb();
    const logs = await db.select().from(auditLog);
    const resetLog = logs.find(l => l.action === "auth:password_reset_generated");
    expect(resetLog).toBeDefined();
    expect(resetLog!.userId).toBe(adminId);
  });
});

// ── POST /api/auth/reset-password/[token] (consume token) ────────

describe("POST /api/auth/reset-password/[token]", () => {
  async function generateToken(userId: string): Promise<string> {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/reset-password",
      body: { userId },
      user: { id: adminId, email: "admin@test.local", name: "Test Admin", role: "admin" },
    });
    const res = await generatePost(event);
    expect(res.status).toBe(200);
    // SEC F-H4: token is no longer in the response body; admins retrieve it
    // via the audit log's metadata.resetUrl field.
    const db = getTestDb();
    const logs = await db.select().from(auditLog);
    const log = logs
      .filter(l => l.action === "auth:password_reset_generated")
      .at(-1);
    const meta = (log?.metadata ?? {}) as { resetUrl?: string };
    const match = meta.resetUrl?.match(/\/reset-password\/([0-9a-f]{64})$/);
    if (!match) throw new Error("reset token not found in audit log metadata");
    return match[1]!;
  }

  test("resets password with valid token and matching email", async () => {
    const token = await generateToken(memberId);

    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/reset-password/${token}`,
      body: { email: "member@test.local", password: "NewPassword456" },
      params: { token },
    });

    const res = await consumePost(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.success).toBe(true);
  });

  test("rejects invalid token", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/reset-password/invalidtoken",
      body: { email: "member@test.local", password: "NewPassword456" },
      params: { token: "invalidtoken" },
    });

    const res = await consumePost(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Invalid or expired reset link");
  });

  test("rejects already-used token", async () => {
    const token = await generateToken(memberId);

    // First use
    const event1 = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/reset-password/${token}`,
      body: { email: "member@test.local", password: "NewPassword456" },
      params: { token },
    });
    const res1 = await consumePost(event1);
    expect(res1.status).toBe(200);

    // Second use
    const event2 = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/reset-password/${token}`,
      body: { email: "member@test.local", password: "AnotherPass789" },
      params: { token },
    });
    const res2 = await consumePost(event2);
    expect(res2.status).toBe(400);
    const data = await jsonFromResponse(res2);
    expect(data.error).toBe("Invalid or expired reset link");
  });

  test("ignores email field (SEC F-H4: token binding is authoritative)", async () => {
    // Post-F-H4 behavior: the single-use token atomically binds to a user on claim,
    // so the email field (still accepted for schema back-compat) is no longer checked.
    const token = await generateToken(memberId);

    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/reset-password/${token}`,
      body: { email: "wrong@test.local", password: "NewPassword456" },
      params: { token },
    });

    const res = await consumePost(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.success).toBe(true);
  });

  test("rejects short password", async () => {
    const token = await generateToken(memberId);

    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/reset-password/${token}`,
      body: { email: "member@test.local", password: "short" },
      params: { token },
    });

    const res = await consumePost(event);
    expect(res.status).toBe(400);
  });

  test("creates audit log entry on successful reset", async () => {
    const db = getTestDb();
    await db.delete(auditLog);

    const token = await generateToken(memberId);

    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/auth/reset-password/${token}`,
      body: { email: "member@test.local", password: "NewPassword456" },
      params: { token },
    });

    await consumePost(event);

    const logs = await db.select().from(auditLog);
    const resetLog = logs.find(l => l.action === "auth:password_reset");
    expect(resetLog).toBeDefined();
    expect(resetLog!.userId).toBe(memberId);
  });
});
