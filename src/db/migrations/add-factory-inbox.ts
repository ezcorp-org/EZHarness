import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Pending delivery and retained exact applied receipts are different durable facts. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_inbox_cursors (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, interpreter_id TEXT NOT NULL,
    next_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
    PRIMARY KEY (tenant_id, project_id, run_id, interpreter_id),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_inbox_events (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, interpreter_id TEXT NOT NULL,
    sequence BIGINT NOT NULL CHECK (sequence > 0), event_id TEXT NOT NULL,
    event_hash TEXT NOT NULL CHECK (event_hash ~ '^sha256:[0-9a-f]{64}$'),
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'partition_notification')), payload TEXT NOT NULL,
    applied_source_sequence BIGINT, applied_digest TEXT,
    PRIMARY KEY (tenant_id, project_id, run_id, interpreter_id, event_id),
    UNIQUE (tenant_id, project_id, run_id, interpreter_id, sequence),
    CHECK ((applied_source_sequence IS NULL) = (applied_digest IS NULL)),
    FOREIGN KEY (tenant_id, project_id, run_id, interpreter_id) REFERENCES factory_inbox_cursors(tenant_id, project_id, run_id, interpreter_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, run_id, interpreter_id, applied_source_sequence) REFERENCES factory_audit_batches(tenant_id, project_id, run_id, interpreter_id, source_sequence) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_inbox_pending ON factory_inbox_events (tenant_id, project_id, run_id, interpreter_id, sequence) WHERE applied_source_sequence IS NULL`);
}
