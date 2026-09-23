import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Live evidence is host-owned and scoped to one connection revision. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_live_qualifications (
    installation_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    release_digest TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    connection_revision INTEGER NOT NULL CHECK (connection_revision > 0),
    preset_id TEXT NOT NULL,
    preset_digest TEXT NOT NULL,
    effective_settings_digest TEXT NOT NULL,
    profile TEXT NOT NULL,
    image_digest TEXT NOT NULL,
    helper_digest TEXT NOT NULL,
    probe_observation JSONB NOT NULL,
    live_observation JSONB NOT NULL,
    qualification JSONB NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (installation_id, connection_id, preset_id)
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_incus_live_qualifications_expiry
    ON incus_live_qualifications(valid_until)`);
}
