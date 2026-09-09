import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS extension_event_admission_lock (id INTEGER PRIMARY KEY CHECK (id = 1))`);
  await database.execute(sql`INSERT INTO extension_event_admission_lock(id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS extension_event_receipts (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    identity_digest TEXT NOT NULL,
    retain_until BIGINT NOT NULL,
    payload TEXT NOT NULL
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS extension_event_receipts_retention ON extension_event_receipts(retain_until, id)`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS extension_event_receipts_principal ON extension_event_receipts(principal_id)`);
}
