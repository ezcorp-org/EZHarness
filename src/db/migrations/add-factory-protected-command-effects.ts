import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Stable protected effect receipts are keyed by the exact committed command. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_protected_command_effects (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    interpreter_id TEXT NOT NULL, command_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('request-acceptance','request-release')),
    command_digest TEXT NOT NULL CHECK (command_digest ~ '^sha256:[a-f0-9]{64}$'),
    receipt_json TEXT NOT NULL, receipt_digest TEXT NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id,project_id,run_id,interpreter_id,command_id),
    FOREIGN KEY (tenant_id,project_id,run_id,interpreter_id,command_id)
      REFERENCES factory_transition_commands(tenant_id,project_id,run_id,interpreter_id,command_id) ON DELETE RESTRICT
  )`);
}
