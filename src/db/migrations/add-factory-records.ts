import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Additive even when factories are disabled. Product records never cascade away. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_installation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tenant_id TEXT NOT NULL UNIQUE,
    execution_epoch INTEGER NOT NULL DEFAULT 1 CHECK (execution_epoch > 0)
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_projects (
    tenant_id TEXT NOT NULL REFERENCES factory_installation(tenant_id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    PRIMARY KEY (tenant_id, project_id)
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_runs (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    definition_digest TEXT NOT NULL,
    interpreter_build TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch > 0),
    request_digest TEXT NOT NULL,
    request_payload TEXT NOT NULL,
    next_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, run_id),
    FOREIGN KEY (tenant_id, project_id) REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_audit_batches (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    interpreter_id TEXT NOT NULL,
    source_sequence BIGINT NOT NULL CHECK (source_sequence > 0),
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    predecessor_digest TEXT,
    digest TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, run_id, interpreter_id, source_sequence),
    UNIQUE (tenant_id, project_id, run_id, sequence),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_command_outbox (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    logical_run_id TEXT NOT NULL,
    deduplication_id TEXT NOT NULL,
    input_hash TEXT NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
    state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'delivered', 'cancelled', 'dead_letter', 'outcome_unknown')),
    available_at BIGINT NOT NULL,
    lease_until BIGINT NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, id),
    UNIQUE (tenant_id, project_id, deduplication_id),
    FOREIGN KEY (tenant_id, project_id, logical_run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_command_outbox_ready ON factory_command_outbox (tenant_id, project_id, state, available_at, lease_until)`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_run_projections (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    consumer_id TEXT NOT NULL,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    digest TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, run_id, consumer_id),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT
  )`);
}
