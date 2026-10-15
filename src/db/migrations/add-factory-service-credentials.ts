import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Public factory service credentials. Raw signed tokens are never stored. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_service_accounts_id_project
    ON service_accounts (id, project_id)`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_service_credentials (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    service_account_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    scopes JSONB NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    issued_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, service_account_id, credential_id),
    FOREIGN KEY (tenant_id, project_id) REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (service_account_id, project_id) REFERENCES service_accounts(id, project_id) ON DELETE CASCADE,
    CHECK (expires_at > issued_at),
    CHECK (expires_at <= issued_at + INTERVAL '1 hour'),
    CHECK (jsonb_typeof(scopes) = 'array' AND jsonb_array_length(scopes) BETWEEN 1 AND 3 AND scopes <@ '["read","write","chat"]'::jsonb)
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_service_credentials_live
    ON factory_service_credentials (tenant_id, project_id, service_account_id, credential_id, revision)`);
}
