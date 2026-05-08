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
 */
import { logger } from "../logger";
import { getDb } from "../db/connection";
import { extensionSchedules, type ExtensionSchedule } from "../db/schema";
import { eq, and, notInArray } from "drizzle-orm";
import { parseCron, validateCron } from "./cron";

const log = logger.child("ext.schedule-reconcile");

export async function reconcileSchedules(
  extensionId: string,
  manifestCrons: string[],
  now: () => Date = () => new Date(),
): Promise<{ added: number; disabled: number; preserved: number }> {
  const valid = manifestCrons.filter((c) => validateCron(c).ok).slice(0, 8);
  const db = getDb();

  const existing: ExtensionSchedule[] = await db.select().from(extensionSchedules)
    .where(eq(extensionSchedules.extensionId, extensionId));
  const existingByCron = new Map<string, ExtensionSchedule>(
    existing.map((row) => [row.cron, row] as const),
  );

  let added = 0, disabled = 0, preserved = 0;

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

  // Soft-disable removed crons.
  if (valid.length > 0) {
    const result = await db.update(extensionSchedules)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(
        eq(extensionSchedules.extensionId, extensionId),
        notInArray(extensionSchedules.cron, valid),
        eq(extensionSchedules.enabled, true),
      ));
    disabled = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  } else if (existing.length > 0) {
    // Manifest declared no crons — disable them all.
    const result = await db.update(extensionSchedules)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(
        eq(extensionSchedules.extensionId, extensionId),
        eq(extensionSchedules.enabled, true),
      ));
    disabled = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  }

  log.debug("reconciled", { extensionId, added, disabled, preserved, totalManifest: valid.length });
  return { added, disabled, preserved };
}

/** Test-only helper to fully wipe an extension's schedules. */
export async function _wipeSchedulesForTests(extensionId: string): Promise<void> {
  const db = getDb();
  await db.delete(extensionSchedules).where(eq(extensionSchedules.extensionId, extensionId));
}
