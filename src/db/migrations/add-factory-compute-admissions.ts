import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Product-side recovery state for the independent compute pool. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_compute_admissions (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'), request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'admitted', 'rejected', 'cancelling', 'cancelled')),
    next_poll_at BIGINT NOT NULL CHECK (next_poll_at >= 0), remote_attempted BOOLEAN NOT NULL DEFAULT FALSE,
    poll_lease_until BIGINT NOT NULL DEFAULT 0 CHECK (poll_lease_until >= 0), poll_lease_token TEXT,
    response_digest TEXT, response_json TEXT, event_digest TEXT, event_json TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, project_id, run_id, reservation_id),
    FOREIGN KEY (tenant_id, project_id, run_id, reservation_id) REFERENCES factory_budget_reservations(tenant_id, project_id, run_id, reservation_id) ON DELETE RESTRICT,
    CHECK ((poll_lease_token IS NULL) = (poll_lease_until = 0)),
    CHECK ((response_digest IS NULL) = (response_json IS NULL)),
    CHECK ((event_digest IS NULL) = (event_json IS NULL)),
    CHECK ((state IN ('admitted', 'rejected')) = (event_json IS NOT NULL))
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_compute_admissions_poll ON factory_compute_admissions (tenant_id, next_poll_at, created_at, reservation_id) WHERE state IN ('pending', 'queued', 'cancelling')`);
}
