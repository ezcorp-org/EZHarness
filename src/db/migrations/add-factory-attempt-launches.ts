import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Gateway-owned C02 launch intents. The supervisor keeps only live process facts. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_attempt_launches (
    attempt_id TEXT PRIMARY KEY REFERENCES factory_executions(attempt_id) ON DELETE RESTRICT,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    request_json JSONB NOT NULL,
    reservation_id TEXT NOT NULL,
    grant_revision BIGINT NOT NULL CHECK (grant_revision >= 1),
    allocation_generation BIGINT NOT NULL CHECK (allocation_generation >= 1),
    holder_generation BIGINT NOT NULL CHECK (holder_generation >= 1),
    allocation_token TEXT NOT NULL,
    host_id TEXT NOT NULL,
    package_receipt_digest TEXT NOT NULL CHECK (package_receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
    package_receipt_json JSONB NOT NULL,
    artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
    worker_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('prepared','launching','launched','terminal','uncertain')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`ALTER TABLE factory_attempt_launches ADD COLUMN IF NOT EXISTS package_receipt_json JSONB`);
  await database.execute(sql`ALTER TABLE factory_attempt_launches ADD COLUMN IF NOT EXISTS host_id TEXT`);
  await database.execute(sql`ALTER TABLE factory_attempt_launches ALTER COLUMN host_id SET NOT NULL`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_attempt_launches_recovery
    ON factory_attempt_launches(state, updated_at, tenant_id, project_id, attempt_id)`);
}
