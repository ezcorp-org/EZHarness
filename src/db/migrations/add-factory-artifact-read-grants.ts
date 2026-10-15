import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Human-issued, exact artifact reads. This table carries no acceptance or release authority. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_artifact_read_grants (
    tenant_id TEXT NOT NULL, source_project_id TEXT NOT NULL, source_run_id TEXT NOT NULL,
    source_artifact_id TEXT NOT NULL, target_project_id TEXT NOT NULL,
    artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
    artifact_bytes BIGINT NOT NULL CHECK (artifact_bytes > 0 AND artifact_bytes <= 16777216),
    artifact_kind TEXT NOT NULL CHECK (char_length(artifact_kind) BETWEEN 1 AND 128),
    storage_version TEXT NOT NULL CHECK (char_length(storage_version) BETWEEN 1 AND 512),
    media_type TEXT NOT NULL CHECK (char_length(media_type) BETWEEN 1 AND 128),
    issuer_id TEXT NOT NULL, issuer_grant_revision BIGINT NOT NULL CHECK (issuer_grant_revision > 0),
    protected_digest TEXT NOT NULL CHECK (protected_digest ~ '^sha256:[0-9a-f]{64}$'),
    revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, source_project_id, source_artifact_id, target_project_id),
    FOREIGN KEY (tenant_id, source_project_id, source_artifact_id)
      REFERENCES factory_artifacts(tenant_id, project_id, object_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, source_project_id, source_run_id)
      REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, target_project_id)
      REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (issuer_id) REFERENCES users(id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_artifact_read_grants_target
    ON factory_artifact_read_grants (tenant_id, target_project_id, source_artifact_id)`);
}
