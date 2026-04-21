import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER, MEMBER_USER } from "./helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockDbConnection();
mockServerAlias();

mock.module("../../web/src/routes/api/admin/sessions/$types", () => ({}));
mock.module("$lib/server/security/validation", () =>
  require("../../web/src/lib/server/security/validation"),
);
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

// ── Handler imports ──────────────────────────────────────────────
import { GET, DELETE } from "../../web/src/routes/api/admin/sessions/+server";

// ── DB helpers ───────────────────────────────────────────────────
import { users, sessions } from "../db/schema";
import { hashToken } from "../db/queries/sessions";

let adminUserId: string;
let memberUserId: string;
let adminSessionId: string;
let memberSessionId: string;

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  const db = getTestDb();
  await db.delete(sessions);
  await db.delete(users);

  const [admin] = await db.insert(users).values({
    email: "admin@test.local",
    passwordHash: "hashed",
    name: "Test Admin",
    role: "admin",
  }).returning();
  adminUserId = admin!.id;

  const [member] = await db.insert(users).values({
    email: "member@test.local",
    passwordHash: "hashed",
    name: "Test Member",
    role: "member",
  }).returning();
  memberUserId = member!.id;

  const adminHash = await hashToken("admin-token");
  const memberHash = await hashToken("member-token");

  const [s1] = await db.insert(sessions).values({
    userId: adminUserId,
    tokenHash: adminHash,
    userAgent: "Chrome/120",
    ipAddress: "10.0.0.1",
    expiresAt: new Date(Date.now() + 86400000),
  }).returning();
  adminSessionId = s1!.id;

  const [s2] = await db.insert(sessions).values({
    userId: memberUserId,
    tokenHash: memberHash,
    userAgent: "Firefox/119",
    ipAddress: "10.0.0.2",
    expiresAt: new Date(Date.now() + 86400000),
  }).returning();
  memberSessionId = s2!.id;
});

// ── GET /api/admin/sessions ──────────────────────────────────────

describe("GET /api/admin/sessions", () => {
  test("returns all sessions with user info for admin", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/admin/sessions",
      user: { ...ADMIN_USER, id: adminUserId },
    });

    const res = await GET(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.sessions).toBeArray();
    expect(data.sessions).toHaveLength(2);

    const adminSession = data.sessions.find((s: any) => s.userId === adminUserId);
    expect(adminSession).toBeDefined();
    expect(adminSession.userName).toBe("Test Admin");
    expect(adminSession.userEmail).toBe("admin@test.local");
    expect(adminSession.userAgent).toBe("Chrome/120");
    expect(adminSession.ipAddress).toBe("10.0.0.1");
    expect(adminSession.id).toBeDefined();
    expect(adminSession.createdAt).toBeDefined();
  });

  test("filters sessions by userId query param", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/admin/sessions?userId=${memberUserId}`,
      user: { ...ADMIN_USER, id: adminUserId },
    });

    const res = await GET(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].userId).toBe(memberUserId);
    expect(data.sessions[0].userName).toBe("Test Member");
  });

  test("returns 403 for non-admin user", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/admin/sessions",
      user: MEMBER_USER,
    });

    let res: Response;
    try {
      res = await GET(event);
    } catch (e) {
      res = e as Response;
    }
    expect(res.status).toBe(403);
  });
});

// ── DELETE /api/admin/sessions ───────────────────────────────────

describe("DELETE /api/admin/sessions", () => {
  test("revokes all sessions for a userId", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/admin/sessions",
      body: { userId: memberUserId },
      user: { ...ADMIN_USER, id: adminUserId },
    });

    const res = await DELETE(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.success).toBe(true);
    expect(data.revokedCount).toBe(1);

    // Verify member sessions are gone
    const db = getTestDb();
    const remaining = await db.select().from(sessions);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.userId).toBe(adminUserId);
  });

  test("revokes a single session by sessionId", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/admin/sessions",
      body: { sessionId: memberSessionId },
      user: { ...ADMIN_USER, id: adminUserId },
    });

    const res = await DELETE(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.success).toBe(true);

    const db = getTestDb();
    const remaining = await db.select().from(sessions);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(adminSessionId);
  });

  test("returns 404 for non-existent sessionId", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/admin/sessions",
      body: { sessionId: "nonexistent-id" },
      user: { ...ADMIN_USER, id: adminUserId },
    });

    const res = await DELETE(event);
    expect(res.status).toBe(404);
  });

  test("returns validation error when neither userId nor sessionId provided", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/admin/sessions",
      body: {},
      user: { ...ADMIN_USER, id: adminUserId },
    });

    const res = await DELETE(event);
    expect(res.status).toBe(400);
  });

  test("returns 403 for non-admin", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/admin/sessions",
      body: { sessionId: memberSessionId },
      user: MEMBER_USER,
    });

    let res: Response;
    try {
      res = await DELETE(event);
    } catch (e) {
      res = e as Response;
    }
    expect(res.status).toBe(403);
  });
});
