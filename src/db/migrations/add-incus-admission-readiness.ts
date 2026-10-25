import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Full live receipts are immutable. Admission records never renew their expiry. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_qualification_authority_captures (
    run_id TEXT PRIMARY KEY, scope JSONB NOT NULL, pins JSONB NOT NULL,
    authority JSONB NOT NULL, captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_admission_baselines (
    installation_id TEXT NOT NULL, connection_id TEXT NOT NULL, preset_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES incus_qualification_authority_captures(run_id),
    proof_digest TEXT NOT NULL, pins JSONB NOT NULL, authority JSONB NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (installation_id, connection_id, preset_id)
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_admission_readiness (
    scope_digest TEXT PRIMARY KEY, baseline_digest TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL, valid_until TIMESTAMPTZ NOT NULL,
    result JSONB, failure TEXT, CHECK ((result IS NULL) <> (failure IS NULL))
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_admission_claims (
    binding_id TEXT NOT NULL, idempotency_scope TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    baseline_digest TEXT NOT NULL, valid_until TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (binding_id, idempotency_scope, idempotency_key)
  )`);
}
