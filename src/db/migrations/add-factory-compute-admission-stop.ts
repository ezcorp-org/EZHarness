import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

const STOP_CHECK = "factory_compute_admissions_stop_check";

/** The columns this migration adds, and its check: the tests compare the installed table against these. */
export const FACTORY_COMPUTE_ADMISSION_STOP_COLUMNS = ["stop_command_id", "stop_requested_epoch", "stop_requested_at_ms", "stop_event_json"] as const;
export const FACTORY_COMPUTE_ADMISSION_STOP_CHECKS = [STOP_CHECK] as const;

/**
 * A task attempt stopped while it waited for compute admission records that stop on its admission (W09h).
 *
 * A run cancelled while a node was `reserved` used to stay `stopping` for ever: the kernel's cancel-node named
 * the admission command, the task stop found no claimed attempt and refused it `factory_task_stop_stale`, and the
 * budget hold stayed `held`. Such an attempt has no execution row and no launch row, so it can have no
 * `factory_task_stops` row; its stop settles in place and is recorded here. `stop_command_id` is the kernel's
 * cancel-node command, so a repeated cancel returns the recorded event (`stop_event_json`);
 * `stop_requested_epoch` is the run's cancellation epoch that stop raised, as an approval row (W01h defect 5)
 * and a release row (W09e) carry it. A stopped admission can never be admitted: a late grant is refused and
 * released by the admission worker, never dispatched.
 *
 * Explicit ALTERs, never a column inside CREATE TABLE IF NOT EXISTS (the W15b R2 lesson): an existing
 * installation's table gains the columns too. Nothing existing is rewritten.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_compute_admissions ADD COLUMN IF NOT EXISTS stop_command_id TEXT`);
  await database.execute(sql`ALTER TABLE factory_compute_admissions ADD COLUMN IF NOT EXISTS stop_requested_epoch BIGINT`);
  await database.execute(sql`ALTER TABLE factory_compute_admissions ADD COLUMN IF NOT EXISTS stop_requested_at_ms BIGINT`);
  await database.execute(sql`ALTER TABLE factory_compute_admissions ADD COLUMN IF NOT EXISTS stop_event_json TEXT`);
  await database.execute(sql`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_compute_admissions'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${STOP_CHECK}'`)}) THEN
        ALTER TABLE factory_compute_admissions ADD CONSTRAINT ${sql.raw(STOP_CHECK)}
          CHECK ((stop_command_id IS NULL) = (stop_requested_epoch IS NULL) AND (stop_command_id IS NULL) = (stop_requested_at_ms IS NULL)
            AND (stop_command_id IS NULL) = (stop_event_json IS NULL)
            AND (stop_requested_epoch IS NULL OR stop_requested_epoch >= 1) AND (stop_requested_at_ms IS NULL OR stop_requested_at_ms >= 0)
            AND (stop_command_id IS NULL OR state <> 'admitted'));
      END IF;
    END $$`);
}
