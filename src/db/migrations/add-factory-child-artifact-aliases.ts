import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * One immutable alias per parent attempt that consumes a child run's accepted artifact.
 *
 * Every ancestry fact is a separate foreign key, so an alias cannot outlive any of them: the exact
 * parent attempt, the parent's child binding, the child's acceptance decision, and the artifact
 * row. The parent's own acceptance stays a separate table; nothing here implies one.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_child_artifact_aliases (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, alias_id TEXT NOT NULL,
    parent_run_id TEXT NOT NULL, parent_interpreter_id TEXT NOT NULL, parent_command_id TEXT NOT NULL,
    parent_node_instance_id TEXT NOT NULL, parent_candidate_generation BIGINT NOT NULL CHECK (parent_candidate_generation >= 0),
    parent_attempt_id TEXT NOT NULL,
    parent_execution_epoch BIGINT NOT NULL CHECK (parent_execution_epoch > 0), parent_cancellation_epoch BIGINT NOT NULL CHECK (parent_cancellation_epoch >= 0),
    child_run_id TEXT NOT NULL, child_decision_id TEXT NOT NULL,
    child_node_instance_id TEXT NOT NULL, child_candidate_generation BIGINT NOT NULL CHECK (child_candidate_generation >= 0),
    child_candidate_digest TEXT NOT NULL CHECK (child_candidate_digest ~ '^sha256:[0-9a-f]{64}$'),
    child_execution_epoch BIGINT NOT NULL CHECK (child_execution_epoch > 0),
    artifact_id TEXT NOT NULL, artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
    artifact_bytes BIGINT NOT NULL CHECK (artifact_bytes > 0),
    alias_digest TEXT NOT NULL CHECK (alias_digest ~ '^sha256:[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, alias_id),
    UNIQUE (tenant_id, project_id, parent_run_id, parent_interpreter_id, parent_command_id, parent_attempt_id),
    FOREIGN KEY (tenant_id, project_id, parent_run_id, parent_interpreter_id, parent_command_id) REFERENCES factory_child_runs(tenant_id, project_id, parent_run_id, parent_interpreter_id, parent_command_id) ON DELETE RESTRICT,
    FOREIGN KEY (parent_attempt_id, tenant_id, project_id, parent_run_id) REFERENCES factory_executions(attempt_id, tenant_id, project_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, child_decision_id) REFERENCES factory_acceptance_decisions(tenant_id, project_id, decision_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, child_run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, artifact_id) REFERENCES factory_artifacts(tenant_id, project_id, object_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_child_artifact_aliases_child ON factory_child_artifact_aliases (tenant_id, project_id, child_run_id, child_decision_id)`);
}
