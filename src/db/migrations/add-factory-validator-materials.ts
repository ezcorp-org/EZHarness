import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Immutable C04 validator material, assignment, and measured-result facts. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_validator_materials (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, factory_id TEXT NOT NULL, factory_version TEXT NOT NULL,
    definition_digest TEXT NOT NULL CHECK (definition_digest ~ '^sha256:[0-9a-f]{64}$'),
    contract_id TEXT NOT NULL, contract_version TEXT NOT NULL,
    contract_digest TEXT NOT NULL CHECK (contract_digest ~ '^sha256:[0-9a-f]{64}$'),
    validator_lock_digest TEXT NOT NULL CHECK (validator_lock_digest ~ '^sha256:[0-9a-f]{64}$'),
    mandatory_claims TEXT NOT NULL CHECK (octet_length(mandatory_claims) <= 65536),
    claim_groups TEXT NOT NULL CHECK (octet_length(claim_groups) <= 65536),
    validators_json TEXT NOT NULL CHECK (octet_length(validators_json) <= 1048576),
    material_digest TEXT NOT NULL CHECK (material_digest ~ '^sha256:[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, factory_id, factory_version),
    UNIQUE (tenant_id, project_id, validator_lock_digest),
    FOREIGN KEY (tenant_id, project_id, factory_id, factory_version) REFERENCES factory_versions(tenant_id, project_id, factory_id, version) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_validator_assignments (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    candidate_node_instance_id TEXT NOT NULL, candidate_generation BIGINT NOT NULL CHECK (candidate_generation >= 0), validator_id TEXT NOT NULL,
    validator_attempt_id TEXT NOT NULL, validator_authority_json TEXT NOT NULL CHECK (octet_length(validator_authority_json) <= 65536),
    definition_digest TEXT NOT NULL CHECK (definition_digest ~ '^sha256:[0-9a-f]{64}$'),
    validator_lock_digest TEXT NOT NULL CHECK (validator_lock_digest ~ '^sha256:[0-9a-f]{64}$'),
    candidate_digest TEXT NOT NULL CHECK (candidate_digest ~ '^sha256:[0-9a-f]{64}$'),
    candidate_artifact_id TEXT NOT NULL, candidate_artifact_digest TEXT NOT NULL CHECK (candidate_artifact_digest ~ '^sha256:[0-9a-f]{64}$'), candidate_artifact_bytes BIGINT NOT NULL CHECK (candidate_artifact_bytes > 0),
    runner_json TEXT NOT NULL CHECK (octet_length(runner_json) <= 65536), runner_digest TEXT NOT NULL CHECK (runner_digest ~ '^sha256:[0-9a-f]{64}$'),
    environment_digest TEXT NOT NULL CHECK (environment_digest ~ '^sha256:[0-9a-f]{64}$'), configuration_digest TEXT NOT NULL CHECK (configuration_digest ~ '^sha256:[0-9a-f]{64}$'),
    freshness_ms BIGINT NOT NULL CHECK (freshness_ms > 0 AND freshness_ms <= 86400000),
    trust_revision BIGINT NOT NULL CHECK (trust_revision > 0), issuer_grant_revision BIGINT NOT NULL CHECK (issuer_grant_revision > 0),
    assignment_digest TEXT NOT NULL CHECK (assignment_digest ~ '^sha256:[0-9a-f]{64}$'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, run_id, candidate_node_instance_id, candidate_generation, validator_id),
    FOREIGN KEY (tenant_id, project_id, validator_lock_digest) REFERENCES factory_validator_materials(tenant_id, project_id, validator_lock_digest) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, run_id, candidate_node_instance_id, candidate_generation) REFERENCES factory_release_candidate_history(tenant_id, project_id, run_id, node_instance_id, candidate_generation) ON DELETE RESTRICT,
    FOREIGN KEY (validator_attempt_id, tenant_id, project_id, run_id) REFERENCES factory_executions(attempt_id, tenant_id, project_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, candidate_artifact_id) REFERENCES factory_artifacts(tenant_id, project_id, object_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_validator_assignment_attempt_claim
    ON factory_validator_assignments(tenant_id,project_id,validator_attempt_id,validator_id)`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_validator_results (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, validator_attempt_id TEXT NOT NULL, validator_id TEXT NOT NULL,
    terminal_fact_digest TEXT NOT NULL CHECK (terminal_fact_digest ~ '^sha256:[0-9a-f]{64}$'),
    artifact_id TEXT NOT NULL, artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'), artifact_bytes BIGINT NOT NULL CHECK (artifact_bytes > 0),
    claims_json TEXT NOT NULL CHECK (octet_length(claims_json) <= 65536),
    issued_at_ms BIGINT NOT NULL CHECK (issued_at_ms > 0), expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > issued_at_ms),
    evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'), result_digest TEXT NOT NULL CHECK (result_digest ~ '^sha256:[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, validator_attempt_id, validator_id),
    CONSTRAINT factory_validator_results_assignment_fkey FOREIGN KEY (tenant_id, project_id, validator_attempt_id, validator_id) REFERENCES factory_validator_assignments(tenant_id, project_id, validator_attempt_id, validator_id) ON DELETE RESTRICT,
    FOREIGN KEY (validator_attempt_id) REFERENCES factory_execution_terminals(attempt_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, artifact_id) REFERENCES factory_artifacts(tenant_id, project_id, object_id) ON DELETE RESTRICT
  )`);
}
