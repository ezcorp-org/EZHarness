import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * The two factory package states on the shared v4 generation fence.
 *
 * C05 extends the v4 lifecycle's `enabled | disabled | uninstalled` plus its
 * generation counter with `quarantined` and `revoked` on the same fence. This
 * adds the missing state to the trust revision's CHECK and records, on every
 * revision, the exact `extension_release_installations.generation` the decision
 * was taken against. Dispatch readiness then refuses a package whose
 * installation has moved on since the decision, rather than trusting a revision
 * that a later activation or disable has already superseded.
 *
 * Every statement is self-idempotent because this repository has no migration
 * ledger and `migrate()` replays in full on every boot.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_runner_package_trust_revisions ADD COLUMN IF NOT EXISTS installation_generation BIGINT`);
  // Backfill from the binding's own installation before the NOT NULL, so an
  // upgraded database cannot hold a NULL where a fresh one forbids one. The v4
  // generation lives in the installation's JSON payload column, not in a column of
  // its own.
  await database.execute(sql`UPDATE factory_runner_package_trust_revisions r SET installation_generation = COALESCE((
      SELECT (i.payload::jsonb ->> 'generation')::bigint
        FROM factory_runner_package_bindings b
        JOIN extension_release_installations i ON i.id = b.installation_id
       WHERE b.tenant_id=r.tenant_id AND b.project_id=r.project_id AND b.package_name=r.package_name
         AND b.package_version=r.package_version AND b.package_digest=r.package_digest
         AND b.export_name=r.export_name AND b.reference_digest=r.reference_digest), 0)
    WHERE r.installation_generation IS NULL`);
  await database.execute(sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM factory_runner_package_trust_revisions WHERE installation_generation IS NULL) THEN
      RAISE EXCEPTION 'factory_runner_package_trust_revisions.installation_generation backfill is incomplete';
    END IF;
    ALTER TABLE factory_runner_package_trust_revisions ALTER COLUMN installation_generation SET NOT NULL;
  END $$;`);
  await database.execute(sql`DO $$
    DECLARE existing text;
  BEGIN
    SELECT conname INTO existing FROM pg_constraint
      WHERE conrelid='factory_runner_package_trust_revisions'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%state%' AND pg_get_constraintdef(oid) NOT LIKE '%quarantined%'
      LIMIT 1;
    IF existing IS NOT NULL THEN
      EXECUTE format('ALTER TABLE factory_runner_package_trust_revisions DROP CONSTRAINT %I', existing);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_runner_package_trust_revisions'::regclass AND conname='factory_runner_package_trust_state_check') THEN
      ALTER TABLE factory_runner_package_trust_revisions
        ADD CONSTRAINT factory_runner_package_trust_state_check CHECK (state IN ('active','quarantined','revoked'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_runner_package_trust_revisions'::regclass AND conname='factory_runner_package_trust_generation_check') THEN
      ALTER TABLE factory_runner_package_trust_revisions
        ADD CONSTRAINT factory_runner_package_trust_generation_check CHECK (installation_generation >= 0);
    END IF;
  END $$;`);
}
