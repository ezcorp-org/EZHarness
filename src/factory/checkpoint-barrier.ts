import { randomUUID } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { FACTORY_RECOVERY_UNGATED_TABLES } from "../db/migrations/add-factory-recovery";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestBytes } from "../extensions/v4/blobs";
import { assertFactoryIdentity } from "./records";
import { parseFactoryArchiveReference, readFactoryRecoveryJson, writeFactoryRecoveryJson, type FactoryRecoveryArchive } from "./recovery-archive";
import type { FactoryArchiveObject } from "./releases";

/**
 * C06's per-tenant compatible checkpoint barrier (W15).
 *
 * One barrier, in the contract's order:
 *
 *   1. pause claims — a self-expiring flag closes new release claims and
 *      attempt launches (the migration's effect-claim gate);
 *   2. drain — while ordinary writes still flow, in-flight effect senders
 *      (leased outbox rows, executing releases, launching attempts) get a
 *      bounded window to settle; the rest are fenced by name in the manifest,
 *      so restore reconciles each one;
 *   3. pause mutations — a session takes the pause lock, then the pause flag
 *      commits, so every transaction that has not written yet waits at its
 *      first factory write (the migration's statement gate);
 *   4. reconcile — every transaction already writing finishes, which is the
 *      moment the barrier's exclusive lock is granted; the audit streams are
 *      checked for gaps before anything is recorded;
 *   5. quiesce — while the exclusive lock is held no factory write commits,
 *      so the Temporal namespace can deliver timers but cannot move a product
 *      fact across the barrier;
 *   6. record — the WAL position, the product-state digests, every object
 *      version, the fenced senders, the pool ledger rows, and the Temporal
 *      positions;
 *   7. seal — the object inventory, the manifest, and a seal record are
 *      written to the independent archive, each read back byte for byte;
 *   8. resume — the sealed row commits with the lock's release, then the
 *      pause flag and the claim pause clear and the pause lock is released.
 *
 * Writes are paused only for steps 3 through 8. The outcome reports that
 * window (`writePauseMs`) beside the whole barrier (`durationMs`).
 *
 * The barrier never waits in the lock manager: it polls for its exclusive
 * lock, and a writer that already holds the shared lock never waits on the
 * pause lock, so no lock cycle can include the barrier. Past the maximum the
 * barrier rolls back, records an aborted attempt, and claims nothing. The seal
 * record is written only inside the maximum, and only a sealed checkpoint
 * reopens effect claims.
 */

export const FACTORY_CHECKPOINT_LIMITS = Object.freeze({
  targetMs: 2_000,
  maximumMs: 10_000,
  maxConcurrentBarriers: 16,
  maxAgeMs: 15 * 60_000,
  /** The longest the drain step waits for in-flight senders before fencing them. */
  drainMs: 1_000,
  pollMs: 5,
  /** A seal write starts only with this much of the maximum left, so a claimed seal is never written after it. */
  sealMarginMs: 500,
});

export const FACTORY_CHECKPOINT_MANIFEST_SCHEMA = "factory.checkpoint-manifest.v1";
export const FACTORY_CHECKPOINT_SEAL_SCHEMA = "factory.checkpoint-seal.v1";
export const FACTORY_CHECKPOINT_OBJECTS_SCHEMA = "factory.checkpoint-objects.v1";
/** The archive record every seal of a tenant lives under. */
export const FACTORY_CHECKPOINT_SEALS_RECORD = "seals";
const BARRIER_LOCK = sql`hashtextextended('factory-checkpoint-barrier-v1', 0)`;
const PAUSE_LOCK = sql`hashtextextended('factory-checkpoint-pause-v1', 0)`;
const TERMINAL = sql.raw(["'succeeded'", "'failed'", "'cancelled'"].join(","));

export type FactoryCheckpointAbortCode =
  | "barrier_timeout"
  | "barrier_gate_incomplete"
  | "audit_inconsistent"
  | "pool_unavailable"
  | "temporal_unavailable"
  | "archive_failed"
  | "cancelled";

export class FactoryCheckpointError extends Error {
  constructor(readonly code: "factory_checkpoint_invalid" | "factory_checkpoint_manifest_invalid" | "factory_checkpoint_not_found", options?: { cause?: unknown }) {
    super(code, options);
    this.name = "FactoryCheckpointError";
  }
}

class BarrierAbort extends Error {
  constructor(readonly code: FactoryCheckpointAbortCode, options?: { cause?: unknown }) { super(code, options); }
}

export interface FactoryCheckpointPoolSnapshot {
  /** The pool database's own position for the snapshot. */
  readonly position: string;
  readonly rows: readonly Record<string, unknown>[];
}

/** The tenant's rows of the shared pool ledger, read in one pool transaction. */
export interface FactoryCheckpointPoolSource {
  snapshotTenant(tenantId: string, signal?: AbortSignal): Promise<FactoryCheckpointPoolSnapshot>;
}

