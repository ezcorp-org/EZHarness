import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS extension_project_bindings (
    installation_id TEXT PRIMARY KEY REFERENCES extension_release_installations(id),
    payload TEXT NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS extension_project_decisions (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES extension_release_installations(id),
    state TEXT NOT NULL CHECK (state IN ('proposed', 'approved', 'rejected', 'executing', 'completed', 'failed')),
    payload TEXT NOT NULL
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS extension_project_binding_events (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES extension_release_installations(id),
    payload TEXT NOT NULL
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS extension_project_decisions_installation ON extension_project_decisions(installation_id)`);
}
