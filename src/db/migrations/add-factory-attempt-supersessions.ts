import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

const STATUS_CHECK = "factory_executions_status_check";
const STOP_STATE_CHECK = "factory_task_stops_state_check";
const STOP_SUPERSEDED_CHECK = "factory_task_stops_superseded_check";
const STOP_ACCEPTED_CHECK = "factory_task_stops_accepted_state_check";

/**
 * W15f: a signed restore supersedes every attempt of the execution epoch it
 * left, as a durable, proven end.
 *
 * After a restore, an old-epoch attempt can never pass the run fence again, but
 * nothing said it had ended: its execution row stayed live and a hold it left
 * uncertain could never settle. The signing transaction now sets such an
 * attempt's status to `superseded` and writes one row here: the restore and the
 * digest of the signed report as its proof, both epochs, the reservation and
 * interpreter the attempt's dispatch named, and the kernel event that tells the
 * run the attempt ended (the restore enqueues it; a later settlement re-sends it
 * with its uncertainty cleared). Nothing existing is rewritten.
 *
 * A stop accepted before the restore and never confirmed can no longer be
 * confirmed (its confirmation runs under the run fence, which refuses the old
 * epoch), so the same transaction ends it too: its state becomes `superseded`
 * and `superseded_restore_id` names the restore, so the stop scan leaves it by
 * state and the settlement's clear sends the supersession's end instead.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`DO $$
    BEGIN
      -- Replaced only while the form without 'superseded' is installed, so a
      -- rerun does not churn the constraint.
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_executions'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${STATUS_CHECK}'`)} AND pg_get_constraintdef(oid) NOT LIKE '%superseded%') THEN
        ALTER TABLE factory_executions DROP CONSTRAINT ${sql.raw(STATUS_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_executions'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${STATUS_CHECK}'`)}) THEN
        ALTER TABLE factory_executions ADD CONSTRAINT ${sql.raw(STATUS_CHECK)}
          CHECK (status IN ('admitted','running','completed','cancel_accepted','stopped','failed','superseded'));
      END IF;
    END $$`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_attempt_supersessions (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES factory_executions(attempt_id) ON DELETE RESTRICT,
    reservation_id TEXT,
    interpreter_id TEXT,
    superseded_epoch BIGINT NOT NULL CHECK (superseded_epoch >= 1),
    execution_epoch BIGINT NOT NULL,
    restore_id TEXT NOT NULL,
    restore_digest TEXT NOT NULL CHECK (restore_digest ~ '^sha256:[0-9a-f]{64}$'),
    event_json JSONB,
    superseded_at_ms BIGINT NOT NULL CHECK (superseded_at_ms >= 0),
    PRIMARY KEY (tenant_id, project_id, run_id, attempt_id),
    CONSTRAINT factory_attempt_supersessions_epoch_check CHECK (execution_epoch > superseded_epoch),
    -- The kernel event is addressed to an interpreter: one without the other is a broken record.
    CONSTRAINT factory_attempt_supersessions_event_check CHECK ((interpreter_id IS NULL) = (event_json IS NULL))
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS factory_attempt_supersessions_reservation_idx ON factory_attempt_supersessions (tenant_id, reservation_id)`);
  await database.execute(sql`ALTER TABLE factory_task_stops ADD COLUMN IF NOT EXISTS superseded_restore_id TEXT`);
  await database.execute(sql`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_task_stops'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${STOP_STATE_CHECK}'`)} AND pg_get_constraintdef(oid) NOT LIKE '%superseded%') THEN
        ALTER TABLE factory_task_stops DROP CONSTRAINT ${sql.raw(STOP_STATE_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_task_stops'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${STOP_STATE_CHECK}'`)}) THEN
        ALTER TABLE factory_task_stops ADD CONSTRAINT ${sql.raw(STOP_STATE_CHECK)} CHECK (state IN ('accepted','uncertain','stopped','superseded'));
      END IF;
      -- An accepted stop has no event or receipt yet. A superseded stop may be
      -- equally bare, when the restore ended it before the host was ever asked.
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_task_stops'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${STOP_ACCEPTED_CHECK}'`)} AND pg_get_constraintdef(oid) NOT LIKE '%superseded%') THEN
        ALTER TABLE factory_task_stops DROP CONSTRAINT ${sql.raw(STOP_ACCEPTED_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_task_stops'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${STOP_ACCEPTED_CHECK}'`)}) THEN
        ALTER TABLE factory_task_stops ADD CONSTRAINT ${sql.raw(STOP_ACCEPTED_CHECK)} CHECK (
          (state = 'accepted') = (uncertain_event_json IS NULL AND uncertain_event_digest IS NULL AND stop_receipt_json IS NULL AND stop_receipt_digest IS NULL AND stopped_event_json IS NULL AND stopped_event_digest IS NULL)
          OR state = 'superseded');
      END IF;
      -- A superseded stop names its restore, and only a superseded stop does.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_task_stops'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${STOP_SUPERSEDED_CHECK}'`)}) THEN
        ALTER TABLE factory_task_stops ADD CONSTRAINT ${sql.raw(STOP_SUPERSEDED_CHECK)} CHECK ((state = 'superseded') = (superseded_restore_id IS NOT NULL));
      END IF;
    END $$`);
}
