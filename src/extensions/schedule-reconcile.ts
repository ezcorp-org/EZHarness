/**
 * Schedule reconciler. On extension install/update, mirror
 * `manifest.permissions.schedule.crons[]` into `extension_schedules`
 * non-destructively:
 *   - New crons → fresh rows (`enabled: true`, `next_fire_at` from
 *     parser).
 *   - Removed crons → soft-disable (`enabled: false`); preserve row
 *     so `extension_schedule_fires` history stays intact.
 *   - Existing crons → no-op (preserves `next_fire_at`,
 *     `last_fire_at`, etc.).
 *
 * DYNAMIC ROWS ARE NOT THIS FUNCTION'S BUSINESS (C2). The manifest is the
 * source of truth for MANIFEST rows only. A dynamic row (`ctx.triggers`) is
 * by construction absent from the manifest, so every query below filters on
 * `dynamic = false` — the snapshot, the sweep, and the disable-all branch
 * alike. Without that filter, the first user-created job would be silently
 * disabled by the next install, update, or permission change: the row
 * survives, its history survives, and it simply stops firing.
 */
import { logger } from "../logger";
import { getDb } from "../db/connection";
import type { Database, DbTransaction } from "../db/connection";
import { extensionSchedules, type ExtensionSchedule } from "../db/schema";
import { eq, and, notInArray } from "drizzle-orm";
import { parseCron, validateCron } from "./cron";

const log = logger.child("ext.schedule-reconcile");

export async function reconcileSchedules(
  extensionId: string,
  manifestCrons: string[],
  now: () => Date = () => new Date(),
  database?: Database | DbTransaction,
): Promise<{ added: number; disabled: number; preserved: number }> {
  const valid = manifestCrons.filter((c) => validateCron(c).ok).slice(0, 8);
  const db = database ?? getDb();

  // MANIFEST rows only — see the module header. This snapshot feeds both
  // the re-enable map and the `disabled` count, so filtering here is what
  // keeps a dynamic row out of BOTH.
  const existing: ExtensionSchedule[] = await db.select().from(extensionSchedules)
    .where(and(
      eq(extensionSchedules.extensionId, extensionId),
      eq(extensionSchedules.dynamic, false),
    ));
  const existingByCron = new Map<string, ExtensionSchedule>(
    existing.map((row) => [row.cron, row] as const),
  );
  const validSet = new Set(valid);

  let added = 0, preserved = 0;
  // Deterministic `disabled` count from the pre-fetch snapshot, mirroring
  // reconcileWebhooks. The previous `rowCount` read is unreliable on PGlite
  // (it is why the webhook reconciler counts this way), and a dynamic row
  // must be excluded from the count as well as from the UPDATE — otherwise
  // the audited number lies even once the disable itself is correct. This
  // set is disjoint from the re-enable loop below, which only touches crons
  // IN `valid`.
  const disabled = existing.filter((row) => row.enabled && !validSet.has(row.cron)).length;

  // Add new crons.
  for (const cron of valid) {
    const cur = existingByCron.get(cron);
    if (cur) {
      if (!cur.enabled) {
        await db.update(extensionSchedules).set({ enabled: true, updatedAt: new Date() })
          .where(eq(extensionSchedules.id, cur.id));
      }
      preserved++;
    } else {
      const nextFireAt = parseCron(cron).next(now());
      await db.insert(extensionSchedules).values({
        extensionId, cron, nextFireAt, enabled: true,
      });
      added++;
    }
  }

  // Soft-disable removed crons. `dynamic = false` on both branches: a
  // user-created row is never "removed from the manifest" because it was
  // never in it.
  if (valid.length > 0) {
    await db.update(extensionSchedules)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(
        eq(extensionSchedules.extensionId, extensionId),
        eq(extensionSchedules.dynamic, false),
        notInArray(extensionSchedules.cron, valid),
        eq(extensionSchedules.enabled, true),
      ));
  } else if (existing.length > 0) {
    // Manifest declared no crons — disable all the MANIFEST ones.
    await db.update(extensionSchedules)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(
        eq(extensionSchedules.extensionId, extensionId),
        eq(extensionSchedules.dynamic, false),
        eq(extensionSchedules.enabled, true),
      ));
  }

  log.debug("reconciled", { extensionId, added, disabled, preserved, totalManifest: valid.length });
  return { added, disabled, preserved };
}

/** Test-only helper to fully wipe an extension's schedules. */
export async function _wipeSchedulesForTests(extensionId: string): Promise<void> {
  const db = getDb();
  await db.delete(extensionSchedules).where(eq(extensionSchedules.extensionId, extensionId));
}
