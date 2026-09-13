import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** C04 records are additive and retain consumed authority for the release audit period. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_acceptance_contracts (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, contract_id TEXT NOT NULL, revision BIGINT NOT NULL CHECK (revision > 0),
    contract_digest TEXT NOT NULL CHECK (contract_digest ~ '^sha256:[0-9a-f]{64}$'), validator_lock_digest TEXT NOT NULL CHECK (validator_lock_digest ~ '^sha256:[0-9a-f]{64}$'),
    mandatory_claims TEXT NOT NULL, claim_groups TEXT NOT NULL, approved_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    approval_grant_revision BIGINT NOT NULL CHECK (approval_grant_revision > 0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, contract_id, revision),
    FOREIGN KEY (tenant_id, project_id) REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_acceptance_evidence (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, evidence_id TEXT NOT NULL, run_id TEXT NOT NULL, node_instance_id TEXT NOT NULL,
    candidate_generation BIGINT NOT NULL CHECK (candidate_generation >= 0), candidate_digest TEXT NOT NULL CHECK (candidate_digest ~ '^sha256:[0-9a-f]{64}$'),
    validator_id TEXT NOT NULL, validator_lock_digest TEXT NOT NULL CHECK (validator_lock_digest ~ '^sha256:[0-9a-f]{64}$'), issuer_grant_revision BIGINT NOT NULL CHECK (issuer_grant_revision > 0),
    artifact_id TEXT NOT NULL, artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'), artifact_bytes BIGINT NOT NULL CHECK (artifact_bytes >= 0),
    environment_digest TEXT NOT NULL CHECK (environment_digest ~ '^sha256:[0-9a-f]{64}$'), configuration_digest TEXT NOT NULL CHECK (configuration_digest ~ '^sha256:[0-9a-f]{64}$'), runner_digest TEXT NOT NULL CHECK (runner_digest ~ '^sha256:[0-9a-f]{64}$'),
    claims TEXT NOT NULL, issued_at_ms BIGINT NOT NULL, expires_at_ms BIGINT NOT NULL, evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, evidence_id), UNIQUE (tenant_id, project_id, run_id, node_instance_id, candidate_generation, validator_id),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_acceptance_decisions (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, decision_id TEXT NOT NULL, contract_id TEXT NOT NULL, contract_revision BIGINT NOT NULL,
    contract_digest TEXT NOT NULL CHECK (contract_digest ~ '^sha256:[0-9a-f]{64}$'), candidate_digest TEXT NOT NULL CHECK (candidate_digest ~ '^sha256:[0-9a-f]{64}$'), evidence_set_digest TEXT NOT NULL CHECK (evidence_set_digest ~ '^sha256:[0-9a-f]{64}$'), decision_digest TEXT NOT NULL CHECK (decision_digest ~ '^sha256:[0-9a-f]{64}$'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, decision_id),
    FOREIGN KEY (tenant_id, project_id, contract_id, contract_revision) REFERENCES factory_acceptance_contracts(tenant_id, project_id, contract_id, revision) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_release_approvals (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, approval_id TEXT NOT NULL, operation_id TEXT NOT NULL, context_digest TEXT NOT NULL CHECK (context_digest ~ '^[a-f0-9]{64}$'),
    decision_id TEXT NOT NULL, principal_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, grant_revision BIGINT NOT NULL CHECK (grant_revision > 0),
    expected_generation BIGINT NOT NULL CHECK (expected_generation >= 0), expires_at_ms BIGINT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','consumed','revoked')),
    approved_by TEXT REFERENCES users(id) ON DELETE RESTRICT, approved_grant_revision BIGINT CHECK (approved_grant_revision > 0), consumed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, approval_id), UNIQUE (tenant_id, project_id, operation_id),
    FOREIGN KEY (tenant_id, project_id, decision_id) REFERENCES factory_acceptance_decisions(tenant_id, project_id, decision_id) ON DELETE RESTRICT
  )`);
}
