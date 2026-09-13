import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Durable C02 identity and journal records. All DDL is additive and rerunnable. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_executions (
    attempt_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    node_instance_id TEXT NOT NULL,
    candidate_generation BIGINT NOT NULL,
    attempt_number BIGINT NOT NULL,
    grant_revision BIGINT NOT NULL,
    reservation_generation BIGINT NOT NULL,
    execution_epoch BIGINT NOT NULL,
    deadline_at TIMESTAMP WITH TIME ZONE NOT NULL,
    request_hash TEXT NOT NULL,
    request_json JSONB NOT NULL,
    operation_initial_index BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('admitted', 'running', 'cancel_accepted', 'stopped', 'failed')),
    journal_cursor BIGINT NOT NULL DEFAULT -1,
    cancel_accepted_at TIMESTAMP WITH TIME ZONE,
    stopped_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`ALTER TABLE factory_executions ADD COLUMN IF NOT EXISTS operation_initial_index BIGINT NOT NULL DEFAULT 0`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_execution_operation_cursors (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    node_instance_id TEXT NOT NULL,
    candidate_generation BIGINT NOT NULL,
    next_operation_index BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, project_id, run_id, node_instance_id, candidate_generation),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_execution_operations (
    attempt_id TEXT NOT NULL REFERENCES factory_executions(attempt_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    operation_index BIGINT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('model', 'tool')),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'completed', 'failed', 'uncertain')),
    request_digest TEXT NOT NULL,
    provider_receipt_digest TEXT,
    result_digest TEXT,
    usage_json JSONB,
    workspace_checkpoint JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (attempt_id, operation_id),
    UNIQUE (attempt_id, operation_index)
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_executions_run ON factory_executions(tenant_id, project_id, run_id, created_at)`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_execution_operations_cursor ON factory_execution_operations(attempt_id, operation_index)`);
}
