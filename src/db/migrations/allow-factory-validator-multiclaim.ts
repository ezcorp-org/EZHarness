import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * The exact catalog shapes this migration converges on.
 *
 * A `DO $$ ... $$` body accepts no bind parameter, so both are spliced with `sql.raw`.
 * They are fixed literals declared here and carry no caller input.
 */
const RESULT_PRIMARY_KEY = sql.raw("'PRIMARY KEY (tenant_id, project_id, validator_attempt_id, validator_id)'");
const RESULT_ASSIGNMENT_FOREIGN_KEY = sql.raw(
  "'FOREIGN KEY (tenant_id, project_id, validator_attempt_id, validator_id) REFERENCES factory_validator_assignments(tenant_id, project_id, validator_attempt_id, validator_id) ON DELETE RESTRICT'",
);

/**
 * Lets one exact protected validator attempt issue results for several pinned claims.
 *
 * There is no migration ledger, so every statement reruns on every boot and must be
 * self-idempotent. Each reshaping step is therefore guarded on the catalog shape it
 * produces: a database that already carries the claim-keyed identity changes nothing, and
 * the primary key is never dropped and recreated on a healthy boot.
 *
 * `add-factory-validator-materials` creates the same shape on a fresh database, including
 * the unique INDEX below, so the fresh and upgraded catalogs converge exactly.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_validator_results ADD COLUMN IF NOT EXISTS validator_id TEXT`);
  await database.execute(sql`UPDATE factory_validator_results result SET validator_id=assignment.validator_id
    FROM factory_validator_assignments assignment
    WHERE result.validator_id IS NULL AND assignment.tenant_id=result.tenant_id AND assignment.project_id=result.project_id
      AND assignment.validator_attempt_id=result.validator_attempt_id`);
  await database.execute(sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM factory_validator_results WHERE validator_id IS NULL) THEN
      RAISE EXCEPTION 'factory validator result requires an unambiguous claim identity';
    END IF;
  END $$`);
  await database.execute(sql`ALTER TABLE factory_validator_results ALTER COLUMN validator_id SET NOT NULL`);
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_validator_assignment_attempt_claim
    ON factory_validator_assignments(tenant_id,project_id,validator_attempt_id,validator_id)`);
  await database.execute(sql`DO $$ DECLARE item RECORD; BEGIN
    FOR item IN SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='factory_validator_results'::regclass AND contype='f'
    LOOP
      IF item.definition LIKE '%factory_validator_assignments%' AND item.definition <> ${RESULT_ASSIGNMENT_FOREIGN_KEY} THEN
        EXECUTE format('ALTER TABLE factory_validator_results DROP CONSTRAINT %I', item.conname);
      END IF;
    END LOOP;
  END $$`);
  await database.execute(sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_validator_results'::regclass AND contype='p' AND pg_get_constraintdef(oid)=${RESULT_PRIMARY_KEY}) THEN
      ALTER TABLE factory_validator_results DROP CONSTRAINT IF EXISTS factory_validator_results_pkey;
      ALTER TABLE factory_validator_results ADD CONSTRAINT factory_validator_results_pkey
        PRIMARY KEY (tenant_id,project_id,validator_attempt_id,validator_id);
    END IF;
  END $$`);
  await database.execute(sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_validator_results'::regclass AND contype='f' AND pg_get_constraintdef(oid)=${RESULT_ASSIGNMENT_FOREIGN_KEY}) THEN
      ALTER TABLE factory_validator_results ADD CONSTRAINT factory_validator_results_assignment_fkey
        FOREIGN KEY (tenant_id,project_id,validator_attempt_id,validator_id)
        REFERENCES factory_validator_assignments(tenant_id,project_id,validator_attempt_id,validator_id) ON DELETE RESTRICT;
    END IF;
  END $$`);
  await database.execute(sql`DO $$ DECLARE item RECORD; BEGIN
    FOR item IN SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='factory_validator_assignments'::regclass AND contype='u'
    LOOP
      IF item.definition='UNIQUE (validator_attempt_id)' THEN
        EXECUTE format('ALTER TABLE factory_validator_assignments DROP CONSTRAINT %I', item.conname);
      END IF;
    END LOOP;
  END $$`);
}
