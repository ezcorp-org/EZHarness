/**
 * Tests for src/extensions/migrations/task-tracking-storage.ts — the
 * one-shot migration that rehomes `extensionId = "builtin"` rows
 * written by the old built-in task-tracking module to the bundled
 * extension's real DB id.
 *
 * Scenarios:
 *   - No-op when there are no "builtin" rows.
 *   - Happy path rewrites every conversation's row under the real
 *     ext id AND writes a __tasks_pre_migration backup + deletes the
 *     original "builtin" row.
 *   - The sentinel is written after a successful run.
 *   - Sentinel presence short-circuits subsequent runs (idempotency).
 *   - Errors during migration don't throw — they're swallowed and
 *     logged so boot isn't blocked.
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

const { migrateBuiltinTaskStorage } = await import(
  "../extensions/migrations/task-tracking-storage"
);
const { getDb } = await import("../db/connection");
const {
  extensions: extensionsTable,
  conversations,
  extensionStorage,
  projects,
  users,
} = await import("../db/schema");
const { getStorageValue } = await import("../db/queries/extension-storage");

const REAL_EXT_ID = "ext-tt-mig";
const BUILTIN_EXT_ID = "builtin";

async function seedFixtures(): Promise<void> {
  await getDb().insert(users).values({
    id: "user-mig-t",
    email: "mig@t.local",
    passwordHash: "x",
    name: "MigTest",
  } as any).onConflictDoNothing();
  await getDb().insert(projects).values({
    id: "proj-mig-t",
    name: "proj-mig-t",
    path: "/tmp/proj-mig-t",
  } as any).onConflictDoNothing();
  await getDb().insert(extensionsTable).values({
    id: REAL_EXT_ID,
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
}

async function seedConversation(id: string): Promise<void> {
  await getDb().insert(conversations).values({
    id, projectId: "proj-mig-t", title: id,
  } as any).onConflictDoNothing();
}

async function wipeStorage(): Promise<void> {
  await getDb().delete(extensionStorage);
}

async function seedBuiltinRow(convId: string, value: unknown): Promise<void> {
  await getDb().insert(extensionStorage).values({
    extensionId: BUILTIN_EXT_ID,
    scope: "conversation",
    scopeId: convId,
    key: "__tasks",
    value,
    encrypted: false,
    sizeBytes: Buffer.byteLength(JSON.stringify(value), "utf-8"),
  } as any);
}

beforeAll(async () => {
  await setupTestDb();
  await seedFixtures();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

beforeEach(async () => {
  await wipeStorage();
});

describe("migrateBuiltinTaskStorage", () => {
  test("no-op when there are no 'builtin' rows to migrate (still writes sentinel)", async () => {
    await migrateBuiltinTaskStorage(REAL_EXT_ID);
    // No rows moved, but the sentinel should be present so next boots
    // short-circuit.
    const sentinel = await getStorageValue(
      REAL_EXT_ID, "global", null, "__task_tracking_migration_done",
    );
    expect(sentinel).toBeDefined();
    expect((sentinel!.value as { migratedRowCount: number }).migratedRowCount).toBe(0);
  });

  test("happy path: rehomes rows, writes backups, deletes originals", async () => {
    await seedConversation("conv-mig-1");
    await seedConversation("conv-mig-2");
    const snap1 = {
      tasks: [{ id: "t1", title: "T1", status: "active" }],
      activeTaskId: "t1",
    };
    const snap2 = {
      tasks: [{ id: "t2", title: "T2", status: "pending" }],
    };
    await seedBuiltinRow("conv-mig-1", snap1);
    await seedBuiltinRow("conv-mig-2", snap2);

    await migrateBuiltinTaskStorage(REAL_EXT_ID);

    // Live rows now under REAL_EXT_ID at the new un-prefixed key.
    const live1 = await getStorageValue(REAL_EXT_ID, "conversation", "conv-mig-1", "tasks");
    const live2 = await getStorageValue(REAL_EXT_ID, "conversation", "conv-mig-2", "tasks");
    expect(live1?.value).toEqual(snap1);
    expect(live2?.value).toEqual(snap2);

    // Backup rows mirror the originals.
    const backup1 = await getStorageValue(REAL_EXT_ID, "conversation", "conv-mig-1", "__tasks_pre_migration");
    const backup2 = await getStorageValue(REAL_EXT_ID, "conversation", "conv-mig-2", "__tasks_pre_migration");
    expect(backup1?.value).toEqual(snap1);
    expect(backup2?.value).toEqual(snap2);

    // Original "builtin" rows are gone.
    const orig1 = await getStorageValue(BUILTIN_EXT_ID, "conversation", "conv-mig-1", "__tasks");
    const orig2 = await getStorageValue(BUILTIN_EXT_ID, "conversation", "conv-mig-2", "__tasks");
    expect(orig1).toBeNull();
    expect(orig2).toBeNull();
  });

  test("sentinel short-circuits subsequent runs — rows written after don't move", async () => {
    await migrateBuiltinTaskStorage(REAL_EXT_ID);
    // Add a NEW "builtin" row AFTER the sentinel is already set.
    await seedConversation("conv-late");
    await seedBuiltinRow("conv-late", { tasks: [{ id: "late", title: "Late", status: "pending" }] });

    // Second call should skip without touching the new row.
    await migrateBuiltinTaskStorage(REAL_EXT_ID);

    const orig = await getStorageValue(BUILTIN_EXT_ID, "conversation", "conv-late", "__tasks");
    expect(orig).toBeDefined();
    // The sentinel short-circuited, so no rehome happened for the late row.
    const moved = await getStorageValue(REAL_EXT_ID, "conversation", "conv-late", "tasks");
    expect(moved).toBeNull();
  });

  test("sentinel row count reflects rehomed conversations", async () => {
    await seedConversation("conv-count-1");
    await seedConversation("conv-count-2");
    await seedConversation("conv-count-3");
    await seedBuiltinRow("conv-count-1", { tasks: [] });
    await seedBuiltinRow("conv-count-2", { tasks: [] });
    await seedBuiltinRow("conv-count-3", { tasks: [] });

    await migrateBuiltinTaskStorage(REAL_EXT_ID);

    const sentinel = await getStorageValue(
      REAL_EXT_ID, "global", null, "__task_tracking_migration_done",
    );
    expect((sentinel!.value as { migratedRowCount: number }).migratedRowCount).toBe(3);
  });

  test("migration does NOT throw when the extension id is bogus — logs + continues", async () => {
    // Passing a nonexistent extension id would normally be a bug, but
    // the migration is explicitly fail-safe. It must not block boot.
    await seedConversation("conv-bogus");
    await seedBuiltinRow("conv-bogus", { tasks: [{ id: "b", title: "B", status: "pending" }] });
    // The setStorageValue call would fail FK if the target ext doesn't
    // exist — but the migration catches and logs. We assert the call
    // itself doesn't throw.
    await expect(migrateBuiltinTaskStorage("ext-does-not-exist")).resolves.toBeUndefined();
  });
});
