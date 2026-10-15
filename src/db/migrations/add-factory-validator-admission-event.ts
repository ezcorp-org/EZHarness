import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

const RELAXED_CHECK = "factory_compute_admissions_terminal_event_check";

/**
 * A settled protected-validator admission carries no kernel event.
 *
 * The original constraint said a settled admission always has one, because
 * every admission was a task attempt with a kernel node to tell. A validator
 * has no node, so its `admission-result` would have no recipient and no
 * command to name; the invariant becomes conditional on the origin, and it is
 * tightened rather than merely relaxed: a validator admission may never carry
 * an event at all, in any state.
 *
 * The original was declared unnamed inside `CREATE TABLE`, so PostgreSQL
 * generated its name and a fresh database and an upgraded one disagree about
 * it. This migration therefore finds it by definition rather than by name, and
 * installs a named replacement so both paths end with the same catalog entry.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`DO $$
    DECLARE existing RECORD;
    BEGIN
      FOR existing IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'factory_compute_admissions'::regclass AND contype = 'c'
          AND conname <> ${sql.raw(`'${RELAXED_CHECK}'`)}
          AND pg_get_constraintdef(oid) LIKE '%event_json IS NOT NULL%'
      LOOP
        EXECUTE format('ALTER TABLE factory_compute_admissions DROP CONSTRAINT %I', existing.conname);
      END LOOP;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_compute_admissions'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${RELAXED_CHECK}'`)}) THEN
        ALTER TABLE factory_compute_admissions ADD CONSTRAINT ${sql.raw(RELAXED_CHECK)} CHECK (
          CASE WHEN origin_kind = 'protected-validator'
            THEN event_json IS NULL
            ELSE (state IN ('admitted', 'rejected')) = (event_json IS NOT NULL)
          END
        );
      END IF;
    END $$`);
}
