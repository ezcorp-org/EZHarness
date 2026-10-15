import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * A revoked artifact share no longer blocks a new one (W04b).
 *
 * `factory_artifact_read_grants` was keyed by the share itself (tenant, source
 * project, artifact, target project), so a revoked row occupied the key forever
 * and every later grant to the same target failed `factory_artifact_grant_conflict`.
 *
 * Each grant is now its own row, numbered by `grant_revision`. The revoked row
 * stays for audit, and a new grant is a new row. Uniqueness applies to active
 * grants only, through a partial unique index. Existing rows become revision 1.
 *
 * Every statement is self-idempotent because this repository has no migration
 * ledger and `migrate()` replays in full on every boot. The primary key is
 * reshaped only while it still has the old shape, so a later boot leaves every
 * constraint's catalog entry untouched.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_artifact_read_grants ADD COLUMN IF NOT EXISTS grant_revision BIGINT NOT NULL DEFAULT 1`);
  await database.execute(sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_artifact_read_grants'::regclass AND conname='factory_artifact_read_grants_grant_revision_check') THEN
      ALTER TABLE factory_artifact_read_grants ADD CONSTRAINT factory_artifact_read_grants_grant_revision_check CHECK (grant_revision > 0);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint con
      JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE con.conrelid='factory_artifact_read_grants'::regclass AND con.contype='p' AND att.attname='grant_revision'
    ) THEN
      ALTER TABLE factory_artifact_read_grants DROP CONSTRAINT factory_artifact_read_grants_pkey;
      ALTER TABLE factory_artifact_read_grants ADD CONSTRAINT factory_artifact_read_grants_pkey
        PRIMARY KEY (tenant_id, source_project_id, source_artifact_id, target_project_id, grant_revision);
    END IF;
  END $$;`);
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_artifact_read_grants_active
    ON factory_artifact_read_grants (tenant_id, source_project_id, source_artifact_id, target_project_id) WHERE revoked_at IS NULL`);
}
