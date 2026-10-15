import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_run_lifecycle (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    factory_id TEXT NOT NULL, factory_version TEXT NOT NULL, definition_digest TEXT NOT NULL,
    grant_revision BIGINT NOT NULL CHECK (grant_revision > 0), revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    cancellation_epoch BIGINT NOT NULL DEFAULT 0 CHECK (cancellation_epoch >= 0),
    status TEXT NOT NULL CHECK (status IN ('queued','running','waiting','succeeded','failed','cancelling','cancelled','uncertain')),
    deadline_ms BIGINT NOT NULL CHECK (deadline_ms > 0), parameters_json TEXT NOT NULL, parameters_digest TEXT NOT NULL,
    output_json TEXT, error_json TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, run_id),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, factory_id, factory_version) REFERENCES factory_versions(tenant_id, project_id, factory_id, version) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_run_lifecycle_list ON factory_run_lifecycle (tenant_id, project_id, factory_id, run_id)`);
}
