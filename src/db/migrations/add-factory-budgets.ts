import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_budget_envelopes (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    envelope_id TEXT NOT NULL, parent_id TEXT, request_digest TEXT NOT NULL,
    limits TEXT NOT NULL, allocated TEXT NOT NULL, spent TEXT NOT NULL,
    deadline_ms BIGINT NOT NULL CHECK (deadline_ms > 0),
    state TEXT NOT NULL CHECK (state IN ('open', 'closed')), admission_blocked BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (tenant_id, project_id, run_id, envelope_id),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, project_id, run_id, parent_id) REFERENCES factory_budget_envelopes(tenant_id, project_id, run_id, envelope_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS factory_budget_root ON factory_budget_envelopes (tenant_id, project_id, run_id) WHERE parent_id IS NULL`);
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_budget_reservations (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL, envelope_id TEXT NOT NULL, request_digest TEXT NOT NULL,
    amount TEXT NOT NULL, actual TEXT, receipt_digest TEXT,
    compute_allocation TEXT, uncertainty TEXT,
    state TEXT NOT NULL CHECK (state IN ('held', 'running', 'uncertain', 'settled')),
    PRIMARY KEY (tenant_id, project_id, run_id, reservation_id),
    FOREIGN KEY (tenant_id, project_id, run_id, envelope_id) REFERENCES factory_budget_envelopes(tenant_id, project_id, run_id, envelope_id) ON DELETE RESTRICT
  )`);
}
