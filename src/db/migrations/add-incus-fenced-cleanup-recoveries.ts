import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Compensation links preserve the original uncertain power receipt. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_fenced_cleanup_recoveries (
    operation_id TEXT PRIMARY KEY REFERENCES provider_sandbox_operations(id) ON DELETE RESTRICT,
    binding_id TEXT NOT NULL UNIQUE REFERENCES sandbox_bindings(id) ON DELETE RESTRICT,
    fixture_operation_id TEXT NOT NULL,
    nonce TEXT NOT NULL UNIQUE,
    review_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    provider_generation INTEGER NOT NULL CHECK (provider_generation > 0),
    original_operation JSONB NOT NULL,
    receipt JSONB NOT NULL,
    receipt_sha256 TEXT NOT NULL,
    cleanup_operation_id TEXT NOT NULL UNIQUE REFERENCES provider_sandbox_operations(id) ON DELETE RESTRICT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (operation_id <> cleanup_operation_id)
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_fenced_cleanup_nonce_claims (
    nonce TEXT PRIMARY KEY, action TEXT NOT NULL CHECK (action IN ('recovery', 'abort')),
    binding_id TEXT NOT NULL REFERENCES sandbox_bindings(id) ON DELETE RESTRICT,
    operation_id TEXT NOT NULL REFERENCES provider_sandbox_operations(id) ON DELETE RESTRICT,
    receipt_sha256 TEXT NOT NULL
  )`);
  await db.execute(sql`INSERT INTO incus_fenced_cleanup_nonce_claims
    (nonce, action, binding_id, operation_id, receipt_sha256)
    SELECT nonce, 'recovery', binding_id, operation_id, receipt_sha256 FROM incus_fenced_cleanup_recoveries
    ON CONFLICT (nonce) DO NOTHING`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_fenced_cleanup_aborts (
    id TEXT PRIMARY KEY,
    nonce TEXT NOT NULL UNIQUE REFERENCES incus_fenced_cleanup_nonce_claims(nonce) ON DELETE RESTRICT,
    operation_id TEXT NOT NULL REFERENCES provider_sandbox_operations(id) ON DELETE RESTRICT,
    binding_id TEXT NOT NULL REFERENCES sandbox_bindings(id) ON DELETE RESTRICT,
    request_sha256 TEXT NOT NULL, hold_sha256 TEXT NOT NULL, receipt_sha256 TEXT NOT NULL,
    receipt JSONB NOT NULL, aborted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // A retained resource is not absent. This receipt settles only its DELETE journal;
  // ordinary cleanup remains responsible for disposal and reservation release.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_retained_destroy_noeffect_recoveries (
    operation_id TEXT PRIMARY KEY REFERENCES provider_sandbox_operations(id) ON DELETE RESTRICT,
    fixture_operation_id TEXT NOT NULL,
    nonce TEXT NOT NULL UNIQUE, review_id TEXT NOT NULL,
    origin_operation_id TEXT NOT NULL REFERENCES provider_sandbox_operations(id) ON DELETE RESTRICT,
    origin_receipt_sha256 TEXT NOT NULL, original_operation JSONB NOT NULL,
    receipt JSONB NOT NULL, receipt_sha256 TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
