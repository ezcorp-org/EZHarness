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
}
