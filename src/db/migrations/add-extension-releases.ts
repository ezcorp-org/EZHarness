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
  await db.execute(sql`CREATE TABLE IF NOT EXISTS extension_release_names (
    name TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL UNIQUE REFERENCES extension_release_installations(id)
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS extension_release_records (
    installation_id TEXT NOT NULL REFERENCES extension_release_installations(id),
    kind TEXT NOT NULL CHECK (kind IN ('workspaces', 'revisions', 'operations', 'releases', 'approvals')),
    id TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (installation_id, kind, id)
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS extension_release_deliveries (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES extension_release_installations(id),
    deduplication_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'delivered', 'cancelled', 'dead_letter', 'outcome_unknown')),
    available_at BIGINT NOT NULL,
    lease_until BIGINT NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    UNIQUE (installation_id, deduplication_id)
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS extension_release_deliveries_ready ON extension_release_deliveries(state, available_at, lease_until)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS extension_release_data_state (
    installation_id TEXT PRIMARY KEY REFERENCES extension_release_installations(id),
    version TEXT NOT NULL,
    migration_id TEXT
  )`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS extension_release_data_migrations (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES extension_release_installations(id),
    target_release_id TEXT NOT NULL,
    target_version TEXT NOT NULL,
    previous_version TEXT NOT NULL,
    fence INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('preparing', 'prepared', 'committed', 'restored')),
    snapshot TEXT NOT NULL
  )`);
  await db.execute(sql`CREATE OR REPLACE FUNCTION extension_release_storage_gate() RETURNS trigger LANGUAGE plpgsql AS $gate$
    DECLARE active_migration TEXT;
    BEGIN
      SELECT migration_id INTO active_migration FROM extension_release_data_state
      WHERE installation_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.extension_id ELSE NEW.extension_id END FOR SHARE;
      IF active_migration IS NOT NULL AND COALESCE(current_setting('ezcorp.extension_migration', true), '') <> active_migration THEN
        RAISE EXCEPTION 'Extension storage is paused for an approved data migration';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END
  $gate$`);
  await db.execute(sql`DO $gate$ BEGIN
    IF to_regclass('extension_storage') IS NOT NULL THEN
      DROP TRIGGER IF EXISTS extension_release_storage_gate ON extension_storage;
      CREATE TRIGGER extension_release_storage_gate BEFORE INSERT OR UPDATE OR DELETE ON extension_storage FOR EACH ROW EXECUTE FUNCTION extension_release_storage_gate();
    END IF;
  END $gate$`);
}
