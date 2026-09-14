import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * The strict verdict and the gateway-sealed report digest.
 *
 * A successful process exit is not a PASS. Before this column the only verdict vocabulary was a
 * boolean, so INCONCLUSIVE and VALIDATOR_ERROR could not be told apart from FAIL. `verdict` is
 * denormalized for console reads and for the rejection path; `claims_json` stays authoritative,
 * and `report_digest` seals the full report the gateway built from the durable assignment row.
 *
 * The backfill is the only place the old boolean mapping exists, and it is fail-closed: a row
 * whose claim carries no boolean aborts the migration rather than defaulting to PASS.
 */
const CHECKS: readonly { readonly name: string; readonly body: string }[] = [
  { name: "factory_validator_results_verdict_check", body: "verdict IN ('PASS','FAIL','INCONCLUSIVE','VALIDATOR_ERROR')" },
  { name: "factory_validator_results_report_digest_check", body: "report_digest IS NULL OR report_digest ~ '^sha256:[0-9a-f]{64}$'" },
];

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_validator_results ADD COLUMN IF NOT EXISTS verdict TEXT`);
  await database.execute(sql`ALTER TABLE factory_validator_results ADD COLUMN IF NOT EXISTS report_digest TEXT`);
  await database.execute(sql`UPDATE factory_validator_results SET verdict =
    CASE WHEN ((claims_json::jsonb)->0->>'passed')::boolean THEN 'PASS' ELSE 'FAIL' END
    WHERE verdict IS NULL AND (claims_json::jsonb)->0 ? 'passed'`);
  await database.execute(sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM factory_validator_results WHERE verdict IS NULL) THEN
      RAISE EXCEPTION 'factory validator result requires an explicit verdict';
    END IF;
  END $$`);
  await database.execute(sql`ALTER TABLE factory_validator_results ALTER COLUMN verdict SET NOT NULL`);
  for (const item of CHECKS) {
    await database.execute(sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_validator_results'::regclass AND contype='c' AND conname=${sql.raw(`'${item.name}'`)}) THEN
        ALTER TABLE factory_validator_results ADD CONSTRAINT ${sql.raw(item.name)} CHECK (${sql.raw(item.body)});
      END IF;
    END $$`);
  }
}