export interface FactoryTemporalWorkflowPosition {
  readonly workflowId: string;
  readonly runId: string | null;
  readonly status: string;
  /** Known once the run has closed; Temporal's visibility store does not report it for a running one. */
  readonly historyLength: number | null;
}

/** Temporal's position for each live workflow. Used only for a cluster-wide disaster restore. */
export interface FactoryCheckpointTemporalSource {
  readonly namespace: string;
  positions(workflowIds: readonly string[], signal?: AbortSignal): Promise<readonly FactoryTemporalWorkflowPosition[]>;
}

export interface FactoryProductRunPosition {
  readonly projectId: string;
  readonly runId: string;
  readonly status: string;
  readonly executionEpoch: number;
  readonly interpreters: readonly { readonly interpreterId: string; readonly sourceSequence: number; readonly digest: string }[];
}

/** The product state a barrier records and a restore recomputes; the digests are the comparison. */
export interface FactoryProductState {
  readonly runsDigest: string;
  readonly runCount: number;
  readonly releasesDigest: string;
  readonly attemptsDigest: string;
  /** Signed physical-stop facts: which attempts a host proved stopped, by receipt digest. */
  readonly stopsDigest: string;
  /** Budget holds, the product half of every allocation. */
  readonly holdsDigest: string;
  readonly objectsDigest: string;
  readonly objectCount: number;
  readonly stateDigest: string;
}

export interface FactoryFencedSenders {
  readonly outbox: readonly { readonly projectId: string; readonly id: string; readonly leaseUntil: number }[];
  readonly releases: readonly { readonly projectId: string; readonly operationId: string; readonly runId: string; readonly dispatchGeneration: number; readonly dispatchStarted: boolean }[];
  readonly attempts: readonly { readonly attemptId: string; readonly projectId: string; readonly runId: string; readonly state: string; readonly hostId: string; readonly workerId: string; readonly reservationId: string; readonly holderGeneration: number }[];
}

export interface FactoryCheckpointManifest {
  readonly schemaVersion: typeof FACTORY_CHECKPOINT_MANIFEST_SCHEMA;
  readonly tenantId: string;
  readonly installationId: string;
  readonly checkpointId: string;
  readonly previousCheckpointId: string | null;
  readonly executionEpoch: number;
  readonly startedAtMs: number;
  readonly product: {
    readonly lsn: string;
    readonly schemaDigest: string;
    readonly state: FactoryProductState;
    readonly liveRuns: readonly FactoryProductRunPosition[];
    readonly objects: FactoryArchiveObject;
  };
  readonly fenced: FactoryFencedSenders;
  readonly pool: { readonly captured: true; readonly position: string; readonly digest: string; readonly rows: readonly Record<string, unknown>[] } | { readonly captured: false; readonly reason: string };
  readonly temporal: { readonly captured: true; readonly namespace: string; readonly workflows: readonly FactoryTemporalWorkflowPosition[] } | { readonly captured: false; readonly reason: string };
  /**
   * The key version a restore needs. The product process never holds the data
   * key (C06 gives it only to the orchestration process). When the product
   * database keeps the wrap ledger, the manifest names the newest wrap and pins
   * its bytes by digest; when the wrap lives only in the orchestration
   * process's private file, the three wrap fields are null and the restore,
   * which holds the operator's keys, proves the data key opens from there.
   */
  readonly keys: { readonly installationId: string; readonly wrapVersion: number | null; readonly masterKeyId: string | null; readonly wrappedDigest: string | null };
}

export interface FactoryCheckpointSeal {
  readonly schemaVersion: typeof FACTORY_CHECKPOINT_SEAL_SCHEMA;
  readonly tenantId: string;
  readonly checkpointId: string;
  readonly manifest: FactoryArchiveObject;
  readonly manifestDigest: string;
  readonly sealedAtMs: number;
  readonly durationMs: number;
}

export type FactoryCheckpointOutcome =
  | { readonly kind: "sealed"; readonly checkpointId: string; readonly durationMs: number; readonly writePauseMs: number; readonly lsn: string; readonly manifest: FactoryArchiveObject; readonly seal: FactoryArchiveObject; readonly fenced: number; readonly withinTarget: boolean }
  | { readonly kind: "aborted"; readonly checkpointId: string; readonly durationMs: number; readonly code: FactoryCheckpointAbortCode }
  | { readonly kind: "skipped"; readonly reason: "restore_epoch_open" };

