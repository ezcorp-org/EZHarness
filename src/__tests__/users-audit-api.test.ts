import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import type { AuthUser } from "../auth/types";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockDbConnection();
mockServerAlias();

// Mock $types (type-only in source, but guard against resolution errors)
for (const path of [
  "../../web/src/routes/api/users/$types",
  "../../web/src/routes/api/users/[id]/$types",
  "../../web/src/routes/api/audit-log/$types",
]) {
  mock.module(path, () => ({}));
}

// ── Handler imports ──────────────────────────────────────────────
import { GET as usersGet } from "../../web/src/routes/api/users/+server";
import { PUT as userPut } from "../../web/src/routes/api/users/[id]/+server";
import { GET as auditGet } from "../../web/src/routes/api/audit-log/+server";

// ── Query helpers for test setup ─────────────────────────────────
import { createUser } from "../db/queries/users";
import { insertAuditEntry } from "../db/queries/audit-log";
import { users, auditLog, agentConfigs } from "../db/schema";
import { getTestDb } from "./helpers/test-pglite";

// ── Test fixtures ────────────────────────────────────────────────
let adminUser: AuthUser;
let memberUser: AuthUser;
let adminDbId: string;
let memberDbId: string;

beforeAll(async () => {
  await setupTestDb();

  const admin = await createUser({
    email: "admin@users-test.local",
    passwordHash: "hashed",
    name: "Admin User",
    role: "admin",
  });
  adminDbId = admin.id;
  adminUser = { id: admin.id, email: admin.email, name: admin.name, role: "admin" };

  const member = await createUser({
    email: "member@users-test.local",
    passwordHash: "hashed",
    name: "Member User",
    role: "member",
  });
  memberDbId = member.id;
  memberUser = { id: member.id, email: member.email, name: member.name, role: "member" };
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(auditLog);
  // Reset member user status back to active between tests
  await db.update(users).set({ status: "active" }).where(
    (await import("drizzle-orm")).eq(users.id, memberDbId),
  );
});

// ── GET /api/users ───────────────────────────────────────────────
describe("GET /api/users", () => {
  test("admin gets user list without passwordHash", async () => {
    const event = createMockEvent({ user: adminUser });
    const res = await usersGet(event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res);
    expect(body.users.length).toBeGreaterThanOrEqual(2);

    // Verify no passwordHash is leaked
    for (const u of body.users) {
      expect(u).not.toHaveProperty("passwordHash");
      expect(u.email).toBeTruthy();
      expect(u.name).toBeTruthy();
    }
  });

  test("member gets 403", async () => {
    const event = createMockEvent({ user: memberUser });
    const res = await usersGet(event);
    expect(res.status).toBe(403);
  });
});

// ── PUT /api/users/[id] ─────────────────────────────────────────
describe("PUT /api/users/[id]", () => {
  test("admin deactivates user", async () => {
    const event = createMockEvent({
      method: "PUT",
      user: adminUser,
      params: { id: memberDbId },
      body: { status: "inactive" },
    });
    const res = await userPut(event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res);
    expect(body.user.status).toBe("inactive");
    expect(body.user).not.toHaveProperty("passwordHash");
  });

  test("cannot deactivate self (400)", async () => {
    const event = createMockEvent({
      method: "PUT",
      user: adminUser,
      params: { id: adminDbId },
      body: { status: "inactive" },
    });
    const res = await userPut(event);
    expect(res.status).toBe(400);

    const body = await jsonFromResponse(res);
    expect(body.error).toContain("yourself");
  });

  test("deactivation transfers agent ownership to admin", async () => {
    const db = getTestDb();

    // Create agent configs owned by the member
    const agentId = crypto.randomUUID();
    await db.insert(agentConfigs).values({
      id: agentId,
      name: `transfer-test-${agentId.slice(0, 8)}`,
      prompt: "Test prompt",
      userId: memberDbId,
    });

    const event = createMockEvent({
      method: "PUT",
      user: adminUser,
      params: { id: memberDbId },
      body: { status: "inactive" },
    });
    const res = await userPut(event);
    expect(res.status).toBe(200);

    // Verify the agent is now owned by the admin
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.id, agentId));
    expect(rows[0]!.userId).toBe(adminDbId);

    // Clean up
    await db.delete(agentConfigs).where(eq(agentConfigs.id, agentId));
  });

  test("member gets 403", async () => {
    const event = createMockEvent({
      method: "PUT",
      user: memberUser,
      params: { id: adminDbId },
      body: { status: "inactive" },
    });
    const res = await userPut(event);
    expect(res.status).toBe(403);
  });
});

// ── GET /api/audit-log ───────────────────────────────────────────
describe("GET /api/audit-log", () => {
  test("admin can list audit entries", async () => {
    await insertAuditEntry(adminDbId, "user:registered", memberDbId);
    await insertAuditEntry(adminDbId, "user:deactivated", memberDbId);

    const event = createMockEvent({
      user: adminUser,
      url: "http://localhost/api/audit-log",
    });
    const res = await auditGet(event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res);
    expect(body.entries.length).toBeGreaterThanOrEqual(2);
  });

  test("member gets 403", async () => {
    const event = createMockEvent({
      user: memberUser,
      url: "http://localhost/api/audit-log",
    });
    const res = await auditGet(event);
    expect(res.status).toBe(403);
  });

  test("supports limit and offset", async () => {
    // Insert several entries
    for (let i = 0; i < 5; i++) {
      await insertAuditEntry(adminDbId, "test:action", `target-${i}`);
    }

    const event = createMockEvent({
      user: adminUser,
      url: "http://localhost/api/audit-log?limit=2&offset=1",
    });
    const res = await auditGet(event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res);
    expect(body.entries).toHaveLength(2);
  });

  test("supports action filtering", async () => {
    await insertAuditEntry(adminDbId, "user:registered", "target-a");
    await insertAuditEntry(adminDbId, "user:deactivated", "target-b");
    await insertAuditEntry(adminDbId, "user:registered", "target-c");

    const event = createMockEvent({
      user: adminUser,
      url: "http://localhost/api/audit-log?action=user:registered",
    });
    const res = await auditGet(event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res);
    // All returned entries should have the filtered action
    for (const entry of body.entries) {
      expect(entry.action).toBe("user:registered");
    }
    expect(body.entries.length).toBeGreaterThanOrEqual(2);
  });
});
