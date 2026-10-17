import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Host-owned credentials. The extension record contains only a connection ID. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS provider_connections (
    id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    provider_installation_id TEXT NOT NULL REFERENCES extension_release_installations(id),
    provider_release_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    server_certificate_pem TEXT NOT NULL,
    project TEXT NOT NULL,
    configuration JSONB NOT NULL,
    client_certificate_pem TEXT NOT NULL,
    private_key_ciphertext TEXT NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Earlier local installations may have created the table before reviewed
  // provider configuration was captured. Such rows remain unusable until
  // replaced: resolveForHost validates the JSON and fails closed on NULL.
  await db.execute(sql`ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS configuration JSONB`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_provider_connections_installation
    ON provider_connections(provider_installation_id, provider_release_id)`);
}