export interface FactoryCheckpointOptions {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  readonly installationId: string;
  readonly archive: FactoryRecoveryArchive;
  readonly pool?: FactoryCheckpointPoolSource;
  readonly temporal?: FactoryCheckpointTemporalSource;
  /** Only ever lowers the contract maximum, so a test can drive the abort path; never raises it. */
  readonly maximumMs?: number;
  readonly now?: () => number;
  readonly monotonic?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

function sha256Hex(value: string): string { return `sha256:${digestBytes(new TextEncoder().encode(value))}`; }

/** Every `factory_*` table that lacks the barrier's statement gate. Empty means every writer is fenced. */
export async function factoryBarrierGateCoverage(database: MigrationDb): Promise<readonly string[]> {
  const ungated = new Set<string>(FACTORY_RECOVERY_UNGATED_TABLES);
  return rows<{ relname: string }>(await database.execute(sql`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r','p') AND c.relname LIKE 'factory\\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'factory_checkpoint_barrier_gate') ORDER BY 1`))
    .map(row => row.relname).filter(name => !ungated.has(name));
}

/** A digest of every factory table's columns, so a restore can refuse a backup from a different schema. */
export async function factorySchemaDigest(database: MigrationDb): Promise<string> {
  const row = rows<{ shape: string | null }>(await database.execute(sql`SELECT string_agg(table_name || '.' || column_name || ':' || data_type, ',' ORDER BY table_name, column_name) AS shape
    FROM information_schema.columns WHERE table_schema = current_schema() AND table_name LIKE 'factory\\_%'`))[0];
  return sha256Hex(row?.shape ?? "");
}

/**
 * The product-state digests a barrier records and a restore recomputes. Each
 * is one ordered aggregate, so the comparison needs no row-by-row walk.
 */
export async function captureFactoryProductState(database: MigrationDb, tenantId: string): Promise<{ readonly state: FactoryProductState; readonly objects: readonly { readonly projectId: string; readonly objectId: string; readonly blobDigest: string; readonly storageVersion: string; readonly digest: string }[] }> {
  const aggregate = async (query: ReturnType<typeof sql>) => rows<{ body: string | null; count: string | number }>(await database.execute(query))[0]!;
  const runs = await aggregate(sql`SELECT string_agg(concat_ws('|', r.project_id, r.run_id, r.execution_epoch, r.next_sequence, COALESCE(h.sequence, 0), COALESCE(h.digest, ''), COALESCE(l.status, ''), COALESCE(l.revision, 0)), E'\\n' ORDER BY r.project_id, r.run_id) AS body, count(*) AS count
    FROM factory_runs r
    LEFT JOIN LATERAL (SELECT b.sequence, b.digest FROM factory_audit_batches b WHERE b.tenant_id = r.tenant_id AND b.project_id = r.project_id AND b.run_id = r.run_id ORDER BY b.sequence DESC LIMIT 1) h ON TRUE
    LEFT JOIN factory_run_lifecycle l ON l.tenant_id = r.tenant_id AND l.project_id = r.project_id AND l.run_id = r.run_id
    WHERE r.tenant_id = ${tenantId}`);
  const releases = await aggregate(sql`SELECT string_agg(concat_ws('|', project_id, operation_id, state, dispatch_generation, COALESCE(receipt_archive_json, '')), E'\\n' ORDER BY project_id, operation_id) AS body, count(*) AS count FROM factory_release_operations WHERE tenant_id = ${tenantId}`);
  const attempts = await aggregate(sql`SELECT string_agg(concat_ws('|', attempt_id, state, COALESCE(terminal_result_digest, '')), E'\\n' ORDER BY attempt_id) AS body, count(*) AS count FROM factory_attempt_launches WHERE tenant_id = ${tenantId}`);
  const stops = await aggregate(sql`SELECT string_agg(concat_ws('|', attempt_id, state, COALESCE(stop_receipt_digest, '')), E'\\n' ORDER BY attempt_id) AS body, count(*) AS count FROM factory_task_stops WHERE tenant_id = ${tenantId}`);
  const holds = await aggregate(sql`SELECT string_agg(concat_ws('|', project_id, run_id, reservation_id, state, amount, COALESCE(actual, ''), COALESCE(receipt_digest, '')), E'\\n' ORDER BY project_id, run_id, reservation_id) AS body, count(*) AS count FROM factory_budget_reservations WHERE tenant_id = ${tenantId}`);
  // Rebuilt as plain objects: a driver's result array carries extra properties canonical JSON refuses.
  const objects = rows<{ projectId: string; objectId: string; blobDigest: string; storageVersion: string; digest: string }>(await database.execute(sql`SELECT project_id AS "projectId", object_id AS "objectId", blob_digest AS "blobDigest", storage_version AS "storageVersion", digest FROM factory_artifacts WHERE tenant_id = ${tenantId}
    UNION ALL SELECT project_id, concat_ws('/', run_id, attempt_id, operation_id, object_name, version, chunk_index), blob_digest, storage_version, chunk_digest FROM factory_artifact_material_chunks WHERE tenant_id = ${tenantId}
    ORDER BY 1, 2`)).map(row => ({ projectId: row.projectId, objectId: row.objectId, blobDigest: row.blobDigest, storageVersion: row.storageVersion, digest: row.digest }));
  const partial = {
    runsDigest: sha256Hex(runs.body ?? ""), runCount: Number(runs.count),
    releasesDigest: sha256Hex(releases.body ?? ""), attemptsDigest: sha256Hex(attempts.body ?? ""),
    stopsDigest: sha256Hex(stops.body ?? ""), holdsDigest: sha256Hex(holds.body ?? ""),
    objectsDigest: sha256Hex(canonicalJson(objects)), objectCount: objects.length,
  };
  return { state: Object.freeze({ ...partial, stateDigest: sha256Hex(canonicalJson(partial)) }), objects };
}

async function liveRuns(database: MigrationDb, tenantId: string): Promise<readonly FactoryProductRunPosition[]> {
  const found = rows<{ project_id: string; run_id: string; status: string | null; execution_epoch: number | string; interpreter_id: string | null; source_sequence: string | number | null; digest: string | null }>(await database.execute(sql`SELECT r.project_id, r.run_id, l.status, r.execution_epoch, h.interpreter_id, h.source_sequence, h.digest
    FROM factory_runs r LEFT JOIN factory_run_lifecycle l ON l.tenant_id = r.tenant_id AND l.project_id = r.project_id AND l.run_id = r.run_id
    LEFT JOIN LATERAL (SELECT DISTINCT ON (b.interpreter_id) b.interpreter_id, b.source_sequence, b.digest FROM factory_audit_batches b
      WHERE b.tenant_id = r.tenant_id AND b.project_id = r.project_id AND b.run_id = r.run_id ORDER BY b.interpreter_id, b.source_sequence DESC) h ON TRUE
    WHERE r.tenant_id = ${tenantId} AND (l.status IS NULL OR l.status NOT IN (${TERMINAL})) ORDER BY r.project_id, r.run_id, h.interpreter_id`));
  const runs = new Map<string, { projectId: string; runId: string; status: string; executionEpoch: number; interpreters: { interpreterId: string; sourceSequence: number; digest: string }[] }>();
  for (const row of found) {
    const key = `${row.project_id}\0${row.run_id}`;
    const run = runs.get(key) ?? { projectId: row.project_id, runId: row.run_id, status: row.status ?? "unknown", executionEpoch: Number(row.execution_epoch), interpreters: [] };
    if (row.interpreter_id !== null) run.interpreters.push({ interpreterId: row.interpreter_id, sourceSequence: Number(row.source_sequence), digest: row.digest! });
    runs.set(key, run);
  }
  return [...runs.values()];
}

async function fencedSenders(database: MigrationDb, tenantId: string, nowMs: number): Promise<FactoryFencedSenders> {
  const outbox = rows<{ project_id: string; id: string; lease_until: string | number }>(await database.execute(sql`SELECT project_id, id, lease_until FROM factory_command_outbox WHERE tenant_id = ${tenantId} AND state = 'leased' AND lease_until > ${nowMs} ORDER BY project_id, id`));
  const releases = rows<{ project_id: string; operation_id: string; run_id: string; dispatch_generation: string | number; dispatch_started: boolean }>(await database.execute(sql`SELECT project_id, operation_id, run_id, dispatch_generation, dispatch_started FROM factory_release_operations WHERE tenant_id = ${tenantId} AND state IN ('executing','uncertain') ORDER BY project_id, operation_id`));
  const attempts = rows<{ attempt_id: string; project_id: string; run_id: string; state: string; host_id: string; worker_id: string; reservation_id: string; holder_generation: string | number }>(await database.execute(sql`SELECT attempt_id, project_id, run_id, state, host_id, worker_id, reservation_id, holder_generation FROM factory_attempt_launches WHERE tenant_id = ${tenantId} AND state IN ('launching','launched','uncertain') ORDER BY attempt_id`));
  return {
    outbox: outbox.map(row => ({ projectId: row.project_id, id: row.id, leaseUntil: Number(row.lease_until) })),
    releases: releases.map(row => ({ projectId: row.project_id, operationId: row.operation_id, runId: row.run_id, dispatchGeneration: Number(row.dispatch_generation), dispatchStarted: row.dispatch_started })),
    attempts: attempts.map(row => ({ attemptId: row.attempt_id, projectId: row.project_id, runId: row.run_id, state: row.state, hostId: row.host_id, workerId: row.worker_id, reservationId: row.reservation_id, holderGeneration: Number(row.holder_generation) })),
  };
}

function fencedCount(fenced: FactoryFencedSenders): number { return fenced.outbox.length + fenced.releases.length + fenced.attempts.length; }

/** The installation's newest wrap. Rotation adds a wrap and never rewrites the data key, so the manifest names the one a restore needs first. */
export async function factoryKeyWrapDigest(database: MigrationDb, installationId: string, wrapVersion?: number): Promise<{ readonly installationId: string; readonly wrapVersion: number; readonly masterKeyId: string; readonly wrappedDigest: string } | null> {
  const row = rows<{ wrap_version: number | string; master_key_id: string; wrapped: string }>(await database.execute(sql`SELECT wrap_version, master_key_id, encode(wrapped_data_key, 'hex') AS wrapped FROM factory_installation_key_wraps
    WHERE installation_id = ${installationId} ${wrapVersion === undefined ? sql`` : sql`AND wrap_version = ${wrapVersion}`} ORDER BY wrap_version DESC LIMIT 1`))[0];
  return row ? { installationId, wrapVersion: Number(row.wrap_version), masterKeyId: row.master_key_id, wrappedDigest: `sha256:${digestBytes(Buffer.from(row.wrapped, "hex"))}` } : null;
}

export class FactoryCheckpointCoordinator {
  private readonly database: TransactionalDb;
  readonly tenantId: string;
  private readonly maximumMs: number;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: FactoryCheckpointOptions) {
    assertFactoryIdentity(options.tenantId, options.installationId);
    const maximumMs = options.maximumMs ?? FACTORY_CHECKPOINT_LIMITS.maximumMs;
    if (!Number.isSafeInteger(maximumMs) || maximumMs < 1 || maximumMs > FACTORY_CHECKPOINT_LIMITS.maximumMs) throw new FactoryCheckpointError("factory_checkpoint_invalid");
    this.database = options.database;
    this.tenantId = options.tenantId;
    this.maximumMs = maximumMs;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.wait = options.wait ?? (milliseconds => new Promise(settle => setTimeout(settle, milliseconds)));
  }

