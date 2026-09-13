import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Scoped v4 release bindings and verified local runner preparation receipts. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_runner_package_bindings (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
    package_name TEXT NOT NULL, package_version TEXT NOT NULL, package_digest TEXT NOT NULL, export_name TEXT NOT NULL,
    installation_id TEXT NOT NULL REFERENCES extension_release_installations(id) ON DELETE RESTRICT,
    release_id TEXT NOT NULL, release_digest TEXT NOT NULL CHECK (release_digest ~ '^[0-9a-f]{64}$'),
    source_digest TEXT NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'), artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
    image_digest TEXT NOT NULL, manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
    issuer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, issuer_grant_revision BIGINT NOT NULL CHECK (issuer_grant_revision > 0),
    protected_digest TEXT NOT NULL CHECK (protected_digest ~ '^sha256:[0-9a-f]{64}$'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, package_name, package_version, package_digest, export_name),
    FOREIGN KEY (tenant_id, project_id) REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_runner_package_trust_revisions (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, package_name TEXT NOT NULL, package_version TEXT NOT NULL, package_digest TEXT NOT NULL, export_name TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0), state TEXT NOT NULL CHECK (state IN ('active','revoked')), package_trust_digest TEXT NOT NULL CHECK (package_trust_digest ~ '^sha256:[0-9a-f]{64}$'), approved_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, approval_grant_revision BIGINT NOT NULL CHECK (approval_grant_revision > 0), protected_digest TEXT NOT NULL CHECK (protected_digest ~ '^sha256:[0-9a-f]{64}$'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id,project_id,package_name,package_version,package_digest,export_name,revision), FOREIGN KEY (tenant_id,project_id,package_name,package_version,package_digest,export_name) REFERENCES factory_runner_package_bindings(tenant_id,project_id,package_name,package_version,package_digest,export_name) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_runner_package_trust_current (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, package_name TEXT NOT NULL, package_version TEXT NOT NULL, package_digest TEXT NOT NULL, export_name TEXT NOT NULL, revision BIGINT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id,project_id,package_name,package_version,package_digest,export_name), FOREIGN KEY (tenant_id,project_id,package_name,package_version,package_digest,export_name,revision) REFERENCES factory_runner_package_trust_revisions(tenant_id,project_id,package_name,package_version,package_digest,export_name,revision) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_runner_preparation_intents (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, package_name TEXT NOT NULL, package_version TEXT NOT NULL, package_digest TEXT NOT NULL, export_name TEXT NOT NULL, trust_revision BIGINT NOT NULL, package_trust_digest TEXT NOT NULL CHECK (package_trust_digest ~ '^sha256:[0-9a-f]{64}$'), installation_id TEXT NOT NULL, release_id TEXT NOT NULL, release_digest TEXT NOT NULL CHECK (release_digest ~ '^[0-9a-f]{64}$'), source_digest TEXT NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'), artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'), image_digest TEXT NOT NULL, manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'), issuer_id TEXT NOT NULL, issuer_grant_revision BIGINT NOT NULL CHECK (issuer_grant_revision > 0), binding_protected_digest TEXT NOT NULL CHECK (binding_protected_digest ~ '^sha256:[0-9a-f]{64}$'), evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'), entrypoint TEXT NOT NULL, intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'), build_identity TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('prepared','completed')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id,project_id,package_name,package_version,package_digest,export_name,trust_revision), FOREIGN KEY (tenant_id,project_id,package_name,package_version,package_digest,export_name,trust_revision) REFERENCES factory_runner_package_trust_revisions(tenant_id,project_id,package_name,package_version,package_digest,export_name,revision) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_runner_preparation_receipts (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
    package_name TEXT NOT NULL, package_version TEXT NOT NULL, package_digest TEXT NOT NULL, export_name TEXT NOT NULL,
    trust_revision BIGINT NOT NULL CHECK (trust_revision > 0), package_trust_digest TEXT NOT NULL CHECK (package_trust_digest ~ '^sha256:[0-9a-f]{64}$'),
    release_digest TEXT NOT NULL CHECK (release_digest ~ '^[0-9a-f]{64}$'), source_digest TEXT NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'), artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'), image_digest TEXT NOT NULL, manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'), evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
    build_identity TEXT NOT NULL, receipt_digest TEXT NOT NULL CHECK (receipt_digest ~ '^sha256:[0-9a-f]{64}$'), prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, package_name, package_version, package_digest, export_name, trust_revision),
    FOREIGN KEY (tenant_id, project_id, package_name, package_version, package_digest, export_name)
      REFERENCES factory_runner_package_bindings(tenant_id, project_id, package_name, package_version, package_digest, export_name) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id,project_id,package_name,package_version,package_digest,export_name,trust_revision)
      REFERENCES factory_runner_package_trust_revisions(tenant_id,project_id,package_name,package_version,package_digest,export_name,revision) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_runner_preparation_current
    ON factory_runner_preparation_receipts (tenant_id, project_id, package_name, package_version, package_digest, export_name, trust_revision DESC)`);
}
