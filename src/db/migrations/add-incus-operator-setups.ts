import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** A reviewed plan and its outcome survive process restarts. Never store key material here. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS incus_operator_setups (
    id TEXT PRIMARY KEY,
    provider_installation_id TEXT NOT NULL REFERENCES extension_release_installations(id),
    provider_release_id TEXT NOT NULL,
    provider_release_digest TEXT NOT NULL,
    provider_generation INTEGER NOT NULL,
    connection_id TEXT NOT NULL REFERENCES provider_connections(id),
    connection_revision INTEGER NOT NULL,
    planned_by TEXT NOT NULL,
    applied_by TEXT,
    apply_token TEXT,
    recipe JSONB NOT NULL,
    plan JSONB NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('planned', 'applying', 'applied', 'verified', 'blocked', 'review_required', 'reconcile_required')),
    receipt JSONB,
    failures JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`ALTER TABLE incus_operator_setups ADD COLUMN IF NOT EXISTS applied_by TEXT`);
  await db.execute(sql`ALTER TABLE incus_operator_setups ADD COLUMN IF NOT EXISTS apply_token TEXT`);
  await db.execute(sql`ALTER TABLE incus_operator_setups ADD COLUMN IF NOT EXISTS capacity_receipt JSONB`);
  await db.execute(sql`ALTER TABLE incus_operator_setups ADD COLUMN IF NOT EXISTS capacity_applied_by TEXT`);
  await db.execute(sql`ALTER TABLE incus_operator_setups ADD COLUMN IF NOT EXISTS capacity_applied_at TIMESTAMPTZ`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_incus_operator_setups_installation
    ON incus_operator_setups(provider_installation_id, created_at DESC)`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_incus_operator_one_apply_per_installation
    ON incus_operator_setups(provider_installation_id) WHERE state = 'applying'`);
}
