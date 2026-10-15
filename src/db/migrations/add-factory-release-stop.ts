import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

const STOP_OUTCOME_CHECK = "factory_release_operations_stop_outcome_check";
const STOP_FIELDS_CHECK = "factory_release_operations_stop_fields_check";
const STOP_COST_CHECK = "factory_release_operations_stop_cost_check";

/** The columns this migration adds, and its checks: the tests compare the installed table against these. */
export const FACTORY_RELEASE_STOP_COLUMNS = ["stop_command_id", "stop_requested_epoch", "stop_requested_at_ms", "stop_event_json", "stop_outcome", "late_evidence_json", "stop_cost_micros", "stop_cost_source", "stop_cost_basis"] as const;
export const FACTORY_RELEASE_STOP_CHECKS = [STOP_OUTCOME_CHECK, STOP_FIELDS_CHECK, STOP_COST_CHECK] as const;

/** The stop outcomes a stopped release can end with (W09e). */
export const FACTORY_RELEASE_STOP_OUTCOMES = ["no_effect", "published", "unknown_at_deadline"] as const;

/**
 * A release whose run was stopped records that stop, and what became of its effect (W09e).
 *
 * A run stopped while its release was in flight used to stay `stopping` for ever: the execution cancel
 * route resolves a cancel through the attempt queue, which never holds a release. The stop now marks
 * the release instead. `stop_command_id` is the kernel's cancel-node command, which makes a repeated
 * cancel return the same recorded result (`stop_event_json`); `stop_requested_epoch` is the run's
 * cancellation epoch that stop raised, as an approval row carries it (W01h defect 5);
 * `stop_outcome` is what the release outcome later proves about the publish, bounded by the
 * operation's own signed deadline; `late_evidence_json` keeps a provider answer that arrived after the
 * stop, which cannot change the node's status. `stop_cost_micros`, `stop_cost_source` and `stop_cost_basis` are
 * the cost the outcome settled at, in W03f's vocabulary: `no_effect` costs 0 (`proven-no-effect`); `published`
 * costs the receipt's spend (`provider-receipt`) or the release's reserved bound, its signed estimated spend
 * (`reserved-bound`); `unknown_at_deadline` costs the bound. Release spend stays outside the compute budget
 * ledger (coordinator ruling, W09e); these columns are its record.
 *
 * Explicit ALTERs, never a column inside CREATE TABLE IF NOT EXISTS (the W15b R2 lesson): an existing
 * installation's table gains the columns too. Nothing existing is rewritten.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS stop_command_id TEXT`);
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS stop_requested_epoch BIGINT`);
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS stop_requested_at_ms BIGINT`);
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS stop_event_json TEXT`);
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS stop_outcome TEXT`);
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS late_evidence_json TEXT`);
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS stop_cost_micros BIGINT`);
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS stop_cost_source TEXT`);
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS stop_cost_basis TEXT`);
  await database.execute(sql`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_release_operations'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${STOP_OUTCOME_CHECK}'`)}) THEN
        ALTER TABLE factory_release_operations ADD CONSTRAINT ${sql.raw(STOP_OUTCOME_CHECK)}
          CHECK (stop_outcome IS NULL OR stop_outcome IN ('no_effect','published','unknown_at_deadline'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_release_operations'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${STOP_FIELDS_CHECK}'`)}) THEN
        ALTER TABLE factory_release_operations ADD CONSTRAINT ${sql.raw(STOP_FIELDS_CHECK)}
          CHECK ((stop_command_id IS NULL) = (stop_requested_epoch IS NULL) AND (stop_command_id IS NULL) = (stop_requested_at_ms IS NULL)
            AND (stop_command_id IS NULL) = (stop_event_json IS NULL) AND (stop_outcome IS NULL OR stop_command_id IS NOT NULL)
            AND (stop_requested_epoch IS NULL OR stop_requested_epoch >= 1));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_release_operations'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${STOP_COST_CHECK}'`)}) THEN
        ALTER TABLE factory_release_operations ADD CONSTRAINT ${sql.raw(STOP_COST_CHECK)}
          CHECK ((stop_outcome IS NULL) = (stop_cost_source IS NULL) AND (stop_cost_source IS NULL) = (stop_cost_micros IS NULL) AND (stop_cost_source IS NULL) = (stop_cost_basis IS NULL)
            AND (stop_cost_source IS NULL OR stop_cost_source IN ('proven-no-effect','provider-receipt','reserved-bound'))
            AND (stop_cost_micros IS NULL OR stop_cost_micros >= 0)
            AND (stop_outcome IS DISTINCT FROM 'no_effect' OR (stop_cost_source = 'proven-no-effect' AND stop_cost_micros = 0))
            AND (stop_outcome IS DISTINCT FROM 'unknown_at_deadline' OR stop_cost_source = 'reserved-bound')
            AND (stop_outcome IS DISTINCT FROM 'published' OR stop_cost_source IN ('provider-receipt','reserved-bound')));
      END IF;
    END $$`);
}
