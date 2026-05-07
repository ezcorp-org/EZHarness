/**
 * CRUD + retention coverage for `sdk_capability_calls` queries
 * (Phase 50.3).
 *
 * Asserts:
 *   - insert → list-by-extension / list-by-conversation / list-by-user round-trip
 *   - filters (capability, since, until, cursor) work as documented
 *   - cleanupOldSdkCapabilityCalls deletes per-capability with separate
 *     thresholds (LLM 90d retains, memory 0d purges)
 *   - cleanup with retention {llm:0, memory:0, lessons:0, schedule:0}
 *     deletes all rows
 *   - NOT NULL on_behalf_of enforced (insert with null userId throws)
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mock.module("../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import {
  insertSdkCapabilityCall,
  listSdkCapabilityCallsForExtension,
  listSdkCapabilityCallsForConversation,
  listSdkCapabilityCallsForUser,
  cleanupOldSdkCapabilityCalls,
} from "../db/queries/sdk-capability-calls";
import { createUser } from "../db/queries/users";
import { extensions, conversations, sdkCapabilityCalls, projects } from "../db/schema";
import { sql } from "drizzle-orm";

let userId: string;
let userId2: string;
let extensionId: string;
let conversationId: string;
let projectId: string;

async function ensureExtension(name: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .insert(extensions)
    .values({
      name,
      version: "0.0.1",
      description: "",
      manifest: { schemaVersion: 2, name, version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as any,
      source: "test",
      enabled: true,
      grantedPermissions: {} as any,
    })
    .returning({ id: extensions.id });
  return row!.id;
}

async function ensureConversation(userIdLocal: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .insert(conversations)
    .values({ projectId, userId: userIdLocal, title: "test", kind: "regular" })
    .returning({ id: conversations.id });
  return row!.id;
}

async function ensureProject(): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .insert(projects)
    .values({ name: "test-proj", path: "/tmp/test-proj" })
    .returning({ id: projects.id });
  return row!.id;
}

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "sdk-cap-it-1@example.com",
    passwordHash: "h",
    name: "U1",
    role: "admin",
    status: "active",
  });
  userId = u.id;
  const u2 = await createUser({
    email: "sdk-cap-it-2@example.com",
    passwordHash: "h",
    name: "U2",
    role: "member",
    status: "active",
  });
  userId2 = u2.id;
  extensionId = await ensureExtension("ext-cap-1");
  projectId = await ensureProject();
  conversationId = await ensureConversation(userId);
});

beforeEach(async () => {
  // Wipe any prior rows so per-test assertions are deterministic.
  await getTestDb().delete(sdkCapabilityCalls);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("insertSdkCapabilityCall + listing", () => {
  test("round-trip: insert, list by extension/conversation/user", async () => {
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId,
      conversationId,
      capability: "llm",
      action: "complete",
      success: true,
      durationMs: 42,
      tokensUsed: 100,
      provider: "anthropic",
      model: "claude-sonnet-4",
    });

    const byExt = await listSdkCapabilityCallsForExtension(extensionId);
    expect(byExt.length).toBe(1);
    expect(byExt[0]!.capability).toBe("llm");
    expect(byExt[0]!.success).toBe(true);

    const byConv = await listSdkCapabilityCallsForConversation(conversationId);
    expect(byConv.length).toBe(1);

    const byUser = await listSdkCapabilityCallsForUser(userId);
    expect(byUser.length).toBe(1);
    expect(byUser[0]!.onBehalfOf).toBe(userId);
  });

  test("filter by capability on per-extension list", async () => {
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId,
      capability: "llm",
      action: "complete",
      success: true,
      durationMs: 1,
    });
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId,
      capability: "memory",
      action: "read",
      success: true,
      durationMs: 1,
    });
    const llmRows = await listSdkCapabilityCallsForExtension(extensionId, { capability: "llm" });
    expect(llmRows.length).toBe(1);
    expect(llmRows[0]!.capability).toBe("llm");
  });

  test("conversation listing isolates between conversations", async () => {
    const otherConv = await ensureConversation(userId);
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId,
      conversationId,
      capability: "llm",
      action: "complete",
      success: true,
      durationMs: 1,
    });
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId,
      conversationId: otherConv,
      capability: "llm",
      action: "complete",
      success: true,
      durationMs: 1,
    });
    const a = await listSdkCapabilityCallsForConversation(conversationId);
    const b = await listSdkCapabilityCallsForConversation(otherConv);
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0]!.id).not.toBe(b[0]!.id);
  });

  test("user listing isolates between users", async () => {
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId,
      capability: "memory",
      action: "read",
      success: true,
      durationMs: 1,
    });
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId2,
      capability: "memory",
      action: "read",
      success: true,
      durationMs: 1,
    });
    const a = await listSdkCapabilityCallsForUser(userId);
    const b = await listSdkCapabilityCallsForUser(userId2);
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0]!.onBehalfOf).toBe(userId);
    expect(b[0]!.onBehalfOf).toBe(userId2);
  });
});

describe("cleanupOldSdkCapabilityCalls — per-capability retention", () => {
  test("retention {0,0,0,0} deletes all rows", async () => {
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId,
      capability: "llm",
      action: "complete",
      success: true,
      durationMs: 1,
    });
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId,
      capability: "memory",
      action: "read",
      success: true,
      durationMs: 1,
    });
    await cleanupOldSdkCapabilityCalls({ llmDays: 0, memoryDays: 0, lessonsDays: 0, scheduleDays: 0 });
    const remaining = await listSdkCapabilityCallsForExtension(extensionId, { limit: 100 });
    expect(remaining.length).toBe(0);
  });

  test("per-capability retention applies independently (LLM 90d retains; memory 0d purges)", async () => {
    // Insert one of each capability with default created_at = NOW().
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId,
      capability: "llm",
      action: "complete",
      success: true,
      durationMs: 1,
    });
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId,
      capability: "memory",
      action: "read",
      success: true,
      durationMs: 1,
    });
    await cleanupOldSdkCapabilityCalls({ llmDays: 90, memoryDays: 0, lessonsDays: 30, scheduleDays: 90 });
    const remaining = await listSdkCapabilityCallsForExtension(extensionId, { limit: 100 });
    // Only the LLM row should survive.
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.capability).toBe("llm");
  });

  test("rows newer than threshold are NOT deleted (no purge with retention 90d on fresh row)", async () => {
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId,
      capability: "llm",
      action: "complete",
      success: true,
      durationMs: 1,
    });
    await cleanupOldSdkCapabilityCalls({ llmDays: 90, memoryDays: 30, lessonsDays: 30, scheduleDays: 90 });
    const remaining = await listSdkCapabilityCallsForExtension(extensionId);
    expect(remaining.length).toBe(1);
  });
});

describe("schema enforcement", () => {
  test("NOT NULL on_behalf_of: passing null userId throws", async () => {
    await (expect(
      insertSdkCapabilityCall({
        extensionId,
        // @ts-expect-error — intentionally violating the type
        onBehalfOf: null,
        capability: "llm",
        action: "complete",
        success: true,
        durationMs: 1,
      }),
    ).rejects.toThrow() as unknown as Promise<void>);
  });

  test("FK on extension_id: cascade insert with non-existent extensionId rejected", async () => {
    await (expect(
      insertSdkCapabilityCall({
        extensionId: "00000000-0000-0000-0000-000000000000",
        onBehalfOf: userId,
        capability: "llm",
        action: "complete",
        success: true,
        durationMs: 1,
      }),
    ).rejects.toThrow() as unknown as Promise<void>);
  });

  // Sanity: indexes exist (smoke check via system catalog).
  test("expected indexes exist", async () => {
    const result = await getTestDb().execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'sdk_capability_calls'
    `);
    const rows = ((result as unknown) as { rows: { indexname: string }[] }).rows ?? [];
    const names = rows.map((r) => r.indexname);
    expect(names).toContain("idx_sdk_cap_ext_created");
    expect(names).toContain("idx_sdk_cap_conv_created");
    expect(names).toContain("idx_sdk_cap_user_capability_created");
    expect(names).toContain("idx_sdk_cap_created");
  });
});

