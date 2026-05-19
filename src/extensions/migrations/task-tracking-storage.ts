// One-shot migration for Phase 3 commit-5: move extension_storage rows
// written by the built-in under the synthetic `extensionId = "builtin"`
// to the real DB id assigned to the bundled `task-tracking` extension.
//
// Called from ensureBundledExtensions() AFTER the task-tracking row is
// created so the migration has a destination extension_id to write to.
// Gated by a sentinel row in extension_storage itself (global scope,
// key `__task_tracking_migration_done`) to make it strictly idempotent.
//
// On every boot we:
//   1. If the sentinel is present → return immediately (hot path).
//   2. Otherwise, walk all "builtin" / "conversation" / "__tasks" rows.
//      For each row we write:
//        a. A backup row under the real extension id with key
//           `__tasks_pre_migration` carrying the old value verbatim
//           (retained for rollback — see §Rollback in the phase-3 plan).
//        b. The same value under `__tasks` (the live key the extension
//           reads from).
//      Then delete the original "builtin" row.
//   3. Write the sentinel to make step 1 fast next time.
//
// Failure mode: exceptions are caught and logged. The original rows
// are untouched if step 2 throws mid-way (so re-running the migration
// replays from where it left off). Worst case: the sentinel never
// writes and we do redundant work on subsequent boots — annoying but
// not destructive.

import { getDb } from "../../db/connection";
import { extensionStorage } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import { getStorageValue, setStorageValue } from "../../db/queries/extension-storage";
import { logger } from "../../logger";

const log = logger.child("task-tracking-migration");

const BUILTIN_EXT_ID = "builtin";
const SCOPE: "conversation" = "conversation";
/** The built-in used "__tasks" (reserved-prefix exemption for
 *  extensionId="builtin"). The bundled extension must write under an
 *  un-prefixed key because the storage-handler rejects "__" for
 *  non-builtin extensions. */
const SOURCE_KEY = "__tasks";
const LIVE_KEY = "tasks";
/** Sentinel + backup rows live under the bundled extension id. They
 *  bypass the prefix rule because the storage-handler has a separate
 *  exemption for "__" keys written via the internal helper path.
 *  Migration writes directly via setStorageValue (DB layer), not the
 *  RPC path, so the handler's key validation doesn't run. */
const BACKUP_KEY = "__tasks_pre_migration";
const SENTINEL_KEY = "__task_tracking_migration_done";

export async function migrateBuiltinTaskStorage(
  taskTrackingExtId: string,
): Promise<void> {
  try {
    // Sentinel check — stored under the real extension id, global scope.
    const sentinel = await getStorageValue(
      taskTrackingExtId,
      "global",
      null,
      SENTINEL_KEY,
    );
    if (sentinel?.value) {
      return;
    }

    const db = getDb();
    const rows = await db
      .select()
      .from(extensionStorage)
      .where(
        and(
          eq(extensionStorage.extensionId, BUILTIN_EXT_ID),
          eq(extensionStorage.scope, SCOPE),
          eq(extensionStorage.key, SOURCE_KEY),
        ),
      );

    if (rows.length > 0) {
      log.info("Migrating built-in task-tracking storage rows", {
        count: rows.length,
        fromExtensionId: BUILTIN_EXT_ID,
        toExtensionId: taskTrackingExtId,
      });
    }

    for (const row of rows) {
      if (!row.scopeId) continue;
      const value = row.value;
      const sizeBytes = row.sizeBytes;
      // Backup copy (for rollback) — one write per conversation.
      await setStorageValue(
        taskTrackingExtId,
        SCOPE,
        row.scopeId,
        BACKUP_KEY,
        value,
        row.encrypted,
        sizeBytes,
      );
      // Live copy under the real extension id.
      await setStorageValue(
        taskTrackingExtId,
        SCOPE,
        row.scopeId,
        LIVE_KEY,
        value,
        row.encrypted,
        sizeBytes,
      );
      // Drop the original "builtin" row — it's dead weight after
      // migration and will confuse drift detectors if left in place.
      await db
        .delete(extensionStorage)
        .where(eq(extensionStorage.id, row.id));
    }

    // Sentinel write — makes subsequent boots fast-path skip.
    await setStorageValue(
      taskTrackingExtId,
      "global",
      null,
      SENTINEL_KEY,
      { migratedAt: new Date().toISOString(), migratedRowCount: rows.length },
      false,
      64,
    );
  } catch (err) {
    // Migration errors must NOT block boot — the task panel will
    // simply appear empty for users who had tasks under the old id.
    // Log and move on; next boot retries.
    log.error("Task-tracking storage migration failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
