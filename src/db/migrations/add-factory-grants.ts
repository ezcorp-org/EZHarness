import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_grants (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user', 'service')),
    principal_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('factory.author', 'factory.publish', 'factory.run', 'factory.operate', 'factory.approve', 'factory.release', 'factory.trust')),
    issuer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    expires_at TIMESTAMPTZ,
    revision BIGINT NOT NULL CHECK (revision > 0),
    revoked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, principal_kind, principal_id, action),
    FOREIGN KEY (tenant_id, project_id) REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT
  )`);
}
