import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Durable non-success C02 outcomes. Physical stop and usage settlement are separate facts. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_task_outcomes (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, interpreter_id TEXT NOT NULL, command_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
    input_digest TEXT NOT NULL CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
    authority_json TEXT NOT NULL, result_json TEXT NOT NULL,
    evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
    receipt_json TEXT NOT NULL, receipt_digest TEXT NOT NULL CHECK (receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id,project_id,run_id,interpreter_id,command_id),
    UNIQUE (attempt_id),
    FOREIGN KEY (attempt_id,tenant_id,project_id,run_id) REFERENCES factory_executions(attempt_id,tenant_id,project_id,run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES factory_runs(tenant_id,project_id,run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id,project_id,run_id,interpreter_id,command_id) REFERENCES factory_transition_commands(tenant_id,project_id,run_id,interpreter_id,command_id) ON DELETE RESTRICT
  )`);
}
