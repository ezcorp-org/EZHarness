import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS extension_runtime_locks (
    installation_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
    lock_key TEXT NOT NULL,
    fence TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    principal_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    deadline TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('held', 'quarantined')),
    effects INTEGER NOT NULL DEFAULT 0 CHECK (effects >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (installation_id, lock_key)
  )`);
}
