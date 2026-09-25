import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** A run survives the death of the HTTP process. No pass is stored here. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_qualification_runs (
    run_id TEXT PRIMARY KEY,
    fixture_operation_id TEXT NOT NULL REFERENCES incus_qualification_fixtures(operation_id) ON DELETE RESTRICT,
    scope JSONB NOT NULL,
    binding_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    connection_revision INTEGER NOT NULL CHECK (connection_revision > 0),
    last_operation_id TEXT NOT NULL,
    nonce TEXT NOT NULL UNIQUE,
    deadline_at TIMESTAMPTZ NOT NULL,
    before_observation JSONB NOT NULL,
    before_digest TEXT NOT NULL,
    old_process_identity JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'AWAITING_RESTART'
      CHECK (state IN ('AWAITING_RESTART', 'CLAIMED', 'FAILED')),
    receipt JSONB,
    after_observation JSONB,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at TIMESTAMPTZ
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_incus_qualification_runs_fixture_active
    ON incus_qualification_runs (fixture_operation_id)
    WHERE state IN ('AWAITING_RESTART', 'CLAIMED')`);
}
