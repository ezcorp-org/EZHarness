#!/usr/bin/env bun
/**
 * Rollback helper for Phase 3 commit-5.
 *
 * The task-tracking storage migration (see
 * src/extensions/migrations/task-tracking-storage.ts) rehomes every
 * conversation's `__tasks` row from `extensionId = "builtin"` to the
 * real bundled extension id and deletes the original "builtin" rows.
 * It writes a backup row under the key `__tasks_pre_migration`
 * alongside the live row so the data isn't lost.
 *
 * If we need to revert Phase 3 commit-5, the built-in path reads from
 * `extensionId = "builtin"` / `key = "__tasks"` — rows which no longer
 * exist. This script rewrites those rows from the migration's backup
 * copies so the restored built-in sees the user's tasks on next boot.
 *
 * Usage (after flipping EZCORP_DISABLE_CAPABILITY_TOOLS=1 and reverting
 * the merge commit that landed Phase 3):
 *
 *   bun src/scripts/restore-builtin-task-storage.ts
 *
 * Idempotent: writes the restored rows with `onConflictDoUpdate`, so a
 * second run is a no-op (the backup value and the re-written live
 * value are structurally identical).
 *
 * Failure mode: if the task-tracking extension row is already deleted
 * (the revert removed it before this script ran), no backup rows are
 * reachable via `extensionId = task-tracking-id`. Exit code 2 with a
 * message so the operator can spot the gap.
 */

import { getDb } from "../db/connection";
import { extensionStorage } from "../db/schema";
import { getExtensionByName } from "../db/queries/extensions";
import { and, eq } from "drizzle-orm";

const BUILTIN_EXT_ID = "builtin";
/** Backup rows written by migrate-builtin-task-storage. */
const BACKUP_KEY = "__tasks_pre_migration";
/** The key the OLD built-in read from — storage-handler permits `__`
 *  prefix for extensionId="builtin", so we restore to that key. */
const LEGACY_BUILTIN_KEY = "__tasks";

async function main(): Promise<void> {
  const taskTracking = await getExtensionByName("task-tracking");
  if (!taskTracking) {
    console.error(
      "[restore-builtin-task-storage] task-tracking extension row not found in DB. " +
        "The Phase 3 extension may have been deleted already — backup rows are " +
        "unreachable without the extension's DB id.",
    );
    process.exit(2);
  }

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

  console.log(
    `[restore-builtin-task-storage] Found ${backups.length} backup row(s). ` +
      `Restoring "${BUILTIN_EXT_ID}" / "${LEGACY_BUILTIN_KEY}" entries...`,
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
      })
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

  console.log(
    `[restore-builtin-task-storage] Restored ${restored} conversation(s). ` +
      `Re-enable the built-in path and boot normally — task-tracking tools will ` +
      `load from the restored rows.`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[restore-builtin-task-storage] Fatal:", err);
    process.exit(1);
  });
}
