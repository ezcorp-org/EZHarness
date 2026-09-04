import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS extension_release_installations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    payload TEXT NOT NULL
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS extension_release_installations_owner ON extension_release_installations(owner_id, scope)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS extension_release_records (
    installation_id TEXT NOT NULL REFERENCES extension_release_installations(id),
    kind TEXT NOT NULL CHECK (kind IN ('workspaces', 'revisions', 'operations', 'releases', 'approvals')),
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (installation_id, kind, id)
  )`);
}
