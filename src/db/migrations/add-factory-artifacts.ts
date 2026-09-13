import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Immutable, scoped pointers to content-addressed ordinary object storage. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_artifacts (
    object_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    interpreter_id TEXT, kind TEXT NOT NULL CHECK (kind IN ('definition_page', 'definition_manifest', 'transition_page', 'transition_manifest', 'execution_manifest', 'partition')),
    definition_digest TEXT, source_sequence BIGINT, page_index INTEGER, digest TEXT NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    blob_digest TEXT NOT NULL CHECK (blob_digest ~ '^[0-9a-f]{64}$'), storage_version TEXT NOT NULL,
    encoded_bytes INTEGER NOT NULL CHECK (encoded_bytes > 0 AND encoded_bytes <= 32768), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT,
    UNIQUE (tenant_id, project_id, run_id, interpreter_id, kind, source_sequence, page_index)
  )`);
}
