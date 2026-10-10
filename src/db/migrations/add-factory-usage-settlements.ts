import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * Sealed usage settlements. One row per reservation revision, carrying the one
 * idempotent `usage-settled` event the kernel folds.
 *
 * `unknown_cost_micros` stays present until a verified provider receipt lands,
 * so an unknown cost is never settled as zero. A reconciliation always carries
 * that receipt digest, and the partial unique index makes a repeat of the same
 * receipt land on the same revision rather than minting a second one.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_usage_settlements (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL, revision BIGINT NOT NULL,
    attempt_id TEXT NOT NULL,
    source TEXT NOT NULL,
    known_cost_micros TEXT NOT NULL,
    unknown_cost_micros TEXT,
    provider_receipt_digest TEXT,
    settled_at_ms BIGINT NOT NULL,
    settlement_digest TEXT NOT NULL,
    event_json TEXT NOT NULL, event_digest TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT factory_usage_settlements_pkey PRIMARY KEY (tenant_id, project_id, run_id, reservation_id, revision),
    CONSTRAINT factory_usage_settlements_reservation_fk FOREIGN KEY (tenant_id, project_id, run_id, reservation_id)
      REFERENCES factory_budget_reservations (tenant_id, project_id, run_id, reservation_id) ON DELETE RESTRICT,
    CONSTRAINT factory_usage_settlements_revision_check CHECK (revision >= 1),
    CONSTRAINT factory_usage_settlements_source_check CHECK (source IN ('stop','reconciliation')),
    CONSTRAINT factory_usage_settlements_known_cost_check CHECK (known_cost_micros ~ '^[0-9]+$'),
    CONSTRAINT factory_usage_settlements_unknown_cost_check CHECK (unknown_cost_micros IS NULL OR unknown_cost_micros ~ '^[0-9]+$'),
    CONSTRAINT factory_usage_settlements_receipt_check CHECK (provider_receipt_digest IS NULL OR provider_receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT factory_usage_settlements_settled_at_ms_check CHECK (settled_at_ms >= 0),
    CONSTRAINT factory_usage_settlements_settlement_digest_check CHECK (settlement_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT factory_usage_settlements_event_digest_check CHECK (event_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT factory_usage_settlements_reconciliation_check CHECK (source <> 'reconciliation' OR provider_receipt_digest IS NOT NULL)
  )`);
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_usage_settlement_receipt
    ON factory_usage_settlements (tenant_id, project_id, run_id, reservation_id, provider_receipt_digest)
    WHERE provider_receipt_digest IS NOT NULL`);
}
