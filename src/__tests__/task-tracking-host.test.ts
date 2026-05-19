/**
 * Direct tests for src/runtime/task-tracking-host.ts — the single
 * server-side entry point for the task-tracking extension's storage
 * row. Exercised indirectly by the API-route tests (tasks-api,
 * tasks-assignment-api) and the IDOR suite, but this file covers the
 * helper's own behavior end-to-end against a real PGlite.
 *
 * Scenarios:
 *   - ID resolution is cached module-local after first lookup.
 *   - getTaskSnapshotForConversation reads both the new
 *     PersistedSnapshot shape (schemaVersion: 1) and the legacy shape
 *     (no version) without throwing.
 *   - writeTaskSnapshotForConversation round-trips + stamps
 *     schemaVersion: 1 on the written row.
 *   - deleteTaskSnapshotForConversation removes the row.
 *   - ensureTaskTrackingWired inserts the conversation_extensions
 *     row, is idempotent on a second call, and doesn't throw when
 *     the row already exists.
 *   - getTaskTrackingExtensionId throws when the extension is missing.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mock } from "bun:test";

mock.module("../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const {
  getTaskTrackingExtensionId,
  getTaskSnapshotForConversation,
  writeTaskSnapshotForConversation,
  deleteTaskSnapshotForConversation,
  ensureTaskTrackingWired,
  _resetTaskTrackingExtensionIdCache,
} = await import("../runtime/task-tracking-host");
const { getDb } = await import("../db/connection");
const {
  extensions: extensionsTable,
  conversations,
  conversationExtensions,
  projects,
  extensionStorage,
  users,
} = await import("../db/schema");

async function seedFixtures(): Promise<void> {
  await getDb().insert(users).values({
    id: "user-host-t",
    email: "host-test@t.local",
    passwordHash: "x",
    name: "HostTest",
  } as any).onConflictDoNothing();
  await getDb().insert(projects).values({
    id: "proj-host-t",
    name: "proj-host-t",
    path: "/tmp/proj-host-t",
  } as any).onConflictDoNothing();
}

async function seedTaskTrackingExtension(): Promise<string> {
  const id = "ext-tt-real";
  await getDb().insert(extensionsTable).values({
    id,
    name: "task-tracking",
    version: "1.0.0",
    description: "t",
    manifest: {
      schemaVersion: 2,
      name: "task-tracking",
      version: "1.0.0",
      description: "t",
      author: { name: "t" },
      permissions: {},
    },
    source: "test:tt",
    installPath: "/tmp/tt",
    enabled: true,
  } as any).onConflictDoNothing();
  return id;
}

async function seedConversation(id: string): Promise<void> {
  await getDb().insert(conversations).values({
    id, projectId: "proj-host-t", title: id,
  } as any).onConflictDoNothing();
}

beforeAll(async () => {
  await setupTestDb();
  await seedFixtures();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

beforeEach(() => {
  _resetTaskTrackingExtensionIdCache();
});

describe("getTaskTrackingExtensionId", () => {
  test("throws when the task-tracking extension is not installed", async () => {
    // No row yet — lookup must fail loudly. The error message points
    // at ensureBundledExtensions so a dev sees what's missing.
    await expect(getTaskTrackingExtensionId()).rejects.toThrow(/not installed/);
  });

  test("returns the DB row id once the extension exists", async () => {
    const id = await seedTaskTrackingExtension();
    const got = await getTaskTrackingExtensionId();
    expect(got).toBe(id);
  });

  test("caches the resolved id — second call doesn't re-query the DB", async () => {
    await seedTaskTrackingExtension();
    const first = await getTaskTrackingExtensionId();
    // Delete the row behind the cache's back; the next call must still
    // return the cached value.
    await getDb().delete(extensionsTable).where(
      (await import("drizzle-orm")).eq(extensionsTable.id, first),
    );
    const second = await getTaskTrackingExtensionId();
    expect(second).toBe(first);
    // Restore the row for subsequent tests.
    await seedTaskTrackingExtension();
  });

  test("_resetTaskTrackingExtensionIdCache forces a re-lookup", async () => {
    await seedTaskTrackingExtension();
    await getTaskTrackingExtensionId();
    _resetTaskTrackingExtensionIdCache();
    // After reset, the lookup path runs again — seed is in place, so
    // no throw.
    await expect(getTaskTrackingExtensionId()).resolves.toBe("ext-tt-real");
  });
});

describe("getTaskSnapshotForConversation", () => {
  test("returns undefined when no storage row exists", async () => {
    await seedTaskTrackingExtension();
    await seedConversation("conv-empty");
    const snap = await getTaskSnapshotForConversation("conv-empty");
    expect(snap).toBeUndefined();
  });

  test("reads the new PersistedSnapshot shape (with schemaVersion)", async () => {
    await seedTaskTrackingExtension();
    await seedConversation("conv-new");
    const extId = await getTaskTrackingExtensionId();
    const value = {
      tasks: [
        {
          id: "t1",
          title: "T",
          description: "",
          status: "active",
          assignments: [],
          subtasks: [],
          priority: 0,
          createdAt: new Date().toISOString(),
        },
      ],
      activeTaskId: "t1",
      schemaVersion: 1,
    };
    await getDb().insert(extensionStorage).values({
      extensionId: extId,
      scope: "conversation",
      scopeId: "conv-new",
      key: "tasks",
      value,
      encrypted: false,
      sizeBytes: Buffer.byteLength(JSON.stringify(value), "utf-8"),
    } as any);

    const snap = await getTaskSnapshotForConversation("conv-new");
    expect(snap).toBeDefined();
    expect(snap!.conversationId).toBe("conv-new");
    expect(snap!.tasks).toHaveLength(1);
    expect(snap!.activeTaskId).toBe("t1");
  });

  test("reads the legacy shape (no schemaVersion field) without throwing", async () => {
    await seedTaskTrackingExtension();
    await seedConversation("conv-legacy");
    const extId = await getTaskTrackingExtensionId();
    const value = {
      tasks: [
        {
          id: "legacy-t",
          title: "Legacy",
          description: "",
          status: "pending",
          assignments: [],
          subtasks: [],
          priority: 0,
          createdAt: new Date().toISOString(),
        },
      ],
      // activeTaskId omitted
    };
    await getDb().insert(extensionStorage).values({
      extensionId: extId,
      scope: "conversation",
      scopeId: "conv-legacy",
      key: "tasks",
      value,
      encrypted: false,
      sizeBytes: 0,
    } as any);

    const snap = await getTaskSnapshotForConversation("conv-legacy");
    expect(snap).toBeDefined();
    expect(snap!.tasks[0]!.id).toBe("legacy-t");
    expect(snap!.activeTaskId).toBeUndefined();
  });

  test("empty tasks array in the stored row materializes as []", async () => {
    await seedTaskTrackingExtension();
    await seedConversation("conv-zero");
    const extId = await getTaskTrackingExtensionId();
    await getDb().insert(extensionStorage).values({
      extensionId: extId,
      scope: "conversation",
      scopeId: "conv-zero",
      key: "tasks",
      value: { tasks: [], schemaVersion: 1 },
      encrypted: false,
      sizeBytes: 0,
    } as any);

    const snap = await getTaskSnapshotForConversation("conv-zero");
    expect(snap).toBeDefined();
    expect(snap!.tasks).toEqual([]);
  });
});

describe("writeTaskSnapshotForConversation", () => {
  test("round-trips a snapshot with schemaVersion stamped on the row", async () => {
    await seedTaskTrackingExtension();
    await seedConversation("conv-rt");
    const now = new Date().toISOString();
    await writeTaskSnapshotForConversation("conv-rt", {
      tasks: [
        {
          id: "rt-1",
          title: "Round-tripped",
          description: "",
          status: "active",
          assignments: [],
          subtasks: [],
          priority: 0,
          createdAt: now,
        },
      ],
      activeTaskId: "rt-1",
    });

    const snap = await getTaskSnapshotForConversation("conv-rt");
    expect(snap).toBeDefined();
    expect(snap!.tasks[0]!.id).toBe("rt-1");
    expect(snap!.activeTaskId).toBe("rt-1");

    // Verify schemaVersion was written by peeking at the raw row.
    const extId = await getTaskTrackingExtensionId();
    const { getStorageValue } = await import("../db/queries/extension-storage");
    const raw = await getStorageValue(extId, "conversation", "conv-rt", "tasks");
    expect((raw?.value as { schemaVersion: number }).schemaVersion).toBe(1);
  });

  test("writing twice overwrites (upsert semantics)", async () => {
    await seedTaskTrackingExtension();
    await seedConversation("conv-ov");
    await writeTaskSnapshotForConversation("conv-ov", {
      tasks: [
        { id: "a", title: "A", description: "", status: "pending", assignments: [], subtasks: [], priority: 0, createdAt: new Date().toISOString() },
      ],
    });
    await writeTaskSnapshotForConversation("conv-ov", {
      tasks: [
        { id: "b", title: "B", description: "", status: "pending", assignments: [], subtasks: [], priority: 0, createdAt: new Date().toISOString() },
      ],
    });
    const snap = await getTaskSnapshotForConversation("conv-ov");
    expect(snap!.tasks).toHaveLength(1);
    expect(snap!.tasks[0]!.id).toBe("b");
  });

  test("write without activeTaskId omits the field in storage", async () => {
    await seedTaskTrackingExtension();
    await seedConversation("conv-no-active");
    await writeTaskSnapshotForConversation("conv-no-active", { tasks: [] });
    const snap = await getTaskSnapshotForConversation("conv-no-active");
    expect(snap).toBeDefined();
    expect(snap!.activeTaskId).toBeUndefined();
  });
});

describe("deleteTaskSnapshotForConversation", () => {
  test("removes the row and subsequent reads return undefined", async () => {
    await seedTaskTrackingExtension();
    await seedConversation("conv-del");
    await writeTaskSnapshotForConversation("conv-del", { tasks: [] });
    expect(await getTaskSnapshotForConversation("conv-del")).toBeDefined();

    const result = await deleteTaskSnapshotForConversation("conv-del");
    expect(result).toBe(true);
    expect(await getTaskSnapshotForConversation("conv-del")).toBeUndefined();
  });

  test("delete on a missing row returns false", async () => {
    await seedTaskTrackingExtension();
    const result = await deleteTaskSnapshotForConversation("never-existed");
    expect(result).toBe(false);
  });
});

describe("ensureTaskTrackingWired", () => {
  test("inserts a conversation_extensions row for (conv, task-tracking)", async () => {
    const extId = await seedTaskTrackingExtension();
    await seedConversation("conv-wire-1");
    await ensureTaskTrackingWired("conv-wire-1");

    const { eq, and } = await import("drizzle-orm");
    const rows = await getDb()
      .select()
      .from(conversationExtensions)
      .where(
        and(
          eq(conversationExtensions.conversationId, "conv-wire-1"),
          eq(conversationExtensions.extensionId, extId),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  test("second call is a no-op — UNIQUE(conv, ext) is respected", async () => {
    const extId = await seedTaskTrackingExtension();
    await seedConversation("conv-wire-2");
    await ensureTaskTrackingWired("conv-wire-2");
    await ensureTaskTrackingWired("conv-wire-2");

    const { eq, and } = await import("drizzle-orm");
    const rows = await getDb()
      .select()
      .from(conversationExtensions)
      .where(
        and(
          eq(conversationExtensions.conversationId, "conv-wire-2"),
          eq(conversationExtensions.extensionId, extId),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
