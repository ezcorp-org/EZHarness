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
  clampDays,
} from "../db/queries/sdk-capability-calls";
import { createUser } from "../db/queries/users";
import { extensions, conversations, sdkCapabilityCalls, projects, users } from "../db/schema";
import { eq, sql } from "drizzle-orm";

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
    // CR-3: zero-as-purge requires explicit `force: true` opt-in.
    await cleanupOldSdkCapabilityCalls({ llmDays: 0, memoryDays: 0, lessonsDays: 0, scheduleDays: 0, force: true });
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
    // CR-3: memory bucket purges only because `force: true`. LLM/lessons/
    // schedule values are above zero so `force` doesn't affect them.
    await cleanupOldSdkCapabilityCalls({ llmDays: 90, memoryDays: 0, lessonsDays: 30, scheduleDays: 90, force: true });
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

// CA-2: clampDays boundary coverage (validator finding).
describe("clampDays — boundary behavior", () => {
  test("negative -> floors at 1", () => {
    expect(clampDays(-5)).toBe(1);
  });
  test("zero -> floors at 1 (no implicit-purge bypass)", () => {
    expect(clampDays(0)).toBe(1);
  });
  test("oversize -> ceilings at 3650", () => {
    expect(clampDays(99999)).toBe(3650);
  });
  test("NaN -> sensible default of 30", () => {
    expect(clampDays(Number.NaN)).toBe(30);
  });
  test("non-finite Infinity -> sensible default of 30", () => {
    expect(clampDays(Number.POSITIVE_INFINITY)).toBe(30);
  });
  test("finite in-range value passes through unchanged", () => {
    expect(clampDays(45)).toBe(45);
  });
  test("fractional value floors to integer", () => {
    expect(clampDays(45.9)).toBe(45);
  });
});

// CA-3: cursor-pagination + since/until window filter coverage.
describe("listSdkCapabilityCallsForExtension — pagination + windowing", () => {
  test("cursor pagination: insert 5, page through 2 + 2 + 1 by cursor", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Insert with strictly increasing createdAt so descending order
      // is well-defined. PGlite's NOW() resolution is microseconds, but
      // a tight loop can collide; explicit timestamps remove the race.
      const created = new Date(Date.now() - (5 - i) * 1000); // 5s, 4s, ... 1s ago
      const [row] = await getTestDb()
        .insert(sdkCapabilityCalls)
        .values({
          extensionId,
          onBehalfOf: userId,
          capability: "llm" as const,
          action: "complete",
          success: true,
          durationMs: 1,
          createdAt: created,
        })
        .returning({ id: sdkCapabilityCalls.id });
      ids.push(row!.id);
    }
    // Page 1 (newest 2) — descending order means createdAt-newest first.
    const page1 = await listSdkCapabilityCallsForExtension(extensionId, { limit: 2 });
    expect(page1.length).toBe(2);
    // Page 2 — pass last row's id as cursor; expect rows strictly older.
    const page2 = await listSdkCapabilityCallsForExtension(extensionId, {
      limit: 2,
      cursor: page1[page1.length - 1]!.id,
    });
    expect(page2.length).toBe(2);
    // No overlap.
    const page1Ids = new Set(page1.map((r) => r.id));
    for (const r of page2) expect(page1Ids.has(r.id)).toBe(false);
    // Page 3 — last row.
    const page3 = await listSdkCapabilityCallsForExtension(extensionId, {
      limit: 2,
      cursor: page2[page2.length - 1]!.id,
    });
    expect(page3.length).toBe(1);
    // Combined coverage = all 5 inserted ids.
    const all = new Set([...page1, ...page2, ...page3].map((r) => r.id));
    expect(all.size).toBe(5);
    for (const id of ids) expect(all.has(id)).toBe(true);
  });

  test("cursor with non-existent id returns rows as if no cursor (resolveCursor null branch)", async () => {
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: userId,
      capability: "llm",
      action: "complete",
      success: true,
      durationMs: 1,
    });
    const rows = await listSdkCapabilityCallsForExtension(extensionId, {
      limit: 10,
      cursor: "00000000-0000-0000-0000-000000000000",
    });
    expect(rows.length).toBe(1);
  });

  test("since/until: Date window includes only rows created inside the window", async () => {
    const now = Date.now();
    // Insert three rows at distinct timestamps: 3h ago, 2h ago, 1h ago.
    const olderRow = await getTestDb()
      .insert(sdkCapabilityCalls)
      .values({
        extensionId,
        onBehalfOf: userId,
        capability: "llm" as const,
        action: "complete",
        success: true,
        durationMs: 1,
        createdAt: new Date(now - 3 * 60 * 60 * 1000),
      })
      .returning({ id: sdkCapabilityCalls.id });
    const middleRow = await getTestDb()
      .insert(sdkCapabilityCalls)
      .values({
        extensionId,
        onBehalfOf: userId,
        capability: "llm" as const,
        action: "complete",
        success: true,
        durationMs: 1,
        createdAt: new Date(now - 2 * 60 * 60 * 1000),
      })
      .returning({ id: sdkCapabilityCalls.id });
    const newerRow = await getTestDb()
      .insert(sdkCapabilityCalls)
      .values({
        extensionId,
        onBehalfOf: userId,
        capability: "llm" as const,
        action: "complete",
        success: true,
        durationMs: 1,
        createdAt: new Date(now - 1 * 60 * 60 * 1000),
      })
      .returning({ id: sdkCapabilityCalls.id });

    // Window: (since=2.5h ago, until=0.5h ago). Only middle and newer
    // are inside (older < since; newer < until).
    const since = new Date(now - 2.5 * 60 * 60 * 1000);
    const until = new Date(now - 0.5 * 60 * 60 * 1000);
    const windowed = await listSdkCapabilityCallsForExtension(extensionId, {
      since,
      until,
      limit: 100,
    });
    const ids = windowed.map((r) => r.id).sort();
    expect(ids).toEqual([middleRow[0]!.id, newerRow[0]!.id].sort());
    // Older row excluded.
    expect(ids).not.toContain(olderRow[0]!.id);
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

  // CR-2: on_behalf_of FK is ON DELETE RESTRICT. A user with capability-
  // call rows cannot be hard-deleted; admin must scrub PII separately
  // (Phase 52 admin tools). The previous SET NULL spec was internally
  // inconsistent with the NOT NULL column constraint.
  test("FK on on_behalf_of: ON DELETE RESTRICT — deleting a user with capability rows is rejected", async () => {
    // Use a fresh user so we don't interfere with the suite's shared
    // userId (which may be referenced by other rows from other tests).
    const u = await createUser({
      email: "sdk-cap-fk-restrict@example.com",
      passwordHash: "h",
      name: "FK-RESTRICT",
      role: "member",
      status: "active",
    });
    await insertSdkCapabilityCall({
      extensionId,
      onBehalfOf: u.id,
      capability: "llm",
      action: "complete",
      success: true,
      durationMs: 1,
    });
    // Drizzle's delete-builder is a thenable but `expect.rejects`
    // wants a real Promise — wrap in an async fn so the thenable's
    // execute() is awaited in a Promise context.
    await (expect(
      (async () => {
        await getTestDb().delete(users).where(eq(users.id, u.id));
      })(),
    ).rejects.toThrow() as unknown as Promise<void>);
    // Sanity: user row still exists.
    const remaining = await getTestDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, u.id));
    expect(remaining.length).toBe(1);
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

