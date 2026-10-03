import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Versioned encrypted installation data-key wraps; master keys never enter PostgreSQL. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_installation_key_wraps (
    installation_id TEXT NOT NULL, wrap_version INTEGER NOT NULL CHECK (wrap_version > 0), master_key_id TEXT NOT NULL,
    wrapped_data_key BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (installation_id, wrap_version)
  )`);
}
