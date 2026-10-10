import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Durable C02 attempt dispatch identities. Runner inputs remain in the execution journal. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS factory_executions_scope_attempt_key
    ON factory_executions(attempt_id, tenant_id, project_id, run_id)`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_attempt_queue (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    deduplication_id TEXT NOT NULL,
    input_hash TEXT NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
    state TEXT NOT NULL CHECK (state IN ('queued','leased','delivered','cancelled','dead_letter','outcome_unknown')),
    attempts BIGINT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts BIGINT NOT NULL CHECK (max_attempts >= 1 AND max_attempts <= 10),
    available_at BIGINT NOT NULL CHECK (available_at >= 0),
    lease_until BIGINT NOT NULL DEFAULT 0 CHECK (lease_until >= 0),
    lease_token TEXT,
    failure_code TEXT,
    reference_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, attempt_id),
    UNIQUE (tenant_id, project_id, deduplication_id),
    FOREIGN KEY (attempt_id, tenant_id, project_id, run_id) REFERENCES factory_executions(attempt_id, tenant_id, project_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_attempt_queue_ready
    ON factory_attempt_queue(tenant_id, state, available_at, lease_until, project_id, attempt_id)`);
}
