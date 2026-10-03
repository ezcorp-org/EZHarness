import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** One immutable operator receipt per uncertain CREATE. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_noeffect_recoveries (
    operation_id TEXT PRIMARY KEY REFERENCES provider_sandbox_operations(id) ON DELETE RESTRICT,
    fixture_operation_id TEXT NOT NULL REFERENCES incus_qualification_fixtures(operation_id) ON DELETE RESTRICT,
    nonce TEXT NOT NULL UNIQUE,
    review_id TEXT NOT NULL,
    original_operation JSONB NOT NULL,
    receipt JSONB NOT NULL,
    cleanup_operation_id TEXT NOT NULL UNIQUE REFERENCES provider_sandbox_operations(id) ON DELETE RESTRICT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
