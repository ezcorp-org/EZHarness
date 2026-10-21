import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * C11 N1 (W4H-34): one outbound send per in-app-delivered notification and
 * declared destination, on the C02 delivery-queue states. The deduplication ID
 * is the send's Idempotency-Key (a hash, never a joined string), and a unique
 * index on (tenant, project, notification, destination) makes a second fan-out
 * a no-op. The foreign key keeps a send from outliving its notification.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_notification_sends (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, send_id TEXT NOT NULL, notification_id TEXT NOT NULL,
    destination TEXT NOT NULL CHECK (destination ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'), deduplication_id TEXT NOT NULL,
    input_hash TEXT NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
    state TEXT NOT NULL CHECK (state IN ('queued','leased','delivered','cancelled','dead_letter','outcome_unknown')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 16),
    available_at BIGINT NOT NULL, lease_until BIGINT NOT NULL DEFAULT 0, lease_token TEXT, failure_code TEXT CHECK (failure_code ~ '^[a-zA-Z0-9_-]{1,128}$'),
    expires_at BIGINT NOT NULL, payload TEXT NOT NULL CHECK (octet_length(payload) <= 4096), created_at BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, send_id), UNIQUE (tenant_id, deduplication_id),
    FOREIGN KEY (tenant_id, project_id, notification_id) REFERENCES factory_notifications(tenant_id, project_id, notification_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_notification_sends_ready ON factory_notification_sends (tenant_id, state, available_at, lease_until)`);
  // One send per notification and destination; the fan-out's existence probe and the foreign key both use it.
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_notification_sends_notification ON factory_notification_sends (tenant_id, project_id, notification_id, destination)`);
}