  /**
   * Turns on C06's freshness rule for this tenant: once enforced, a release
   * claim or an attempt launch is refused while the newest sealed checkpoint
   * is older than the bound. The bound can be lowered, never raised past
   * fifteen minutes.
   */
  async enforceFreshness(maxAgeSeconds = FACTORY_CHECKPOINT_LIMITS.maxAgeMs / 1_000): Promise<void> {
    if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds * 1_000 > FACTORY_CHECKPOINT_LIMITS.maxAgeMs) throw new FactoryCheckpointError("factory_checkpoint_invalid");
    await this.database.execute(sql`INSERT INTO factory_checkpoint_policy (tenant_id, enforce_freshness, max_age_seconds) VALUES (${this.tenantId}, TRUE, ${maxAgeSeconds})
      ON CONFLICT (tenant_id) DO UPDATE SET enforce_freshness = TRUE, max_age_seconds = EXCLUDED.max_age_seconds, updated_at = NOW()`);
  }

  /** The reason effect claims are closed right now, or null. The database gate uses the same function. */
  async effectClaimsClosedReason(): Promise<string | null> {
    return rows<{ reason: string | null }>(await this.database.execute(sql`SELECT factory_effect_claims_closed_reason(${this.tenantId}) AS reason`))[0]!.reason;
  }

  /** The newest sealed checkpoint's id and age in milliseconds, by the database clock. */
  async newest(): Promise<{ readonly checkpointId: string; readonly ageMs: number; readonly manifest: FactoryArchiveObject } | null> {
    const row = rows<{ checkpoint_id: string; age_ms: string | number; manifest_archive_json: string }>(await this.database.execute(sql`SELECT checkpoint_id, floor(extract(epoch FROM clock_timestamp() - sealed_at) * 1000) AS age_ms, manifest_archive_json FROM factory_checkpoints
      WHERE tenant_id = ${this.tenantId} AND state = 'sealed' ORDER BY sealed_at DESC LIMIT 1`))[0];
    return row ? { checkpointId: row.checkpoint_id, ageMs: Number(row.age_ms), manifest: parseFactoryArchiveReference(row.manifest_archive_json) } : null;
  }

  /** Barrier windows since a moment: C11 excludes them from steady-state percentiles and counts them toward availability. */
  async windows(sinceMs: number): Promise<{ readonly sealed: number; readonly aborted: number; readonly totalMs: number; readonly maxMs: number }> {
    const row = rows<{ sealed: string | number; aborted: string | number; total: string | number | null; maximum: string | number | null }>(await this.database.execute(sql`SELECT count(*) FILTER (WHERE state = 'sealed') AS sealed, count(*) FILTER (WHERE state = 'aborted') AS aborted, sum(duration_ms) AS total, max(duration_ms) AS maximum
      FROM factory_checkpoints WHERE tenant_id = ${this.tenantId} AND started_at_ms >= ${sinceMs}`))[0]!;
    return { sealed: Number(row.sealed), aborted: Number(row.aborted), totalMs: Number(row.total ?? 0), maxMs: Number(row.maximum ?? 0) };
  }

  /** Runs one barrier. Every exit either seals a checkpoint or records an aborted attempt that claims nothing. */
  async run(signal?: AbortSignal): Promise<FactoryCheckpointOutcome> {
    if (rows(await this.database.execute(sql`SELECT 1 FROM factory_restore_epochs WHERE tenant_id = ${this.tenantId} AND state <> 'enabled' LIMIT 1`)).length) return { kind: "skipped", reason: "restore_epoch_open" };
    const checkpointId = randomUUID();
    const startedAtMs = this.now();
    const started = this.monotonic();
    const deadline = started + this.maximumMs;
    const elapsed = () => Math.max(0, Math.round(this.monotonic() - started));
    try {
      if ((await factoryBarrierGateCoverage(this.database)).length > 0) throw new BarrierAbort("barrier_gate_incomplete");
      const epoch = Number(rows<{ execution_epoch: number | string }>(await this.database.execute(sql`SELECT execution_epoch FROM factory_installation WHERE tenant_id = ${this.tenantId}`))[0]?.execution_epoch ?? 0);
      if (epoch < 1) throw new FactoryCheckpointError("factory_checkpoint_invalid");
      let pausedAt = 0;
      const sealed = await this.pauseClaims(checkpointId, async () => {
        await this.drain(started, deadline, signal);
        return this.database.transaction(async hold => {
          while (!rows<{ locked: boolean }>(await hold.execute(sql`SELECT pg_try_advisory_xact_lock(${PAUSE_LOCK}) AS locked`))[0]!.locked) {
            this.remaining(deadline, signal);
            await this.wait(FACTORY_CHECKPOINT_LIMITS.pollMs);
          }
          await this.setPaused(true, checkpointId);
          pausedAt = this.monotonic();
          try { return await this.barrier(checkpointId, epoch, startedAtMs, started, deadline, signal); }
          finally { await this.setPaused(false, checkpointId); }
        });
      });
      const durationMs = elapsed();
      return { kind: "sealed", checkpointId, ...sealed, durationMs, writePauseMs: Math.round(this.monotonic() - pausedAt), withinTarget: durationMs <= FACTORY_CHECKPOINT_LIMITS.targetMs };
    } catch (error) {
      if (!(error instanceof BarrierAbort)) throw error;
      const durationMs = elapsed();
      await this.database.execute(sql`INSERT INTO factory_checkpoints (tenant_id, checkpoint_id, state, execution_epoch, started_at_ms, duration_ms, abort_code)
        SELECT ${this.tenantId}, ${checkpointId}, 'aborted', execution_epoch, ${startedAtMs}, ${durationMs}, ${error.code} FROM factory_installation WHERE tenant_id = ${this.tenantId}`);
      return { kind: "aborted", checkpointId, durationMs, code: error.code };
    }
  }

  /** Closes effect claims for at most the barrier's maximum, then reopens them whatever happened. */
  private async pauseClaims<Value>(checkpointId: string, work: () => Promise<Value>): Promise<Value> {
    await this.database.execute(sql`INSERT INTO factory_checkpoint_gate (tenant_id, paused, checkpoint_id, claims_paused_until) VALUES (${this.tenantId}, FALSE, ${checkpointId}, clock_timestamp() + make_interval(secs => ${this.maximumMs / 1_000}))
      ON CONFLICT (tenant_id) DO UPDATE SET checkpoint_id = EXCLUDED.checkpoint_id, claims_paused_until = EXCLUDED.claims_paused_until, updated_at = NOW()`);
    try { return await work(); }
    finally { await this.database.execute(sql`UPDATE factory_checkpoint_gate SET claims_paused_until = NULL, updated_at = NOW() WHERE tenant_id = ${this.tenantId} AND checkpoint_id = ${checkpointId}`); }
  }

  /** Waits, within the drain budget, for in-flight senders to settle while ordinary writes still flow. */
  private async drain(started: number, deadline: number, signal?: AbortSignal): Promise<void> {
    const drainUntil = Math.min(deadline, started + FACTORY_CHECKPOINT_LIMITS.drainMs);
    while (this.monotonic() < drainUntil && fencedCount(await fencedSenders(this.database, this.tenantId, this.now())) > 0) {
      this.remaining(deadline, signal);
      await this.wait(FACTORY_CHECKPOINT_LIMITS.pollMs);
    }
  }

  private async setPaused(paused: boolean, checkpointId: string): Promise<void> {
    await this.database.execute(sql`INSERT INTO factory_checkpoint_gate (tenant_id, paused, checkpoint_id) VALUES (${this.tenantId}, ${paused}, ${checkpointId})
      ON CONFLICT (tenant_id) DO UPDATE SET paused = EXCLUDED.paused, checkpoint_id = EXCLUDED.checkpoint_id, updated_at = NOW()`);
  }

  private remaining(deadline: number, signal?: AbortSignal): number {
    if (signal?.aborted) throw new BarrierAbort("cancelled");
    const left = deadline - this.monotonic();
    if (left <= 0) throw new BarrierAbort("barrier_timeout");
    return left;
  }

  /** Take the exclusive lock, record, seal, and commit in one transaction. */
  private async barrier(checkpointId: string, epoch: number, startedAtMs: number, started: number, deadline: number, signal?: AbortSignal) {
    return this.database.transaction(async transaction => {
      while (!rows<{ locked: boolean }>(await transaction.execute(sql`SELECT pg_try_advisory_xact_lock(${BARRIER_LOCK}) AS locked`))[0]!.locked) {
        this.remaining(deadline, signal);
        await this.wait(FACTORY_CHECKPOINT_LIMITS.pollMs);
      }
      this.remaining(deadline, signal);
      const lsn = rows<{ lsn: string }>(await transaction.execute(sql`SELECT pg_current_wal_lsn()::text AS lsn`))[0]!.lsn;
      if (rows(await transaction.execute(sql`SELECT 1 FROM factory_runs r LEFT JOIN (SELECT project_id, run_id, count(*) AS held, max(sequence) AS top FROM factory_audit_batches WHERE tenant_id = ${this.tenantId} GROUP BY project_id, run_id) a
          ON a.project_id = r.project_id AND a.run_id = r.run_id
        WHERE r.tenant_id = ${this.tenantId} AND a.top IS NOT NULL AND (a.held <> a.top OR r.next_sequence <> a.top + 1) LIMIT 1`)).length) throw new BarrierAbort("audit_inconsistent");
      const { state, objects } = await captureFactoryProductState(transaction, this.tenantId);
      const live = await liveRuns(transaction, this.tenantId);
      const fenced = await fencedSenders(transaction, this.tenantId, this.now());
      const schemaDigest = await factorySchemaDigest(transaction);
      const previous = rows<{ checkpoint_id: string }>(await transaction.execute(sql`SELECT checkpoint_id FROM factory_checkpoints WHERE tenant_id = ${this.tenantId} AND state = 'sealed' ORDER BY sealed_at DESC LIMIT 1`))[0]?.checkpoint_id ?? null;
      const wrap = await factoryKeyWrapDigest(transaction, this.options.installationId) ?? { installationId: this.options.installationId, wrapVersion: null, masterKeyId: null, wrappedDigest: null };
      const pool = await this.poolPosition(deadline, signal);
      const temporal = await this.temporalPositions(live, deadline, signal);
      const archive = this.options.archive;
      const guarded = async <Value>(write: () => Promise<Value>, margin = 0): Promise<Value> => {
        if (this.remaining(deadline, signal) <= margin) throw new BarrierAbort("barrier_timeout");
        try { return await write(); } catch (cause) { throw new BarrierAbort("archive_failed", { cause }); }
      };
      const objectsReference = await guarded(() => writeFactoryRecoveryJson(archive, this.tenantId, "checkpoint", checkpointId, { schemaVersion: FACTORY_CHECKPOINT_OBJECTS_SCHEMA, tenantId: this.tenantId, checkpointId, objects }));
      const manifest: FactoryCheckpointManifest = {
        schemaVersion: FACTORY_CHECKPOINT_MANIFEST_SCHEMA, tenantId: this.tenantId, installationId: this.options.installationId, checkpointId,
        previousCheckpointId: previous, executionEpoch: epoch, startedAtMs,
        product: { lsn, schemaDigest, state, liveRuns: live, objects: objectsReference },
        fenced, pool, temporal,
        keys: wrap,
      };
      const manifestReference = await guarded(() => writeFactoryRecoveryJson(archive, this.tenantId, "checkpoint", checkpointId, manifest));
      const durationMs = Math.round(this.monotonic() - started);
      const seal: FactoryCheckpointSeal = { schemaVersion: FACTORY_CHECKPOINT_SEAL_SCHEMA, tenantId: this.tenantId, checkpointId, manifest: manifestReference, manifestDigest: manifestReference.digest, sealedAtMs: this.now(), durationMs };
      // The seal is the claim. Once it is written inside the maximum nothing
      // after it may refuse the checkpoint, so no deadline check follows.
      const sealReference = await guarded(() => writeFactoryRecoveryJson(archive, this.tenantId, "checkpoint", FACTORY_CHECKPOINT_SEALS_RECORD, seal), FACTORY_CHECKPOINT_LIMITS.sealMarginMs);
      await transaction.execute(sql`INSERT INTO factory_checkpoints (tenant_id, checkpoint_id, state, execution_epoch, key_wrap_version, started_at_ms, duration_ms, product_lsn, manifest_digest, manifest_archive_json, previous_checkpoint_id, sealed_at)
        VALUES (${this.tenantId}, ${checkpointId}, 'sealed', ${epoch}, ${wrap.wrapVersion}, ${startedAtMs}, ${durationMs}, ${lsn}, ${manifestReference.digest}, ${canonicalJson(manifestReference)}, ${previous}, clock_timestamp())`);
      return { lsn, manifest: manifestReference, seal: sealReference, fenced: fencedCount(fenced) };
    });
  }

  private async poolPosition(deadline: number, signal?: AbortSignal): Promise<FactoryCheckpointManifest["pool"]> {
    if (!this.options.pool) return { captured: false, reason: "no pool ledger source is composed in this process" };
    this.remaining(deadline, signal);
    try {
      const snapshot = await this.options.pool.snapshotTenant(this.tenantId, signal);
      return { captured: true, position: snapshot.position, digest: sha256Hex(canonicalJson(snapshot.rows)), rows: snapshot.rows };
    } catch (cause) { throw new BarrierAbort("pool_unavailable", { cause }); }
  }

  private async temporalPositions(live: readonly FactoryProductRunPosition[], deadline: number, signal?: AbortSignal): Promise<FactoryCheckpointManifest["temporal"]> {
    if (!this.options.temporal) return { captured: false, reason: "no Temporal position source is composed in this process" };
    this.remaining(deadline, signal);
    const workflowIds = live.flatMap(run => run.interpreters.map(interpreter => factoryInterpreterWorkflowId(this.tenantId, run.runId, interpreter.interpreterId)));
    try { return { captured: true, namespace: this.options.temporal.namespace, workflows: await this.options.temporal.positions(workflowIds, signal) }; }
    catch (cause) { throw new BarrierAbort("temporal_unavailable", { cause }); }
  }
}

