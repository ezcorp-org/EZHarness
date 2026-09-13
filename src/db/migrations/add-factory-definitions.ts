import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_mutation_receipts (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    principal_kind TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    input_digest TEXT NOT NULL,
    response_json TEXT,
    response_digest TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, principal_kind, principal_id, idempotency_key),
    FOREIGN KEY (tenant_id, project_id) REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_drafts (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    factory_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    source_digest TEXT NOT NULL,
    source_json TEXT NOT NULL,
    required_resources_json TEXT NOT NULL DEFAULT '[]',
    validation_diagnostic_count INTEGER NOT NULL DEFAULT 1 CHECK (validation_diagnostic_count >= 0),
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, factory_id),
    FOREIGN KEY (tenant_id, project_id) REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`ALTER TABLE factory_drafts ADD COLUMN IF NOT EXISTS required_resources_json TEXT NOT NULL DEFAULT '[]'`);
  await database.execute(sql`ALTER TABLE factory_drafts ADD COLUMN IF NOT EXISTS validation_diagnostic_count INTEGER NOT NULL DEFAULT 1 CHECK (validation_diagnostic_count >= 0)`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_versions (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    factory_id TEXT NOT NULL,
    version TEXT NOT NULL,
    draft_revision BIGINT NOT NULL CHECK (draft_revision > 0),
    definition_digest TEXT NOT NULL,
    compiled_blob_digest TEXT NOT NULL,
    compiled_bytes INTEGER NOT NULL CHECK (compiled_bytes > 0),
    lock_json TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, factory_id, version),
    FOREIGN KEY (tenant_id, project_id, factory_id) REFERENCES factory_drafts(tenant_id, project_id, factory_id) ON DELETE RESTRICT
  )`);
}
