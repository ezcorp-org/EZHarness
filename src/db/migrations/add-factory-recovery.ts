import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * C06 retention, compatible checkpoints, and restore epochs (W15).
 *
 * Three database gates live here because each one must hold for every writer,
 * including writers in files this package does not own:
 *
 * - `factory_checkpoint_barrier_gate` is a statement trigger on every
 *   `factory_*` product table. Each writing transaction takes one shared
 *   advisory lock on its first write and marks itself a member. A checkpoint
 *   barrier takes the same lock exclusively, so no factory write can commit
 *   between the recorded recovery position and the sealed manifest. While a
 *   barrier is pausing, a transaction that has not written yet waits on a
 *   second lock the barrier holds, and a member never waits, so the barrier
 *   never enters a lock cycle with a product transaction.
 * - `factory_effect_claim_gate` closes a release claim and an attempt launch
 *   claim while a restore epoch is open, and while the newest sealed
 *   checkpoint is older than the tenant's bound when the bound is enforced.
 * - `factory_restore_admission_gate` closes run admission while a restore
 *   epoch is open.
 *
 * Retention periods are enforced by a CHECK, so a release can extend a
 * deadline and nothing can shorten it below the advertised class period.
 * Every constraint is named, so a fresh and an upgraded database match.
 */

/** Tables the barrier gate never guards: the barrier and restore write them while holding it. */
export const FACTORY_RECOVERY_UNGATED_TABLES = Object.freeze([
  "factory_checkpoint_gate",
  "factory_checkpoints",
  "factory_checkpoint_policy",
  "factory_restore_epochs",
  "factory_restore_findings",
  "factory_recovered_releases",
] as const);

const DAY_MS = 86_400_000;
/** Minimum retention per class, in milliseconds after the anchor. */
export const FACTORY_RETENTION_PERIOD_MS = Object.freeze({
  ordinary_history: 30 * DAY_MS,
  unaccepted_candidate: 90 * DAY_MS,
  debug_log: 90 * DAY_MS,
  canonical_audit: 365 * DAY_MS,
  accepted_evidence: 365 * DAY_MS,
  approval: 365 * DAY_MS,
  release: 365 * DAY_MS,
  receipt: 365 * DAY_MS,
  key_version: 365 * DAY_MS,
} as const);

export type FactoryRetentionClass = keyof typeof FACTORY_RETENTION_PERIOD_MS;
export const FACTORY_RETENTION_CLASSES = Object.freeze(Object.keys(FACTORY_RETENTION_PERIOD_MS) as FactoryRetentionClass[]);
export const FACTORY_RETENTION_SUBJECT_KINDS = Object.freeze(["run_audit", "candidate_artifact", "key_wrap", "release"] as const);
export type FactoryRetentionSubjectKind = (typeof FACTORY_RETENTION_SUBJECT_KINDS)[number];

function quoted(values: readonly string[]): string {
  return values.map(value => `'${value}'`).join(",");
}

