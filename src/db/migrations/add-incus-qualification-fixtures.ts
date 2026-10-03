import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Must run after the sandbox controller creates its binding table. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'user'
    CHECK (purpose IN ('user', 'incus-qualification'))`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_qualification_fixtures (
    operation_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
    binding_id TEXT NOT NULL UNIQUE REFERENCES sandbox_bindings(id) ON DELETE RESTRICT,
    installation_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    connection_revision INTEGER NOT NULL CHECK (connection_revision > 0),
    preset_id TEXT NOT NULL,
    preset_digest TEXT NOT NULL,
    effective_settings_digest TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