/**
 * Canonical Temporal workflow id of one interpreter partition. The same rule as
 * `factoryWorkflowId` in the orchestrator contracts; restated here because this
 * module runs in the product process, which never loads the orchestrator
 * package, and pinned to it by a test.
 */
export function factoryInterpreterWorkflowId(tenantId: string, runId: string, interpreterId: string): string {
  const root = `${tenantId}/${runId}`;
  return interpreterId === "root" ? root : `${root}/partitions/${interpreterId}`;
}

/**
 * The newest sealed checkpoint in the independent archive, found with the
 * archive alone. A seal is trusted only if its manifest reads back, names this
 * tenant and checkpoint, and its digest matches the seal.
 */
export async function latestFactoryCheckpoint(archive: FactoryRecoveryArchive, tenantId: string, signal?: AbortSignal): Promise<{ readonly seal: FactoryCheckpointSeal; readonly manifest: FactoryCheckpointManifest } | null> {
  const seals: FactoryCheckpointSeal[] = [];
  for (const object of await archive.list(tenantId, "checkpoint", FACTORY_CHECKPOINT_SEALS_RECORD, signal)) {
    const seal = await readFactoryRecoveryJson<FactoryCheckpointSeal>(archive, object, signal);
    if (seal?.schemaVersion === FACTORY_CHECKPOINT_SEAL_SCHEMA && seal.tenantId === tenantId && Number.isSafeInteger(seal.sealedAtMs)) seals.push(seal);
  }
  seals.sort((left, right) => right.sealedAtMs - left.sealedAtMs || right.checkpointId.localeCompare(left.checkpointId));
  const seal = seals[0];
  return seal ? { seal, manifest: await readFactoryCheckpointManifest(archive, seal, signal) } : null;
}