const periodCase = `CASE retention_class ${Object.entries(FACTORY_RETENTION_PERIOD_MS).map(([name, period]) => `WHEN '${name}' THEN ${period}`).join(" ")} END`;

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql.raw(`CREATE TABLE IF NOT EXISTS factory_retention_records (
    tenant_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
    project_id TEXT, run_id TEXT, retention_class TEXT NOT NULL,
    anchored_at_ms BIGINT NOT NULL, retain_until_ms BIGINT NOT NULL, extension_reason TEXT,
    state TEXT NOT NULL DEFAULT 'retained',
    archive_json TEXT, archive_digest TEXT, archived_at_ms BIGINT,
    tombstoned_at_ms BIGINT, collected_at_ms BIGINT, last_refusal TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT factory_retention_records_pkey PRIMARY KEY (tenant_id, subject_kind, subject_id),
    CONSTRAINT factory_retention_records_kind_check CHECK (subject_kind IN (${quoted(FACTORY_RETENTION_SUBJECT_KINDS)})),
    CONSTRAINT factory_retention_records_class_check CHECK (retention_class IN (${quoted(FACTORY_RETENTION_CLASSES)})),
    CONSTRAINT factory_retention_records_state_check CHECK (state IN ('retained','tombstoned','collected')),
    CONSTRAINT factory_retention_records_anchor_check CHECK (anchored_at_ms >= 0),
    CONSTRAINT factory_retention_records_period_check CHECK (retain_until_ms - anchored_at_ms >= ${periodCase}),
    CONSTRAINT factory_retention_records_tombstone_check CHECK (state = 'retained' OR tombstoned_at_ms IS NOT NULL),
    CONSTRAINT factory_retention_records_collected_check CHECK ((state = 'collected') = (collected_at_ms IS NOT NULL)),
    CONSTRAINT factory_retention_records_archive_check CHECK ((archive_json IS NULL) = (archive_digest IS NULL) AND (archive_json IS NULL) = (archived_at_ms IS NULL)),
    CONSTRAINT factory_retention_records_archive_digest_check CHECK (archive_digest IS NULL OR archive_digest ~ '^sha256:[0-9a-f]{64}$')
  )`));
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_retention_due ON factory_retention_records (tenant_id, state, retain_until_ms)`);

  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_checkpoint_gate (
    tenant_id TEXT NOT NULL, paused BOOLEAN NOT NULL DEFAULT FALSE, checkpoint_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT factory_checkpoint_gate_pkey PRIMARY KEY (tenant_id)
  )`);

  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_checkpoints (
    tenant_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL, state TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL, key_wrap_version INTEGER, started_at_ms BIGINT NOT NULL, duration_ms INTEGER NOT NULL,
    abort_code TEXT, product_lsn TEXT, manifest_digest TEXT, manifest_archive_json TEXT,
    previous_checkpoint_id TEXT, sealed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT factory_checkpoints_pkey PRIMARY KEY (tenant_id, checkpoint_id),
    CONSTRAINT factory_checkpoints_state_check CHECK (state IN ('sealed','aborted')),
    CONSTRAINT factory_checkpoints_epoch_check CHECK (execution_epoch > 0),
    CONSTRAINT factory_checkpoints_duration_check CHECK (duration_ms >= 0 AND started_at_ms >= 0),
    CONSTRAINT factory_checkpoints_sealed_check CHECK ((state = 'sealed') = (manifest_digest IS NOT NULL AND manifest_archive_json IS NOT NULL AND product_lsn IS NOT NULL AND sealed_at IS NOT NULL AND key_wrap_version IS NOT NULL)),
    CONSTRAINT factory_checkpoints_key_wrap_check CHECK (key_wrap_version IS NULL OR key_wrap_version > 0),
    CONSTRAINT factory_checkpoints_aborted_check CHECK ((state = 'aborted') = (abort_code IS NOT NULL)),
    CONSTRAINT factory_checkpoints_manifest_digest_check CHECK (manifest_digest IS NULL OR manifest_digest ~ '^sha256:[0-9a-f]{64}$')
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_checkpoints_sealed ON factory_checkpoints (tenant_id, state, sealed_at)`);

  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_checkpoint_policy (
    tenant_id TEXT NOT NULL, enforce_freshness BOOLEAN NOT NULL DEFAULT TRUE,
    max_age_seconds INTEGER NOT NULL DEFAULT 900,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT factory_checkpoint_policy_pkey PRIMARY KEY (tenant_id),
    CONSTRAINT factory_checkpoint_policy_installation_fk FOREIGN KEY (tenant_id) REFERENCES factory_installation(tenant_id) ON DELETE RESTRICT,
    CONSTRAINT factory_checkpoint_policy_age_check CHECK (max_age_seconds BETWEEN 1 AND 900)
  )`);

  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_restore_epochs (
    tenant_id TEXT NOT NULL, restore_id TEXT NOT NULL, mode TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL, manifest_digest TEXT NOT NULL,
    previous_epoch INTEGER NOT NULL, execution_epoch INTEGER NOT NULL, state TEXT NOT NULL,
    report_json TEXT, report_digest TEXT, signed_by TEXT, signed_at_ms BIGINT, enabled_at_ms BIGINT,
    started_at_ms BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT factory_restore_epochs_pkey PRIMARY KEY (tenant_id, restore_id),
    CONSTRAINT factory_restore_epochs_epoch_key UNIQUE (tenant_id, execution_epoch),
    CONSTRAINT factory_restore_epochs_mode_check CHECK (mode IN ('tenant','cluster')),
    CONSTRAINT factory_restore_epochs_state_check CHECK (state IN ('fenced','awaiting_signature','enabled')),
    CONSTRAINT factory_restore_epochs_epoch_check CHECK (previous_epoch > 0 AND execution_epoch = previous_epoch + 1),
    CONSTRAINT factory_restore_epochs_manifest_digest_check CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT factory_restore_epochs_report_check CHECK ((report_json IS NULL) = (report_digest IS NULL) AND (state = 'fenced' OR report_digest IS NOT NULL)),
    CONSTRAINT factory_restore_epochs_report_digest_check CHECK (report_digest IS NULL OR report_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT factory_restore_epochs_signed_check CHECK ((state = 'enabled') = (signed_by IS NOT NULL AND signed_at_ms IS NOT NULL AND enabled_at_ms IS NOT NULL))
  )`);

  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_restore_findings (
    tenant_id TEXT NOT NULL, restore_id TEXT NOT NULL, finding_id TEXT NOT NULL,
    subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, disposition TEXT NOT NULL,
    reason TEXT NOT NULL, detail_json TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT factory_restore_findings_pkey PRIMARY KEY (tenant_id, restore_id, finding_id),
    CONSTRAINT factory_restore_findings_restore_fk FOREIGN KEY (tenant_id, restore_id) REFERENCES factory_restore_epochs(tenant_id, restore_id) ON DELETE RESTRICT,
    CONSTRAINT factory_restore_findings_kind_check CHECK (subject_kind IN ('check','run','release','worker','pool','projection')),
    CONSTRAINT factory_restore_findings_disposition_check CHECK (disposition IN ('verified','reconciled','blocked'))
  )`);

  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_recovered_releases (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, operation_id TEXT NOT NULL, restore_id TEXT NOT NULL,
    run_id TEXT NOT NULL, dispatch_generation BIGINT NOT NULL,
    intent_json TEXT NOT NULL, intent_digest TEXT NOT NULL,
    receipt_json TEXT, receipt_digest TEXT, provider_verified BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT factory_recovered_releases_pkey PRIMARY KEY (tenant_id, project_id, operation_id),
    CONSTRAINT factory_recovered_releases_restore_fk FOREIGN KEY (tenant_id, restore_id) REFERENCES factory_restore_epochs(tenant_id, restore_id) ON DELETE RESTRICT,
    CONSTRAINT factory_recovered_releases_generation_check CHECK (dispatch_generation >= 0),
    CONSTRAINT factory_recovered_releases_intent_digest_check CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT factory_recovered_releases_receipt_check CHECK ((receipt_json IS NULL) = (receipt_digest IS NULL) AND (provider_verified = FALSE OR receipt_json IS NOT NULL)),
    CONSTRAINT factory_recovered_releases_receipt_digest_check CHECK (receipt_digest IS NULL OR receipt_digest ~ '^sha256:[0-9a-f]{64}$')
  )`);

  await installGates(database);
}

/**
 * The three gate functions, then the barrier trigger on every factory table.
 * Repeat-safe: `CREATE OR REPLACE` for functions and a catalog check before
 * each trigger. It runs on every boot, so a table a later migration adds is
 * guarded from the next boot on; `factoryBarrierGateCoverage` reports any
 * table that is not.
 */
async function installGates(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE OR REPLACE FUNCTION factory_checkpoint_barrier_gate() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF current_setting('ezcorp.factory_barrier_member', true) IS DISTINCT FROM 'on' THEN
      IF EXISTS (SELECT 1 FROM factory_checkpoint_gate WHERE paused) THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('factory-checkpoint-pause-v1', 0));
      END IF;
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('factory-checkpoint-barrier-v1', 0));
      PERFORM set_config('ezcorp.factory_barrier_member', 'on', true);
    END IF;
    RETURN NULL;
  END $$`);

  await database.execute(sql`CREATE OR REPLACE FUNCTION factory_effect_claims_closed_reason(p_tenant TEXT) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
  DECLARE
    v_enforce BOOLEAN;
    v_max_age INTEGER;
    v_newest TIMESTAMPTZ;
  BEGIN
    IF EXISTS (SELECT 1 FROM factory_restore_epochs WHERE tenant_id = p_tenant AND state <> 'enabled') THEN RETURN 'restore_epoch_open'; END IF;
    SELECT enforce_freshness, max_age_seconds INTO v_enforce, v_max_age FROM factory_checkpoint_policy WHERE tenant_id = p_tenant;
    IF v_enforce IS TRUE THEN
      SELECT max(sealed_at) INTO v_newest FROM factory_checkpoints WHERE tenant_id = p_tenant AND state = 'sealed';
      IF v_newest IS NULL OR clock_timestamp() - v_newest > make_interval(secs => v_max_age) THEN RETURN 'checkpoint_stale'; END IF;
    END IF;
    RETURN NULL;
  END $$`);

  await database.execute(sql`CREATE OR REPLACE FUNCTION factory_effect_claim_gate() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE v_reason TEXT;
  BEGIN
    IF (TG_TABLE_NAME = 'factory_release_operations' AND NEW.state = 'executing' AND OLD.state IS DISTINCT FROM 'executing')
      OR (TG_TABLE_NAME = 'factory_attempt_launches' AND NEW.state = 'launching' AND OLD.state IS DISTINCT FROM 'launching') THEN
      v_reason := factory_effect_claims_closed_reason(NEW.tenant_id);
      IF v_reason IS NOT NULL THEN
        RAISE EXCEPTION 'factory_effect_claims_closed:%', v_reason USING ERRCODE = 'F0C01';
      END IF;
    END IF;
    RETURN NEW;
  END $$`);

  await database.execute(sql`CREATE OR REPLACE FUNCTION factory_restore_admission_gate() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM factory_restore_epochs WHERE tenant_id = NEW.tenant_id AND state <> 'enabled') THEN
      RAISE EXCEPTION 'factory_admission_closed:restore_epoch_open' USING ERRCODE = 'F0C02';
    END IF;
    RETURN NEW;
  END $$`);

  await database.execute(sql.raw(`DO $$
  DECLARE target RECORD;
  BEGIN
    FOR target IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r','p') AND c.relname LIKE 'factory\\_%'
        AND c.relname NOT IN (${quoted(FACTORY_RECOVERY_UNGATED_TABLES)})
        AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'factory_checkpoint_barrier_gate')
    LOOP
      EXECUTE format('CREATE TRIGGER factory_checkpoint_barrier_gate BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION factory_checkpoint_barrier_gate()', target.relname);
    END LOOP;
    IF to_regclass('factory_release_operations') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'factory_release_operations'::regclass AND tgname = 'factory_effect_claim_gate') THEN
      CREATE TRIGGER factory_effect_claim_gate BEFORE UPDATE ON factory_release_operations FOR EACH ROW EXECUTE FUNCTION factory_effect_claim_gate();
    END IF;
    IF to_regclass('factory_attempt_launches') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'factory_attempt_launches'::regclass AND tgname = 'factory_effect_claim_gate') THEN
      CREATE TRIGGER factory_effect_claim_gate BEFORE UPDATE ON factory_attempt_launches FOR EACH ROW EXECUTE FUNCTION factory_effect_claim_gate();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'factory_runs'::regclass AND tgname = 'factory_restore_admission_gate') THEN
      CREATE TRIGGER factory_restore_admission_gate BEFORE INSERT ON factory_runs FOR EACH ROW EXECUTE FUNCTION factory_restore_admission_gate();
    END IF;
  END $$`));
}
