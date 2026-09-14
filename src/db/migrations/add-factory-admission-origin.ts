import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * A typed origin on shared admission, so a protected validator reservation is a first-class
 * durable fact rather than a forged dispatch-node command.
 *
 * `origin_json` is TEXT, not JSONB, because `origin_digest` seals the exact canonical bytes and
 * JSONB would renormalize them. Every sibling payload column on this table is TEXT for the same
 * reason. The partial unique index gives one admission per validator identity: a repeated poll,
 * a restart, and a lost response all resolve to the same row.
 */
const CHECKS: readonly { readonly table: string; readonly name: string; readonly body: string }[] = [
  { table: "factory_budget_reservations", name: "factory_budget_reservations_origin_kind_check", body: "origin_kind IN ('dispatch-node','protected-validator')" },
  { table: "factory_compute_admissions", name: "factory_compute_admissions_origin_kind_check", body: "origin_kind IN ('dispatch-node','protected-validator')" },
  { table: "factory_compute_admissions", name: "factory_compute_admissions_origin_digest_check", body: "origin_digest IS NULL OR origin_digest ~ '^sha256:[0-9a-f]{64}$'" },
  { table: "factory_compute_admissions", name: "factory_compute_admissions_origin_body_check", body: "(origin_kind = 'protected-validator') = (origin_json IS NOT NULL)" },
  { table: "factory_compute_admissions", name: "factory_compute_admissions_origin_seal_check", body: "(origin_json IS NULL) = (origin_digest IS NULL)" },
  { table: "factory_compute_admissions", name: "factory_compute_admissions_origin_bytes_check", body: "origin_json IS NULL OR octet_length(origin_json) <= 1048576" },
];

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_budget_reservations ADD COLUMN IF NOT EXISTS origin_kind TEXT NOT NULL DEFAULT 'dispatch-node'`);
  await database.execute(sql`ALTER TABLE factory_compute_admissions ADD COLUMN IF NOT EXISTS origin_kind TEXT NOT NULL DEFAULT 'dispatch-node'`);
  await database.execute(sql`ALTER TABLE factory_compute_admissions ADD COLUMN IF NOT EXISTS origin_json TEXT`);
  await database.execute(sql`ALTER TABLE factory_compute_admissions ADD COLUMN IF NOT EXISTS origin_digest TEXT`);
  // A CHECK cannot be altered in place, and re-adding one on every boot churns its catalog
  // entry, so each is installed only when the exact definition is absent.
  for (const item of CHECKS) {
    await database.execute(sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=${sql.raw(`'${item.table}'`)}::regclass AND contype='c' AND conname=${sql.raw(`'${item.name}'`)}) THEN
        ALTER TABLE ${sql.raw(item.table)} ADD CONSTRAINT ${sql.raw(item.name)} CHECK (${sql.raw(item.body)});
      END IF;
    END $$`);
  }
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_validator_admission_identity
    ON factory_compute_admissions (tenant_id, project_id, run_id, origin_digest) WHERE origin_kind = 'protected-validator'`);
}