/** Reads and validates one sealed manifest. Anything that does not match its seal is refused. */
export async function readFactoryCheckpointManifest(archive: Pick<FactoryRecoveryArchive, "read">, seal: FactoryCheckpointSeal, signal?: AbortSignal): Promise<FactoryCheckpointManifest> {
  const reference = parseFactoryArchiveReference(seal.manifest);
  if (reference.digest !== seal.manifestDigest) throw new FactoryCheckpointError("factory_checkpoint_manifest_invalid");
  const manifest = await readFactoryRecoveryJson<FactoryCheckpointManifest>(archive, reference, signal);
  if (manifest?.schemaVersion !== FACTORY_CHECKPOINT_MANIFEST_SCHEMA || manifest.tenantId !== seal.tenantId || manifest.checkpointId !== seal.checkpointId) throw new FactoryCheckpointError("factory_checkpoint_manifest_invalid");
  return manifest;
}

export interface FactoryCheckpointCycleResult {
  readonly outcomes: readonly { readonly tenantId: string; readonly outcome: FactoryCheckpointOutcome | { readonly kind: "failed"; readonly error: string } }[];
  readonly maxInFlight: number;
  readonly durationMs: number;
}

/**
 * One cycle across tenants with at most sixteen barriers in flight. With 100
 * tenants and the ten-second maximum the worst case is about seventy seconds
 * per cycle, inside the fifteen-minute bound.
 */
