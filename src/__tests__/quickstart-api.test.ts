import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import type { AuthUser } from "../auth/types";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockDbConnection();
mockServerAlias();

// Mock $types
mock.module("../../web/src/routes/api/quickstart/$types", () => ({}));

// ── Handler imports ──────────────────────────────────────────────
import { GET } from "../../web/src/routes/api/quickstart/+server";

// ── Query helpers for test setup ─────────────────────────────────
import { createUser } from "../db/queries/users";
import { getDb } from "../db/connection";
import { settings, conversations, extensions, agentConfigs, users } from "../db/schema";

// ── Test fixtures ────────────────────────────────────────────────
let testUser: AuthUser;
let testUserId: string;

beforeAll(async () => {
  await setupTestDb();

  const user = await createUser({
    email: "quickstart@test.local",
    passwordHash: "hashed",
    name: "QS User",
    role: "member",
  });
  testUserId = user.id;
  testUser = { id: user.id, email: user.email, name: user.name, role: "member" };
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  // Clean up between tests (keep user)
  const db = getDb();
  await db.delete(settings);
  await db.delete(agentConfigs);
  await db.delete(extensions);
  await db.delete(conversations);
});

describe("GET /api/quickstart", () => {
  test("returns 401 without auth", async () => {
    const event = createMockEvent({ url: "http://localhost/api/quickstart" });
    let res: Response;
    try {
      res = await GET(event);
    } catch (e) {
      res = e as Response;
    }
    expect(res.status).toBe(401);
  });

  test("returns all steps false when nothing exists", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/quickstart",
      user: testUser,
    });
    const res = await GET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.steps).toEqual({
      provider: false,
      chat: false,
      extension: false,
      agent: false,
    });
  });

  test("provider step true when API key exists", async () => {
    const db = getDb();
    await db.insert(settings).values({
      key: "provider:openai:apiKey",
      value: "sk-test",
    });

    const event = createMockEvent({
      url: "http://localhost/api/quickstart",
      user: testUser,
    });
    const res = await GET(event);
    const data = await jsonFromResponse(res);
    expect(data.steps.provider).toBe(true);
    expect(data.steps.chat).toBe(false);
  });

  test("provider step true when OAuth token exists", async () => {
    const db = getDb();
    await db.insert(settings).values({
      key: "provider:oauth:google",
      value: { token: "abc" },
    });

    const event = createMockEvent({
      url: "http://localhost/api/quickstart",
      user: testUser,
    });
    const res = await GET(event);
    const data = await jsonFromResponse(res);
    expect(data.steps.provider).toBe(true);
  });

  test("chat step true when user has a non-sub-conversation", async () => {
    const db = getDb();
    // Need a project first
    const { projects } = await import("../db/schema");
    await db.insert(projects).values({
      id: "proj-qs-test",
      name: "Test Project",
      path: "/test",
    });
    await db.insert(conversations).values({
      projectId: "proj-qs-test",
      title: "My Chat",
      userId: testUserId,
      parentConversationId: null,
    });

    const event = createMockEvent({
      url: "http://localhost/api/quickstart",
      user: testUser,
    });
    const res = await GET(event);
    const data = await jsonFromResponse(res);
    expect(data.steps.chat).toBe(true);
  });

  test("chat step false for sub-conversations only", async () => {
    const db = getDb();
    const { projects } = await import("../db/schema");
    await db.insert(projects).values({
      id: "proj-qs-sub",
      name: "Test Project",
      path: "/test",
    });
    // Create a parent first
    const parentRows = await db.insert(conversations).values({
      projectId: "proj-qs-sub",
      title: "Parent Chat",
      userId: testUserId,
    }).returning();
    // Now a sub-conversation referencing the parent
    await db.insert(conversations).values({
      projectId: "proj-qs-sub",
      title: "Sub Chat",
      userId: testUserId,
      parentConversationId: parentRows[0]!.id,
    });
    // Delete the parent so only sub remains
    const { eq } = await import("drizzle-orm");
    await db.delete(conversations).where(eq(conversations.id, parentRows[0]!.id));

    const event = createMockEvent({
      url: "http://localhost/api/quickstart",
      user: testUser,
    });
    const res = await GET(event);
    const data = await jsonFromResponse(res);
    // Sub-conversations alone shouldn't count — but actually the sub still has parentConversationId set,
    // and we're checking for parentConversationId IS NULL, so sub-conversations won't match
    expect(data.steps.chat).toBe(false);
  });

  test("extension step true when non-builtin extension installed", async () => {
    const db = getDb();
    await db.insert(extensions).values({
      name: "my-custom-ext",
      version: "1.0.0",
      manifest: {} as any,
      source: "local",
      installPath: "/tmp/ext",
    });

    const event = createMockEvent({
      url: "http://localhost/api/quickstart",
      user: testUser,
    });
    const res = await GET(event);
    const data = await jsonFromResponse(res);
    expect(data.steps.extension).toBe(true);
  });

  test("extension step false when only builtin-tools installed", async () => {
    const db = getDb();
    await db.insert(extensions).values({
      name: "builtin-tools",
      version: "1.0.0",
      manifest: {} as any,
      source: "builtin",
      installPath: "/builtin",
    });

    const event = createMockEvent({
      url: "http://localhost/api/quickstart",
      user: testUser,
    });
    const res = await GET(event);
    const data = await jsonFromResponse(res);
    expect(data.steps.extension).toBe(false);
  });

  test("agent step true when user has agent config", async () => {
    const db = getDb();
    await db.insert(agentConfigs).values({
      name: "my-agent",
      prompt: "You are helpful",
      userId: testUserId,
    });

    const event = createMockEvent({
      url: "http://localhost/api/quickstart",
      user: testUser,
    });
    const res = await GET(event);
    const data = await jsonFromResponse(res);
    expect(data.steps.agent).toBe(true);
  });
});
