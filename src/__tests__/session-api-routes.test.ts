import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER } from "./helpers/mock-request";
import type { AuthUser } from "../auth/types";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockDbConnection();
mockServerAlias();

mock.module("../../web/src/routes/api/account/sessions/$types", () => ({}));
mock.module("../../web/src/routes/api/account/login-history/$types", () => ({}));
mock.module("$lib/server/security/validation", () =>
  require("../../web/src/lib/server/security/validation"),
);

// ── Handler imports ──────────────────────────────────────────────
import { GET as sessionsGet, DELETE as sessionsDelete } from "../../web/src/routes/api/account/sessions/+server";
import { GET as loginHistoryGet } from "../../web/src/routes/api/account/login-history/+server";

// ── DB helpers ───────────────────────────────────────────────────
import { users, sessions, auditLog } from "../db/schema";
import { hashToken } from "../db/queries/sessions";
import { insertAuditEntry } from "../db/queries/audit-log";

const KNOWN_TOKEN = "my-test-session-token";
const OTHER_TOKEN = "other-session-token";

let testUserId: string;
let testUser: AuthUser;
let currentSessionId: string;
let otherSessionId: string;

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
  await db.delete(sessions);
  await db.delete(users);

  const [user] = await db.insert(users).values({
    email: "session-user@test.local",
    passwordHash: "hashed",
    name: "Session User",
    role: "member",
  }).returning();
  testUserId = user!.id;
  testUser = { id: testUserId, email: "session-user@test.local", name: "Session User", role: "member" };

  const currentHash = await hashToken(KNOWN_TOKEN);
  const otherHash = await hashToken(OTHER_TOKEN);

  const [s1] = await db.insert(sessions).values({
    userId: testUserId,
    tokenHash: currentHash,
    userAgent: "Chrome/120",
    ipAddress: "10.0.0.1",
    expiresAt: new Date(Date.now() + 86400000),
  }).returning();
  currentSessionId = s1!.id;

  const [s2] = await db.insert(sessions).values({
    userId: testUserId,
    tokenHash: otherHash,
    userAgent: "Firefox/119",
    ipAddress: "10.0.0.2",
    expiresAt: new Date(Date.now() + 86400000),
  }).returning();
  otherSessionId = s2!.id;
});

// ── GET /api/account/sessions ────────────────────────────────────

describe("GET /api/account/sessions", () => {
  test("returns sessions with isCurrent flag", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/account/sessions",
      user: testUser,
      cookies: { ezcorp_session: KNOWN_TOKEN },
    });

    const res = await sessionsGet(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.sessions).toBeArray();
    expect(data.sessions).toHaveLength(2);

    const current = data.sessions.find((s: any) => s.id === currentSessionId);
    const other = data.sessions.find((s: any) => s.id === otherSessionId);
    expect(current.isCurrent).toBe(true);
    expect(other.isCurrent).toBe(false);
  });

  test("returns 401 for unauthenticated", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/account/sessions",
    });

    let res: Response;
    try {
      res = await sessionsGet(event);
    } catch (e) {
      res = e as Response;
    }
    expect(res.status).toBe(401);
  });
});

// ── DELETE /api/account/sessions ─────────────────────────────────

describe("DELETE /api/account/sessions", () => {
  test("revokes a non-current session", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/account/sessions",
      body: { sessionId: otherSessionId },
      user: testUser,
      cookies: { ezcorp_session: KNOWN_TOKEN },
    });

    const res = await sessionsDelete(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.success).toBe(true);

    // Verify session is gone from DB
    const db = getTestDb();
    const remaining = await db.select().from(sessions);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(currentSessionId);
  });

  test("returns 400 when trying to revoke current session", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/account/sessions",
      body: { sessionId: currentSessionId },
      user: testUser,
      cookies: { ezcorp_session: KNOWN_TOKEN },
    });

    const res = await sessionsDelete(event);
    expect(res.status).toBe(400);

    const data = await jsonFromResponse(res);
    expect(data.error).toContain("current session");
  });

  test("returns 404 for session not belonging to user", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/account/sessions",
      body: { sessionId: "nonexistent-session-id" },
      user: testUser,
      cookies: { ezcorp_session: KNOWN_TOKEN },
    });

    const res = await sessionsDelete(event);
    expect(res.status).toBe(404);
  });

  test("returns 401 for unauthenticated", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/account/sessions",
      body: { sessionId: otherSessionId },
    });

    let res: Response;
    try {
      res = await sessionsDelete(event);
    } catch (e) {
      res = e as Response;
    }
    expect(res.status).toBe(401);
  });
});

// ── GET /api/account/login-history ───────────────────────────────

describe("GET /api/account/login-history", () => {
  test("returns login audit entries for user", async () => {
    await insertAuditEntry(testUserId, "auth:login", "session", { ip: "10.0.0.1" });
    await insertAuditEntry(testUserId, "auth:login", "session", { ip: "10.0.0.2" });

    const event = createMockEvent({
      url: "http://localhost/api/account/login-history",
      user: testUser,
    });

    const res = await loginHistoryGet(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.entries).toBeArray();
    expect(data.entries).toHaveLength(2);
  });

  test("returns empty entries when no history", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/account/login-history",
      user: testUser,
    });

    const res = await loginHistoryGet(event);
    expect(res.status).toBe(200);

    const data = await jsonFromResponse(res);
    expect(data.entries).toBeArray();
    expect(data.entries).toHaveLength(0);
  });

  test("returns 401 for unauthenticated", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/account/login-history",
    });

    let res: Response;
    try {
      res = await loginHistoryGet(event);
    } catch (e) {
      res = e as Response;
    }
    expect(res.status).toBe(401);
  });
});
