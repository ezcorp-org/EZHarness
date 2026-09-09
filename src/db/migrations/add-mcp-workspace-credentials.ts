import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS extension_mcp_credentials (workspace_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS extension_mcp_credentials_installation ON extension_mcp_credentials (installation_id)`);
}
