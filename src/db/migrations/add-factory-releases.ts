import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** C04 release identities survive retries, uncertain outcomes, and ordinary product restore. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_release_policies (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, policy_id TEXT NOT NULL,
    principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user','service')), principal_id TEXT NOT NULL,
    action TEXT NOT NULL, destination_provider TEXT NOT NULL, destination_account TEXT NOT NULL, destination_prefix TEXT NOT NULL, contract_digest TEXT NOT NULL CHECK (contract_digest ~ '^sha256:[0-9a-f]{64}$'),
    revision BIGINT NOT NULL CHECK (revision > 0), max_operations BIGINT NOT NULL CHECK (max_operations > 0), used_operations BIGINT NOT NULL DEFAULT 0 CHECK (used_operations >= 0),
    max_spend_micros BIGINT NOT NULL CHECK (max_spend_micros >= 0), used_spend_micros BIGINT NOT NULL DEFAULT 0 CHECK (used_spend_micros >= 0),
    expires_at_ms BIGINT NOT NULL, revoked_at_ms BIGINT, created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (tenant_id, project_id, policy_id),
    FOREIGN KEY (tenant_id, project_id) REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_release_operations (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, operation_id TEXT NOT NULL, run_id TEXT NOT NULL, node_instance_id TEXT NOT NULL,
    candidate_generation BIGINT NOT NULL CHECK (candidate_generation >= 0), candidate_digest TEXT NOT NULL CHECK (candidate_digest ~ '^sha256:[0-9a-f]{64}$'),
    decision_id TEXT NOT NULL, contract_digest TEXT NOT NULL CHECK (contract_digest ~ '^sha256:[0-9a-f]{64}$'),
    execution_epoch BIGINT NOT NULL CHECK (execution_epoch > 0), cancellation_epoch BIGINT NOT NULL CHECK (cancellation_epoch >= 0), release_enable_epoch BIGINT NOT NULL CHECK (release_enable_epoch > 0),
    action TEXT NOT NULL, destination_provider TEXT NOT NULL, destination_account TEXT NOT NULL, destination_object TEXT NOT NULL, expected_destination_version TEXT,
    destination_digest TEXT NOT NULL CHECK (destination_digest ~ '^sha256:[0-9a-f]{64}$'), canonical_request TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'), material_json TEXT NOT NULL, material_digest TEXT NOT NULL CHECK (material_digest ~ '^sha256:[0-9a-f]{64}$'),
    estimated_spend_micros BIGINT NOT NULL CHECK (estimated_spend_micros >= 0), deadline_ms BIGINT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','executing','succeeded','failed','uncertain')),
    dispatch_generation BIGINT NOT NULL DEFAULT 0 CHECK (dispatch_generation >= 0), sender_token TEXT, dispatch_started BOOLEAN NOT NULL DEFAULT FALSE,
    authority_kind TEXT CHECK (authority_kind IN ('approval','policy')), authority_id TEXT, policy_revision BIGINT,
    intent_archive_json TEXT, material_archive_json TEXT, receipt_archive_json TEXT, receipt_json TEXT,
    archive_ready BOOLEAN NOT NULL DEFAULT FALSE, outcome_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, operation_id),
    UNIQUE (tenant_id, project_id, run_id, node_instance_id, candidate_generation, action, destination_provider, destination_account, destination_object),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, decision_id) REFERENCES factory_acceptance_decisions(tenant_id, project_id, decision_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_release_destination_reservations (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, destination_provider TEXT NOT NULL, destination_account TEXT NOT NULL, destination_object TEXT NOT NULL,
    operation_id TEXT NOT NULL, expected_version TEXT, dispatch_generation BIGINT NOT NULL, state TEXT NOT NULL CHECK (state IN ('held','confirmed','released')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (tenant_id, destination_provider, destination_account, destination_object),
    FOREIGN KEY (tenant_id, project_id, operation_id) REFERENCES factory_release_operations(tenant_id, project_id, operation_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_release_reconciliations (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, reconciliation_id TEXT NOT NULL, operation_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('attach_receipt','confirm_no_effect','keep_uncertain')), operator_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL, provider_evidence_json TEXT NOT NULL, provider_evidence_digest TEXT NOT NULL CHECK (provider_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
    evidence_archive_json TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (tenant_id, project_id, reconciliation_id),
    FOREIGN KEY (tenant_id, project_id, operation_id) REFERENCES factory_release_operations(tenant_id, project_id, operation_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_notifications (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, notification_id TEXT NOT NULL, deduplication_id TEXT NOT NULL,
    input_hash TEXT NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'), state TEXT NOT NULL CHECK (state IN ('queued','leased','delivered','cancelled','dead_letter','outcome_unknown')),
    available_at BIGINT NOT NULL, lease_until BIGINT NOT NULL DEFAULT 0, payload TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, notification_id), UNIQUE (tenant_id, project_id, deduplication_id),
    FOREIGN KEY (tenant_id, project_id) REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_notifications_ready ON factory_notifications (tenant_id, project_id, state, available_at, lease_until)`);
  await database.execute(sql`DO $$ DECLARE constraint_name TEXT; BEGIN
    SELECT conname INTO constraint_name FROM pg_constraint
      WHERE conrelid='factory_release_approvals'::regclass AND contype='u' AND pg_get_constraintdef(oid) LIKE '%operation_id%' LIMIT 1;
    IF constraint_name IS NOT NULL THEN EXECUTE format('ALTER TABLE factory_release_approvals DROP CONSTRAINT %I', constraint_name); END IF;
  END $$`);
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_release_approvals_operation_generation
    ON factory_release_approvals (tenant_id, project_id, operation_id, expected_generation)`);
}
