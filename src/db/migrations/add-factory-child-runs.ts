import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Immutable parent-command binding for a separately durable child logical run. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_child_runs (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
    parent_run_id TEXT NOT NULL, parent_interpreter_id TEXT NOT NULL, parent_command_id TEXT NOT NULL,
    parent_source_sequence BIGINT NOT NULL CHECK (parent_source_sequence > 0), parent_command_digest TEXT NOT NULL CHECK (parent_command_digest ~ '^sha256:[0-9a-f]{64}$'),
    child_run_id TEXT NOT NULL, parent_envelope_id TEXT NOT NULL, child_envelope_id TEXT NOT NULL,
    child_factory_id TEXT NOT NULL, child_factory_version TEXT NOT NULL, child_definition_digest TEXT NOT NULL CHECK (child_definition_digest ~ '^sha256:[0-9a-f]{64}$'),
    parent_execution_epoch BIGINT NOT NULL CHECK (parent_execution_epoch > 0), parent_cancellation_epoch BIGINT NOT NULL CHECK (parent_cancellation_epoch >= 0), parent_grant_revision BIGINT NOT NULL CHECK (parent_grant_revision > 0),
    deadline_ms BIGINT NOT NULL CHECK (deadline_ms > 0), binding_digest TEXT NOT NULL CHECK (binding_digest ~ '^sha256:[0-9a-f]{64}$'),
    state TEXT NOT NULL CHECK (state IN ('open','uncertain','settled')), settlement_digest TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, parent_run_id, parent_interpreter_id, parent_command_id),
    UNIQUE (tenant_id, project_id, child_run_id),
    FOREIGN KEY (tenant_id, project_id, parent_run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, child_run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, parent_run_id, parent_interpreter_id, parent_command_id) REFERENCES factory_transition_commands(tenant_id, project_id, run_id, interpreter_id, command_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, parent_run_id, parent_interpreter_id, parent_source_sequence) REFERENCES factory_audit_batches(tenant_id, project_id, run_id, interpreter_id, source_sequence) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, parent_run_id, parent_envelope_id) REFERENCES factory_budget_envelopes(tenant_id, project_id, run_id, envelope_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, child_run_id, child_envelope_id) REFERENCES factory_budget_envelopes(tenant_id, project_id, run_id, envelope_id) ON DELETE RESTRICT,
    CHECK ((state = 'settled') = (settlement_digest IS NOT NULL)),
    CHECK (settlement_digest IS NULL OR settlement_digest ~ '^sha256:[0-9a-f]{64}$')
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_child_runs_unsettled_parent ON factory_child_runs (tenant_id, project_id, parent_run_id, parent_envelope_id) WHERE state <> 'settled'`);
}
