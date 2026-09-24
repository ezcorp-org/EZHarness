import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * The package fence's affected-run record (C05, W02c).
 *
 * A quarantine or revocation stops every live attempt of the package in the
 * same transaction that records the decision. This table is what that
 * transaction leaves behind for the operator: one sealed row per attempt the
 * decision reached, naming its run, the trust revision that blocked it, what the
 * attempt was doing at that instant, and what the fence did about it. The
 * affected-run list the console shows reads these rows; it never recomputes the
 * set from live state after the fact, because by then the stopped attempts are
 * no longer live.
 *
 * Every statement is self-idempotent because this repository has no migration
 * ledger and `migrate()` replays in full on every boot.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`CREATE TABLE IF NOT EXISTS factory_package_fence_runs (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    package_name TEXT NOT NULL,
    package_version TEXT NOT NULL,
    package_digest TEXT NOT NULL,
    export_name TEXT NOT NULL,
    reference_digest TEXT NOT NULL,
    trust_revision BIGINT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('quarantined','revoked')),
    reason TEXT NOT NULL CHECK (reason IN ('factory_package_quarantined','factory_package_revoked')),
    run_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    attempt_status TEXT NOT NULL CHECK (attempt_status IN ('admitted','running')),
    launch_state TEXT CHECK (launch_state IS NULL OR launch_state IN ('prepared','launching','launched','terminal','uncertain')),
    disposition TEXT NOT NULL CHECK (disposition IN ('cancel-requested','already-cancelling','run-terminal')),
    cancellation_event_id TEXT,
    recorded_at_ms BIGINT NOT NULL CHECK (recorded_at_ms >= 0),
    record_digest TEXT NOT NULL CHECK (record_digest ~ '^sha256:[0-9a-f]{64}$'),
    PRIMARY KEY (tenant_id, project_id, package_name, package_version, package_digest, export_name, reference_digest, trust_revision, attempt_id),
    FOREIGN KEY (tenant_id, project_id, package_name, package_version, package_digest, export_name, reference_digest, trust_revision)
      REFERENCES factory_runner_package_trust_revisions(tenant_id, project_id, package_name, package_version, package_digest, export_name, reference_digest, revision) ON DELETE RESTRICT,
    FOREIGN KEY (attempt_id, tenant_id, project_id, run_id)
      REFERENCES factory_executions(attempt_id, tenant_id, project_id, run_id) ON DELETE RESTRICT,
    CHECK ((state = 'quarantined') = (reason = 'factory_package_quarantined')),
    CHECK ((disposition = 'run-terminal') = (cancellation_event_id IS NULL))
  )`);
  await database.execute(sql`CREATE INDEX IF NOT EXISTS idx_factory_package_fence_runs_run ON factory_package_fence_runs (tenant_id, project_id, run_id)`);
}
