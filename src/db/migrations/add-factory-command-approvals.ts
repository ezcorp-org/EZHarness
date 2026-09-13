import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Durable generic approval requests are bound to one committed interpreter command. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_command_approvals (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, approval_id TEXT NOT NULL,
    run_id TEXT NOT NULL, interpreter_id TEXT NOT NULL, command_id TEXT NOT NULL,
    source_sequence BIGINT NOT NULL CHECK (source_sequence > 0), source_digest TEXT NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
    node_instance_id TEXT NOT NULL, candidate_generation BIGINT NOT NULL CHECK (candidate_generation >= 0), attempt BIGINT NOT NULL CHECK (attempt > 0),
    definition_digest TEXT NOT NULL CHECK (definition_digest ~ '^sha256:[a-f0-9]{64}$'), execution_epoch BIGINT NOT NULL CHECK (execution_epoch > 0), cancellation_epoch BIGINT NOT NULL CHECK (cancellation_epoch >= 0),
    initiator_kind TEXT NOT NULL CHECK (initiator_kind IN ('user','service')), initiator_id TEXT NOT NULL,
    actor_scope TEXT NOT NULL CHECK (actor_scope IN ('owner','operator','tenant-contract-admin')),
    choices_json TEXT NOT NULL, context_json TEXT NOT NULL, deadline_at_ms BIGINT NOT NULL,
    context_digest TEXT NOT NULL CHECK (context_digest ~ '^[a-f0-9]{64}$'), protected_digest TEXT NOT NULL CHECK (protected_digest ~ '^sha256:[a-f0-9]{64}$'),
    status TEXT NOT NULL CHECK (status IN ('pending','answered')), choice TEXT,
    decided_by TEXT REFERENCES users(id) ON DELETE RESTRICT, decided_approve_revision BIGINT CHECK (decided_approve_revision > 0),
    decided_trust_revision BIGINT CHECK (decided_trust_revision > 0), decided_at_ms BIGINT,
    event_json TEXT, event_digest TEXT CHECK (event_digest ~ '^sha256:[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, approval_id),
    UNIQUE (tenant_id, project_id, run_id, interpreter_id, command_id),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, run_id, interpreter_id, source_sequence)
      REFERENCES factory_audit_batches(tenant_id, project_id, run_id, interpreter_id, source_sequence) ON DELETE RESTRICT,
    CHECK ((status='pending' AND choice IS NULL AND decided_by IS NULL AND decided_approve_revision IS NULL AND decided_trust_revision IS NULL AND decided_at_ms IS NULL AND event_json IS NULL AND event_digest IS NULL)
      OR (status='answered' AND choice IS NOT NULL AND decided_by IS NOT NULL AND decided_approve_revision IS NOT NULL AND decided_at_ms IS NOT NULL AND event_json IS NOT NULL AND event_digest IS NOT NULL)),
    CHECK ((actor_scope='tenant-contract-admin') = (decided_trust_revision IS NOT NULL) OR status='pending')
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_command_approvals_pending
    ON factory_command_approvals (tenant_id, project_id, status, deadline_at_ms, approval_id)`);
}
