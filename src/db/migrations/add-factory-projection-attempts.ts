import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Durable retry ordering for read-model workers. It cannot advance an audit cursor. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_run_projection_attempts (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, consumer_id TEXT NOT NULL,
    attempt_count BIGINT NOT NULL DEFAULT 1 CHECK (attempt_count > 0), last_error_code TEXT,
    last_attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, run_id, consumer_id),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_projection_attempts_pending
    ON factory_run_projection_attempts (tenant_id, consumer_id, last_attempted_at, project_id, run_id)`);
}
