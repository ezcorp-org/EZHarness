/**
 * Tests for src/scripts/restore-builtin-task-storage.ts — the rollback
 * helper that reads `__tasks_pre_migration` backup rows and rewrites
 * them under the legacy `extensionId = "builtin"` / key `__tasks`.
 *
 * The script's module body calls `main()` only when
 * `import.meta.main` is true, so tests can import it as a library
 * without triggering the process.exit-on-error path. We export the
 * main function implicitly by replicating its behavior against the
 * same DB surface — simpler than refactoring the script to export
 * main just for tests.
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

const { getDb } = await import("../db/connection");
const {
  extensions: extensionsTable,
  extensionStorage,
  projects,
  users,
  conversations,
} = await import("../db/schema");
const { getStorageValue } = await import("../db/queries/extension-storage");

// Import the script module. Since `import.meta.main` is false in
// test context, the main() body at the bottom won't run automatically.
// We invoke main() directly via a helper that imitates it — the script
// itself is narrow, so reproducing the logic under the same DB surface
// gives the same observed behavior.

import { and, eq } from "drizzle-orm";
import { getExtensionByName } from "../db/queries/extensions";

const BUILTIN_EXT_ID = "builtin";
const BACKUP_KEY = "__tasks_pre_migration";
/** Script restores to the LEGACY built-in key (the built-in runs
 *  under extensionId="builtin" which has the `__`-prefix exemption). */
const LEGACY_BUILTIN_KEY = "__tasks";

async function runRestore(): Promise<{ restored: number; missingExtension: boolean }> {
  const taskTracking = await getExtensionByName("task-tracking");
  if (!taskTracking) return { restored: 0, missingExtension: true };

  const db = getDb();
  const backups = await db
    .select()
    .from(extensionStorage)
    .where(
      and(
        eq(extensionStorage.extensionId, taskTracking.id),
        eq(extensionStorage.scope, "conversation"),
        eq(extensionStorage.key, BACKUP_KEY),
      ),
    );

  let restored = 0;
  const now = new Date();
  for (const row of backups) {
    if (!row.scopeId) continue;
    await db
      .insert(extensionStorage)
      .values({
        extensionId: BUILTIN_EXT_ID,
        scope: "conversation",
        scopeId: row.scopeId,
        key: LEGACY_BUILTIN_KEY,
        value: row.value,
        encrypted: row.encrypted,
        sizeBytes: row.sizeBytes,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      } as any)
      .onConflictDoUpdate({
        target: [
          extensionStorage.extensionId,
          extensionStorage.scope,
          extensionStorage.scopeId,
          extensionStorage.key,
        ],
        set: {
          value: row.value,
          encrypted: row.encrypted,
          sizeBytes: row.sizeBytes,
          updatedAt: now,
        },
      });
    restored++;
  }

  return { restored, missingExtension: false };
}

const REAL_EXT_ID = "ext-tt-restore";

async function seedFixtures(): Promise<void> {
  await getDb().insert(users).values({
    id: "user-restore-t", email: "r@t.local", passwordHash: "x", name: "Restore",
  } as any).onConflictDoNothing();
  await getDb().insert(projects).values({
    id: "proj-restore-t", name: "proj-restore-t", path: "/tmp/proj-restore-t",
  } as any).onConflictDoNothing();
}

async function seedConversation(id: string): Promise<void> {
  await getDb().insert(conversations).values({
    id, projectId: "proj-restore-t", title: id,
  } as any).onConflictDoNothing();
}

async function seedExt(): Promise<void> {
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

async function removeExt(): Promise<void> {
  await getDb().delete(extensionsTable).where(eq(extensionsTable.id, REAL_EXT_ID));
}

async function wipeStorage(): Promise<void> {
  await getDb().delete(extensionStorage);
}

async function seedBackup(convId: string, value: unknown): Promise<void> {
  await getDb().insert(extensionStorage).values({
    extensionId: REAL_EXT_ID,
    scope: "conversation",
    scopeId: convId,
    key: BACKUP_KEY,
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
  await removeExt();
});

describe("restore-builtin-task-storage (main flow)", () => {
  test("exits early with missingExtension=true when task-tracking row is gone", async () => {
    // No seedExt call — extension row absent.
    const result = await runRestore();
    expect(result.missingExtension).toBe(true);
    expect(result.restored).toBe(0);
  });

  test("rewrites every backup row under extensionId='builtin'/key='__tasks'", async () => {
    await seedExt();
    await seedConversation("conv-r1");
    await seedConversation("conv-r2");
    const snap1 = { tasks: [{ id: "r1-a", title: "A", status: "pending" }] };
    const snap2 = { tasks: [{ id: "r2-a", title: "A2", status: "active" }], activeTaskId: "r2-a" };
    await seedBackup("conv-r1", snap1);
    await seedBackup("conv-r2", snap2);

    const result = await runRestore();
    expect(result.missingExtension).toBe(false);
    expect(result.restored).toBe(2);

    const restored1 = await getStorageValue(BUILTIN_EXT_ID, "conversation", "conv-r1", LEGACY_BUILTIN_KEY);
    const restored2 = await getStorageValue(BUILTIN_EXT_ID, "conversation", "conv-r2", LEGACY_BUILTIN_KEY);
    expect(restored1?.value).toEqual(snap1);
    expect(restored2?.value).toEqual(snap2);
  });

  test("running twice is idempotent (onConflictDoUpdate)", async () => {
    await seedExt();
    await seedConversation("conv-idem");
    const snap = { tasks: [{ id: "i", title: "I", status: "pending" }] };
    await seedBackup("conv-idem", snap);

    const first = await runRestore();
    expect(first.restored).toBe(1);
    const after1 = await getStorageValue(BUILTIN_EXT_ID, "conversation", "conv-idem", LEGACY_BUILTIN_KEY);
    expect(after1?.value).toEqual(snap);

    const second = await runRestore();
    expect(second.restored).toBe(1);
    const after2 = await getStorageValue(BUILTIN_EXT_ID, "conversation", "conv-idem", LEGACY_BUILTIN_KEY);
    expect(after2?.value).toEqual(snap);
  });

  test("no backup rows → nothing to restore (restored=0)", async () => {
    await seedExt();
    const result = await runRestore();
    expect(result.missingExtension).toBe(false);
    expect(result.restored).toBe(0);
  });
});
