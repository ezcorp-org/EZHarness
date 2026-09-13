import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Gateway-owned C02 launch intents. The supervisor keeps only live process facts. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_attempt_launches (
    attempt_id TEXT PRIMARY KEY REFERENCES factory_executions(attempt_id) ON DELETE RESTRICT,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    request_json JSONB NOT NULL,
    reservation_id TEXT NOT NULL,
    grant_revision BIGINT NOT NULL CHECK (grant_revision >= 1),
    allocation_generation BIGINT NOT NULL CHECK (allocation_generation >= 1),
    holder_generation BIGINT NOT NULL CHECK (holder_generation >= 1),
    allocation_token TEXT NOT NULL,
    host_id TEXT NOT NULL,
    package_receipt_digest TEXT NOT NULL CHECK (package_receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
    package_receipt_json JSONB NOT NULL,
    artifact_digest TEXT NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
    worker_id TEXT NOT NULL UNIQUE,
    invocation_id TEXT NOT NULL,
    device_grant_json JSONB NOT NULL DEFAULT '{"devices":[],"cdiDevices":[],"capabilities":[]}'::jsonb,
    device_grant_digest TEXT CONSTRAINT factory_attempt_launches_device_grant_digest_check CHECK (device_grant_digest IS NULL OR device_grant_digest ~ '^sha256:[0-9a-f]{64}$'),
    terminal_result_json JSONB,
    terminal_result_digest TEXT CONSTRAINT factory_attempt_launches_terminal_result_digest_check CHECK (terminal_result_digest IS NULL OR terminal_result_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT factory_attempt_launches_terminal_result_paired_check CHECK ((terminal_result_json IS NULL) = (terminal_result_digest IS NULL)),
    state TEXT NOT NULL CHECK (state IN ('prepared','launching','launched','terminal','uncertain')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT
  )`);
  await database.execute(sql`ALTER TABLE factory_attempt_launches ADD COLUMN IF NOT EXISTS package_receipt_json JSONB`);
  // An upgraded database must not keep a NULL where CREATE TABLE forbids one.
  await database.execute(sql`ALTER TABLE factory_attempt_launches ALTER COLUMN package_receipt_json SET NOT NULL`);
  await database.execute(sql`ALTER TABLE factory_attempt_launches ADD COLUMN IF NOT EXISTS host_id TEXT`);
  await database.execute(sql`ALTER TABLE factory_attempt_launches ALTER COLUMN host_id SET NOT NULL`);
  await database.execute(sql`ALTER TABLE factory_attempt_launches ADD COLUMN IF NOT EXISTS device_grant_json JSONB NOT NULL DEFAULT '{"devices":[],"cdiDevices":[],"capabilities":[]}'::jsonb`);
  await database.execute(sql`ALTER TABLE factory_attempt_launches ADD COLUMN IF NOT EXISTS device_grant_digest TEXT`);
  await database.execute(sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_attempt_launches'::regclass AND conname='factory_attempt_launches_device_grant_digest_check') THEN
      ALTER TABLE factory_attempt_launches ADD CONSTRAINT factory_attempt_launches_device_grant_digest_check CHECK (device_grant_digest IS NULL OR device_grant_digest ~ '^sha256:[0-9a-f]{64}$');
    END IF;
  END $$`);
  await database.execute(sql`ALTER TABLE factory_attempt_launches ADD COLUMN IF NOT EXISTS terminal_result_json JSONB`);
  await database.execute(sql`ALTER TABLE factory_attempt_launches ADD COLUMN IF NOT EXISTS terminal_result_digest TEXT`);
  await database.execute(sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_attempt_launches'::regclass AND conname='factory_attempt_launches_terminal_result_digest_check') THEN
      ALTER TABLE factory_attempt_launches ADD CONSTRAINT factory_attempt_launches_terminal_result_digest_check CHECK (terminal_result_digest IS NULL OR terminal_result_digest ~ '^sha256:[0-9a-f]{64}$');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_attempt_launches'::regclass AND conname='factory_attempt_launches_terminal_result_paired_check') THEN
      ALTER TABLE factory_attempt_launches ADD CONSTRAINT factory_attempt_launches_terminal_result_paired_check CHECK ((terminal_result_json IS NULL) = (terminal_result_digest IS NULL));
    END IF;
  END $$`);
  await database.execute(sql`ALTER TABLE factory_attempt_launches ADD COLUMN IF NOT EXISTS invocation_id TEXT`);
  // Reproduce the durable invocation identity of every upgraded row exactly as
  // factoryAttemptInvocationId derives it, so recovery never issues a second one.
  await database.execute(sql`UPDATE factory_attempt_launches AS launch
    SET invocation_id = 'factory_' || substr(encode(sha256(convert_to(launch.attempt_id || ':' || execution.candidate_generation || ':' || execution.attempt_number, 'UTF8')), 'hex'), 1, 48)
    FROM factory_executions AS execution
    WHERE execution.attempt_id = launch.attempt_id AND launch.invocation_id IS NULL`);
  await database.execute(sql`ALTER TABLE factory_attempt_launches ALTER COLUMN invocation_id SET NOT NULL`);
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_attempt_launches_invocation ON factory_attempt_launches (invocation_id)`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_attempt_launches_recovery
    ON factory_attempt_launches(state, updated_at, tenant_id, project_id, attempt_id)`);
}
