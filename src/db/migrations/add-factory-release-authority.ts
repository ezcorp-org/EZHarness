import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";
import { ensureFactoryArtifactAdmissionIndex } from "./factory-artifact-admission-index";

/** Durable terminal, trust, enablement, and current-candidate facts for C04 authority. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_executions DROP CONSTRAINT IF EXISTS factory_executions_status_check`);
  await database.execute(sql`ALTER TABLE factory_executions ADD CONSTRAINT factory_executions_status_check CHECK (status IN ('admitted','running','completed','cancel_accepted','stopped','failed'))`);
  await database.execute(sql`ALTER TABLE factory_artifacts DROP CONSTRAINT IF EXISTS factory_artifacts_encoded_bytes_check`);
  await database.execute(sql`ALTER TABLE factory_artifacts ADD COLUMN IF NOT EXISTS candidate_node_instance_id TEXT`);
  await database.execute(sql`ALTER TABLE factory_artifacts ADD COLUMN IF NOT EXISTS candidate_generation BIGINT`);
  // A later step widens this same check. Re-adding the narrow form on every
  // boot would reject rows that step already admitted, so only install it when
  // the database has not reached this widening yet.
  await database.execute(sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_artifacts'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%candidate_output%' AND pg_get_constraintdef(oid) LIKE '%kind%' AND pg_get_constraintdef(oid) NOT LIKE '%encoded_bytes%') THEN
      ALTER TABLE factory_artifacts DROP CONSTRAINT IF EXISTS factory_artifacts_kind_check;
      ALTER TABLE factory_artifacts ADD CONSTRAINT factory_artifacts_kind_check CHECK (kind IN ('definition_page','definition_manifest','transition_page','transition_manifest','execution_manifest','partition','candidate_output'));
    END IF;
  END $$`);
  await database.execute(sql`ALTER TABLE factory_artifacts ADD CONSTRAINT factory_artifacts_encoded_bytes_check CHECK (encoded_bytes > 0 AND ((kind='candidate_output' AND encoded_bytes <= 16777216) OR (kind<>'candidate_output' AND encoded_bytes <= 32768)))`);
  await database.execute(sql`ALTER TABLE factory_artifacts DROP CONSTRAINT IF EXISTS factory_artifacts_candidate_slot_check`);
  await database.execute(sql`ALTER TABLE factory_artifacts ADD CONSTRAINT factory_artifacts_candidate_slot_check CHECK ((kind='candidate_output' AND candidate_node_instance_id IS NOT NULL AND candidate_generation >= 0) OR (kind<>'candidate_output' AND candidate_node_instance_id IS NULL AND candidate_generation IS NULL))`);
  await ensureFactoryArtifactAdmissionIndex(database);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_execution_terminals (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, node_instance_id TEXT NOT NULL, candidate_generation BIGINT NOT NULL CHECK (candidate_generation >= 0),
    attempt_id TEXT NOT NULL PRIMARY KEY REFERENCES factory_executions(attempt_id) ON DELETE RESTRICT, request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    result_digest TEXT NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'), terminal_result_digest TEXT NOT NULL CHECK (terminal_result_digest ~ '^sha256:[0-9a-f]{64}$'), result_json TEXT NOT NULL,
    output_artifact_id TEXT NOT NULL, output_digest TEXT NOT NULL CHECK (output_digest ~ '^sha256:[0-9a-f]{64}$'), output_bytes INTEGER NOT NULL CHECK (output_bytes > 0 AND output_bytes <= 16777216),
    execution_epoch BIGINT NOT NULL CHECK (execution_epoch > 0), cancellation_epoch BIGINT NOT NULL CHECK (cancellation_epoch >= 0), terminal_fact_digest TEXT NOT NULL CHECK (terminal_fact_digest ~ '^sha256:[0-9a-f]{64}$'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id,project_id,run_id,node_instance_id,candidate_generation),
    FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES factory_runs(tenant_id,project_id,run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id,project_id,output_artifact_id) REFERENCES factory_artifacts(tenant_id,project_id,object_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_release_trust_revisions (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, revision BIGINT NOT NULL CHECK (revision > 0), state TEXT NOT NULL CHECK (state IN ('active','revoked')),
    package_lock_json TEXT NOT NULL, package_trust_digest TEXT NOT NULL CHECK (package_trust_digest ~ '^sha256:[0-9a-f]{64}$'), validator_trust_digest TEXT NOT NULL CHECK (validator_trust_digest ~ '^sha256:[0-9a-f]{64}$'),
    approved_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, approval_grant_revision BIGINT NOT NULL CHECK (approval_grant_revision > 0), protected_digest TEXT NOT NULL CHECK (protected_digest ~ '^sha256:[0-9a-f]{64}$'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id,project_id,revision), FOREIGN KEY (tenant_id,project_id) REFERENCES factory_projects(tenant_id,project_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_release_trust_current (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, revision BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (tenant_id,project_id),
    FOREIGN KEY (tenant_id,project_id,revision) REFERENCES factory_release_trust_revisions(tenant_id,project_id,revision) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_release_controls (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT FALSE, enable_epoch BIGINT NOT NULL CHECK (enable_epoch > 0),
    changed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, grant_revision BIGINT NOT NULL CHECK (grant_revision > 0), protected_digest TEXT NOT NULL CHECK (protected_digest ~ '^sha256:[0-9a-f]{64}$'), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id,project_id), FOREIGN KEY (tenant_id,project_id) REFERENCES factory_projects(tenant_id,project_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_release_candidate_history (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, node_instance_id TEXT NOT NULL, candidate_generation BIGINT NOT NULL CHECK (candidate_generation >= 0), candidate_digest TEXT NOT NULL CHECK (candidate_digest ~ '^sha256:[0-9a-f]{64}$'),
    attempt_id TEXT NOT NULL, execution_epoch BIGINT NOT NULL CHECK (execution_epoch > 0), cancellation_epoch BIGINT NOT NULL CHECK (cancellation_epoch >= 0), terminal_fact_digest TEXT NOT NULL CHECK (terminal_fact_digest ~ '^sha256:[0-9a-f]{64}$'),
    output_artifact_id TEXT NOT NULL, output_bytes INTEGER NOT NULL CHECK (output_bytes > 0 AND output_bytes <= 16777216), trust_revision BIGINT NOT NULL, package_trust_digest TEXT NOT NULL CHECK (package_trust_digest ~ '^sha256:[0-9a-f]{64}$'), validator_trust_digest TEXT NOT NULL CHECK (validator_trust_digest ~ '^sha256:[0-9a-f]{64}$'),
    proof_digest TEXT NOT NULL CHECK (proof_digest ~ '^sha256:[0-9a-f]{64}$'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (tenant_id,project_id,run_id,node_instance_id,candidate_generation), UNIQUE (attempt_id),
    FOREIGN KEY (attempt_id) REFERENCES factory_execution_terminals(attempt_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id,project_id,run_id) REFERENCES factory_runs(tenant_id,project_id,run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id,project_id,trust_revision) REFERENCES factory_release_trust_revisions(tenant_id,project_id,revision) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id,project_id,output_artifact_id) REFERENCES factory_artifacts(tenant_id,project_id,object_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_release_current_candidates (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, node_instance_id TEXT NOT NULL, candidate_generation BIGINT NOT NULL CHECK (candidate_generation >= 0), candidate_digest TEXT NOT NULL CHECK (candidate_digest ~ '^sha256:[0-9a-f]{64}$'), attempt_id TEXT NOT NULL, pointer_revision BIGINT NOT NULL CHECK (pointer_revision > 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id,project_id,run_id,node_instance_id),
    FOREIGN KEY (tenant_id,project_id,run_id,node_instance_id,candidate_generation) REFERENCES factory_release_candidate_history(tenant_id,project_id,run_id,node_instance_id,candidate_generation) ON DELETE RESTRICT
  )`);
}
