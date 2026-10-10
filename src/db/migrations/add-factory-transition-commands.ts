import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Scoped command lookup records point only to already committed audit batches. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_transition_commands (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, interpreter_id TEXT NOT NULL,
    command_id TEXT NOT NULL, source_sequence BIGINT NOT NULL CHECK (source_sequence > 0),
    command_digest TEXT NOT NULL CHECK (command_digest ~ '^sha256:[0-9a-f]{64}$'),
    PRIMARY KEY (tenant_id, project_id, run_id, interpreter_id, command_id),
    FOREIGN KEY (tenant_id, project_id, run_id, interpreter_id, source_sequence)
      REFERENCES factory_audit_batches(tenant_id, project_id, run_id, interpreter_id, source_sequence) ON DELETE RESTRICT
  )`);
}
