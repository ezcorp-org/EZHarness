import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

const SOURCE_CHECK = "factory_task_stops_source_check";
const DISPATCH_REFUSED_CHECK = "factory_task_stops_dispatch_refused_check";

/** The stop sources the table accepts once this migration has run (W02d R8). */
export const FACTORY_TASK_STOP_SOURCES = ["terminal-outcome", "sealed-launch", "dispatch-refused"] as const;

/** The source CHECK's clause, built from {@link FACTORY_TASK_STOP_SOURCES}. */
export const FACTORY_TASK_STOP_SOURCE_CLAUSE = `source IN (${FACTORY_TASK_STOP_SOURCES.map((source) => `'${source}'`).join(",")})`;

/**
 * W02d R8: a dispatch refused after its compute was admitted, with nothing queued, releases its lease and its
 * hold through a signed host stop.
 *
 * The refusal rolls back to its savepoint, so the attempt has no execution row, no launch row and no kernel
 * attempt; only the admitted compute lease remains, and C03 frees it only on a supervisor's signed word. A
 * `dispatch-refused` stop row carries that stop: `attempt_id` is NULL (the foreign keys on it stay, and a NULL
 * skips them, so no synthetic row exists), `worker_id` names the worker the host signs an absence for, and
 * `cancel_command_id` is the refused `dispatch-node` command, and `attempt_authority_json` names the node attempt
 * whose usage settles "nothing launched, all zero" (W09h's basis) once the host signs. The CHECK ties the three
 * columns to that source, so every other source keeps a real attempt and its keys.
 *
 * Explicit ALTERs, never a column inside CREATE TABLE IF NOT EXISTS: an existing installation gains them too.
 * The source CHECK is replaced only while the form without 'dispatch-refused' is installed.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_task_stops ALTER COLUMN attempt_id DROP NOT NULL`);
  await database.execute(sql`ALTER TABLE factory_task_stops ADD COLUMN IF NOT EXISTS worker_id TEXT`);
  await database.execute(sql`ALTER TABLE factory_task_stops ADD COLUMN IF NOT EXISTS attempt_authority_json TEXT`);
  await database.execute(sql`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_task_stops'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${SOURCE_CHECK}'`)} AND pg_get_constraintdef(oid) NOT LIKE '%dispatch-refused%') THEN
        ALTER TABLE factory_task_stops DROP CONSTRAINT ${sql.raw(SOURCE_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_task_stops'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${SOURCE_CHECK}'`)}) THEN
        ALTER TABLE factory_task_stops ADD CONSTRAINT ${sql.raw(SOURCE_CHECK)}
          CHECK (${sql.raw(FACTORY_TASK_STOP_SOURCE_CLAUSE)});
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_task_stops'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${DISPATCH_REFUSED_CHECK}'`)}) THEN
        ALTER TABLE factory_task_stops ADD CONSTRAINT ${sql.raw(DISPATCH_REFUSED_CHECK)}
          CHECK ((source = 'dispatch-refused') = (attempt_id IS NULL) AND (source = 'dispatch-refused') = (worker_id IS NOT NULL)
            AND (source = 'dispatch-refused') = (attempt_authority_json IS NOT NULL));
      END IF;
    END $$`);
}
