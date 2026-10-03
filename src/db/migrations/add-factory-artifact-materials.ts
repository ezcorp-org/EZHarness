import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";
import { ensureFactoryArtifactAdmissionIndex } from "./factory-artifact-admission-index";

/**
 * Auxiliary immutable material records beside the terminal candidate artifact.
 * A material is bound to tenant, project, run, attempt, operation, and object
 * identity; its bytes live in bounded chunks and its sealed handle is one
 * ordinary `factory_artifacts` row of kind `material`.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_artifacts ADD COLUMN IF NOT EXISTS material_key TEXT`);
  await database.execute(sql`DO $$ DECLARE old_constraint TEXT; BEGIN
    SELECT conname INTO old_constraint FROM pg_constraint
      WHERE conrelid='factory_artifacts'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%definition_page%' AND pg_get_constraintdef(oid) NOT LIKE '%material%' LIMIT 1;
    IF old_constraint IS NOT NULL THEN EXECUTE format('ALTER TABLE factory_artifacts DROP CONSTRAINT %I', old_constraint); END IF;
  END $$`);
  await database.execute(sql`ALTER TABLE factory_artifacts DROP CONSTRAINT IF EXISTS factory_artifacts_kind_check`);
  await database.execute(sql`ALTER TABLE factory_artifacts ADD CONSTRAINT factory_artifacts_kind_check CHECK (kind IN ('definition_page','definition_manifest','transition_page','transition_manifest','execution_manifest','partition','candidate_output','material'))`);
  await database.execute(sql`ALTER TABLE factory_artifacts DROP CONSTRAINT IF EXISTS factory_artifacts_material_slot_check`);
  await database.execute(sql`ALTER TABLE factory_artifacts ADD CONSTRAINT factory_artifacts_material_slot_check CHECK ((kind='material') = (material_key IS NOT NULL))`);
  await ensureFactoryArtifactAdmissionIndex(database);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_artifact_materials (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    object_name TEXT NOT NULL, version INTEGER NOT NULL CHECK (version >= 1),
    media_type TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    total_bytes BIGINT NOT NULL CHECK (total_bytes >= 1 AND total_bytes <= 268435456),
    chunk_count INTEGER NOT NULL CHECK (chunk_count >= 1 AND chunk_count <= 64),
    storage_version TEXT NOT NULL,
    sealed BOOLEAN NOT NULL DEFAULT FALSE,
    object_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, run_id, attempt_id, operation_id, object_name, version),
    CHECK (sealed = (object_id IS NOT NULL)),
    FOREIGN KEY (attempt_id, tenant_id, project_id, run_id)
      REFERENCES factory_executions (attempt_id, tenant_id, project_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, object_id)
      REFERENCES factory_artifacts (tenant_id, project_id, object_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_artifact_materials_object
    ON factory_artifact_materials (tenant_id, project_id, object_id) WHERE object_id IS NOT NULL`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_artifact_material_chunks (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    object_name TEXT NOT NULL, version INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 64),
    chunk_digest TEXT NOT NULL CHECK (chunk_digest ~ '^sha256:[0-9a-f]{64}$'),
    encoded_bytes INTEGER NOT NULL CHECK (encoded_bytes >= 1 AND encoded_bytes <= 8388608),
    blob_digest TEXT NOT NULL CHECK (blob_digest ~ '^[0-9a-f]{64}$'), storage_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, run_id, attempt_id, operation_id, object_name, version, chunk_index),
    FOREIGN KEY (tenant_id, project_id, run_id, attempt_id, operation_id, object_name, version)
      REFERENCES factory_artifact_materials (tenant_id, project_id, run_id, attempt_id, operation_id, object_name, version) ON DELETE RESTRICT
  )`);
}
