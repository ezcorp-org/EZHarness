import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * The three durable facts a `legacy.workflow.v1` adapter needs (C10).
 *
 * `factory_legacy_attestations` holds a tenant administrator's attestation,
 * bound to the pinned definition digest AND to the classification digest, so
 * any definition change — and any change in what the host could resolve when
 * the administrator looked — invalidates it. There is deliberately no
 * foreign key to `workflow_definition_versions`: the binding is by digest,
 * and a key there would make the version retention sweep unable to retire a
 * version an old attestation once named.
 *
 * `factory_legacy_workflow_starts` is the journal written and committed
 * BEFORE the legacy engine is called. After a crash the adapter reads this
 * row, looks the legacy run up by its `factory:` key, and starts again only
 * when the lookup proves nothing was created. The unique index on the key is
 * what makes the lookup total.
 *
 * `factory_legacy_imports` records every digest-verified copy of a legacy
 * output into the factory store. A legacy output is not a factory artifact;
 * this row is the only thing that makes one readable inside a factory
 * project, and it names the exact bytes that were verified on write.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_legacy_attestations (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    definition_digest TEXT NOT NULL CHECK (definition_digest ~ '^[0-9a-f]{64}$'),
    classification_digest TEXT NOT NULL CHECK (classification_digest ~ '^sha256:[0-9a-f]{64}$'),
    classification_json TEXT NOT NULL,
    attested_by TEXT NOT NULL,
    attestation_digest TEXT NOT NULL CHECK (attestation_digest ~ '^sha256:[0-9a-f]{64}$'),
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, workflow_name, definition_digest)
  )`);

  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_legacy_workflow_starts (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    node_instance_id TEXT NOT NULL,
    candidate_generation BIGINT NOT NULL CHECK (candidate_generation >= 0),
    attempt_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK (idempotency_key LIKE 'factory:%'),
    workflow_name TEXT NOT NULL,
    definition_digest TEXT NOT NULL CHECK (definition_digest ~ '^[0-9a-f]{64}$'),
    classification_digest TEXT NOT NULL CHECK (classification_digest ~ '^sha256:[0-9a-f]{64}$'),
    attestation_digest TEXT,
    input_digest TEXT NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
    journal_digest TEXT NOT NULL CHECK (journal_digest ~ '^sha256:[0-9a-f]{64}$'),
    legacy_run_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('journaled', 'started', 'settled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, run_id, node_instance_id, candidate_generation, attempt_id),
    CHECK (state = 'journaled' OR legacy_run_id IS NOT NULL),
    FOREIGN KEY (attempt_id, tenant_id, project_id, run_id) REFERENCES factory_executions (attempt_id, tenant_id, project_id, run_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_legacy_workflow_starts_key ON factory_legacy_workflow_starts (tenant_id, idempotency_key)`);

  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_legacy_imports (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    node_instance_id TEXT NOT NULL,
    candidate_generation BIGINT NOT NULL CHECK (candidate_generation >= 0),
    attempt_id TEXT NOT NULL,
    source_name TEXT NOT NULL,
    legacy_run_id TEXT NOT NULL,
    declared_digest TEXT NOT NULL CHECK (declared_digest ~ '^sha256:[0-9a-f]{64}$'),
    verified_digest TEXT NOT NULL CHECK (verified_digest ~ '^sha256:[0-9a-f]{64}$'),
    byte_count BIGINT NOT NULL CHECK (byte_count > 0),
    object_id TEXT NOT NULL,
    import_digest TEXT NOT NULL CHECK (import_digest ~ '^sha256:[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, run_id, node_instance_id, candidate_generation, attempt_id, source_name),
    CHECK (declared_digest = verified_digest),
    FOREIGN KEY (tenant_id, project_id, run_id, node_instance_id, candidate_generation, attempt_id) REFERENCES factory_legacy_workflow_starts (tenant_id, project_id, run_id, node_instance_id, candidate_generation, attempt_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, object_id) REFERENCES factory_artifacts (tenant_id, project_id, object_id) ON DELETE RESTRICT
  )`);
}
