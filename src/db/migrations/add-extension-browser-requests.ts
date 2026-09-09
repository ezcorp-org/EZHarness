import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS extension_browser_admission_lock (id INTEGER PRIMARY KEY CHECK (id=1))`);
  await database.execute(sql`INSERT INTO extension_browser_admission_lock(id) VALUES(1) ON CONFLICT DO NOTHING`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS extension_browser_requests (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    release_binding TEXT NOT NULL,
    conversation_id TEXT,
    payload_digest TEXT NOT NULL,
    deadline BIGINT NOT NULL,
    retain_until BIGINT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('issued','running','cancel_requested','cancelled','finished','outcome_unknown')),
    execution_id TEXT
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS extension_browser_requests_owner ON extension_browser_requests(principal_id)`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS extension_browser_requests_retention ON extension_browser_requests(retain_until,id)`);
}