export async function runFactoryCheckpointCycle(coordinators: readonly Pick<FactoryCheckpointCoordinator, "tenantId" | "run">[], options: { readonly maxConcurrent?: number; readonly monotonic?: () => number; readonly signal?: AbortSignal } = {}): Promise<FactoryCheckpointCycleResult> {
  const maxConcurrent = options.maxConcurrent ?? FACTORY_CHECKPOINT_LIMITS.maxConcurrentBarriers;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > FACTORY_CHECKPOINT_LIMITS.maxConcurrentBarriers) throw new FactoryCheckpointError("factory_checkpoint_invalid");
  const monotonic = options.monotonic ?? (() => performance.now());
  const started = monotonic();
  const outcomes: FactoryCheckpointCycleResult["outcomes"][number][] = new Array(coordinators.length);
  let next = 0, inFlight = 0, maxInFlight = 0;
  const lane = async () => {
    while (next < coordinators.length && !options.signal?.aborted) {
      const index = next++;
      const coordinator = coordinators[index]!;
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      try { outcomes[index] = { tenantId: coordinator.tenantId, outcome: await coordinator.run(options.signal) }; }
      catch (error) { outcomes[index] = { tenantId: coordinator.tenantId, outcome: { kind: "failed", error: error instanceof Error ? error.message : String(error) } }; }
      finally { inFlight -= 1; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrent, coordinators.length) }, lane));
  return { outcomes: outcomes.filter(Boolean), maxInFlight, durationMs: Math.round(monotonic() - started) };
}
