/**
 * The package quarantine fence (C05, W02c).
 *
 * W02 recorded quarantine and revocation as trust revisions, and every launch
 * path already refused a blocked package. Nothing stopped work that was already
 * running: `FactoryPackageTrusts` exposed a stop seam and the product composed
 * it with nothing behind it, so a quarantined package's live attempts ran to
 * their own end. This module is what stands behind that seam.
 *
 * Three rules shape it.
 *
 * 1. **It stops work the way an operator does.** It does not own a stop path.
 *    Each affected run is cancelled through `requestFactoryRunCancellationInTransaction`,
 *    the one function behind an operator's cancel. The kernel answers with a
 *    `cancel-node` for every active attempt and each reaches the host through
 *    W03's stop path unchanged. The cancel event carries the typed reason, so
 *    the run ends `cancelled` with `factory_package_quarantined` or
 *    `factory_package_revoked` as its error message.
 *
 * 2. **It runs inside the decision's transaction.** `FactoryPackageTrusts`
 *    calls it in the same commit that writes the trust revision, after taking
 *    the installation-wide write lock. Admission and launch read trust under the
 *    same lock in share mode, so a quarantine and a launch serialize: either the
 *    launch reads the quarantine and refuses, or the quarantine sees the launched
 *    attempt and cancels its run. There is no window in which both succeed.
 *
 * 3. **It leaves a record, not a recomputation.** One sealed row per attempt the
 *    decision reached. The affected-run list reads those rows. A list recomputed
 *    from live state after the fact would be empty exactly when it matters,
 *    because the attempts it stopped are no longer live.
 */
import type { RunnerReference } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { FactoryInbox } from "./inbox";
import {
  FACTORY_PACKAGE_BLOCKED_CODES,
  FactoryPackagePreparationError,
  FactoryPackageTrusts,
  factoryRunnerPackageKey,
  factoryRunnerPackageReference,
  type FactoryPackageBlockedCode,
  type FactoryPackageFenceDecision,
  type FactoryPackageQuarantineFence,
} from "./package-preparation";
import { assertFactoryIdentity } from "./records";
import { FactoryRunLifecycleError, requestFactoryRunCancellationInTransaction } from "./run-lifecycle";

export type FactoryPackageFenceDisposition = "cancel-requested" | "already-cancelling" | "run-terminal";
export type FactoryPackageFenceLaunchState = "prepared" | "launching" | "launched" | "terminal" | "uncertain";

/** One live attempt of a package: what a preview lists and what the fence acts on. */
export interface FactoryPackageLiveAttempt {
  readonly runId: string;
  readonly attemptId: string;
  readonly attemptStatus: "admitted" | "running";
  /** Absent when the attempt was admitted and no dispatcher has claimed it yet. */
  readonly launchState: FactoryPackageFenceLaunchState | null;
}

/** One sealed row: an attempt a quarantine or revocation reached, and what the fence did about it. */
export interface FactoryPackageFenceRecord extends FactoryPackageLiveAttempt {
  readonly projectId: string;
  readonly reference: RunnerReference;
  readonly trustRevision: number;
  readonly state: FactoryPackageFenceDecision["state"];
  readonly reason: FactoryPackageBlockedCode;
  readonly disposition: FactoryPackageFenceDisposition;
  /** The run's cancel event. Absent only when the run had already finished. */
  readonly cancellationEventId?: string;
  readonly recordedAtMs: number;
  readonly recordDigest: string;
}

/** Keyset position in the affected-run record. Pass the last item's cursor to continue. */
export interface FactoryPackageFenceCursor {
  readonly trustRevision: number;
  readonly attemptId: string;
}

export interface FactoryPackageFencePage {
  readonly items: readonly FactoryPackageFenceRecord[];
  readonly nextCursor?: FactoryPackageFenceCursor;
}

export const FACTORY_PACKAGE_FENCE_DEFAULT_LIMIT = 50;
export const FACTORY_PACKAGE_FENCE_MAX_LIMIT = 200;

const ATTEMPT_STATUSES = new Set(["admitted", "running"]);
const LAUNCH_STATES = new Set<string>(["prepared", "launching", "launched", "terminal", "uncertain"]);
const DISPOSITIONS = new Set<string>(["cancel-requested", "already-cancelling", "run-terminal"]);

interface LiveRow { run_id: string; attempt_id: string; status: string; launch_state: string | null }
interface RecordRow {
  trust_revision: number | string; state: string; reason: string; run_id: string; attempt_id: string; attempt_status: string;
  launch_state: string | null; disposition: string; cancellation_event_id: string | null; recorded_at_ms: number | string; record_digest: string;
}

function corrupt(): never { throw new FactoryPackagePreparationError("factory_package_fence_corrupt"); }

function recordSeal(tenantId: string, value: Omit<FactoryPackageFenceRecord, "recordDigest">): string {
  return `sha256:${digestObject({
    tenantId, projectId: value.projectId, reference: value.reference, trustRevision: value.trustRevision, state: value.state, reason: value.reason,
    runId: value.runId, attemptId: value.attemptId, attemptStatus: value.attemptStatus, launchState: value.launchState,
    disposition: value.disposition, cancellationEventId: value.cancellationEventId ?? null, recordedAtMs: value.recordedAtMs,
  })}`;
}

function liveAttempt(row: LiveRow): FactoryPackageLiveAttempt {
  if (!ATTEMPT_STATUSES.has(row.status) || (row.launch_state !== null && !LAUNCH_STATES.has(row.launch_state))) corrupt();
  return Object.freeze({ runId: row.run_id, attemptId: row.attempt_id, attemptStatus: row.status as FactoryPackageLiveAttempt["attemptStatus"], launchState: row.launch_state as FactoryPackageFenceLaunchState | null });
}

/** The production stop seam behind quarantine and revocation, and the reader of what it did. */
export class FactoryPackageFence implements FactoryPackageQuarantineFence {
  private readonly inbox: FactoryInbox;

  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly grants: FactoryGrants, private readonly now: () => number = Date.now) {
    assertFactoryIdentity(tenantId);
    if (grants.tenantId !== tenantId) throw new FactoryPackagePreparationError("factory_package_scope");
    this.inbox = new FactoryInbox(database, tenantId, now);
  }

  /**
   * Cancels every run with a live attempt on the package and records each attempt.
   *
   * Called by `FactoryPackageTrusts` inside the transaction that records the
   * decision. A run with two live attempts is cancelled once; both attempts are
   * recorded against the same cancel event.
   */
  async fenceAttempts(transaction: MigrationDb, decision: FactoryPackageFenceDecision): Promise<readonly string[]> {
    if (decision.tenantId !== this.tenantId) throw new FactoryPackagePreparationError("factory_package_scope");
    const reference = factoryRunnerPackageReference(decision.reference);
    const reason = FACTORY_PACKAGE_BLOCKED_CODES[decision.state];
    const live = await this.liveAttemptsInTransaction(transaction, decision.projectId, reference);
    const cancelled = new Map<string, { readonly disposition: FactoryPackageFenceDisposition; readonly eventId?: string }>();
    const recordedAtMs = this.now();
    for (const attempt of live) {
      let outcome = cancelled.get(attempt.runId);
      if (!outcome) {
        outcome = await this.cancelRun(transaction, decision, attempt.runId, reason);
        cancelled.set(attempt.runId, outcome);
      }
      await this.record(transaction, {
        ...attempt, projectId: decision.projectId, reference, trustRevision: decision.trustRevision, state: decision.state, reason,
        disposition: outcome.disposition, ...(outcome.eventId === undefined ? {} : { cancellationEventId: outcome.eventId }), recordedAtMs,
      });
    }
    return Object.freeze(live.map(attempt => attempt.attemptId));
  }

  /**
   * Which live attempts a quarantine or revocation of this package would reach
   * now. The same query the fence acts on, so a preview and the decision agree.
   */
  async preview(principal: FactoryPrincipal, projectId: string, rawReference: RunnerReference): Promise<readonly FactoryPackageLiveAttempt[]> {
    const reference = factoryRunnerPackageReference(rawReference);
    assertFactoryIdentity(projectId);
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, principal, projectId, "read");
      return this.liveAttemptsInTransaction(transaction, projectId, reference);
    });
  }

  /**
   * The affected-run record for one package: every attempt a quarantine or
   * revocation of it reached, oldest decision first. `trustRevision` narrows it
   * to one decision.
   */
  async affectedRuns(principal: FactoryPrincipal, projectId: string, rawReference: RunnerReference, options: { readonly trustRevision?: number; readonly limit?: number; readonly after?: FactoryPackageFenceCursor } = {}): Promise<FactoryPackageFencePage> {
    const reference = factoryRunnerPackageReference(rawReference);
    assertFactoryIdentity(projectId);
    const limit = options.limit ?? FACTORY_PACKAGE_FENCE_DEFAULT_LIMIT;
    const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > FACTORY_PACKAGE_FENCE_MAX_LIMIT || (options.trustRevision !== undefined && !positive(options.trustRevision)) || (options.after !== undefined && !positive(options.after.trustRevision))) throw new FactoryPackagePreparationError("factory_package_fence_invalid");
    if (options.after) assertFactoryIdentity(options.after.attemptId);
    const [name, version, digest, exported, referenceDigest] = factoryRunnerPackageKey(reference);
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, principal, projectId, "read");
      const found = rows<RecordRow>(await transaction.execute(sql`
        SELECT trust_revision, state, reason, run_id, attempt_id, attempt_status, launch_state, disposition, cancellation_event_id, recorded_at_ms, record_digest
        FROM factory_package_fence_runs
        WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND package_name=${name} AND package_version=${version}
          AND package_digest=${digest} AND export_name=${exported} AND reference_digest=${referenceDigest}
          ${options.trustRevision === undefined ? sql`` : sql`AND trust_revision=${options.trustRevision}`}
          ${options.after === undefined ? sql`` : sql`AND (trust_revision, attempt_id) > (${options.after.trustRevision}, ${options.after.attemptId})`}
        ORDER BY trust_revision, attempt_id
        LIMIT ${limit + 1}`));
      const items = found.slice(0, limit).map(row => this.decode(projectId, reference, row));
      const last = items.at(-1);
      return Object.freeze(found.length > limit && last ? { items, nextCursor: Object.freeze({ trustRevision: last.trustRevision, attemptId: last.attemptId }) } : { items });
    });
  }

  /**
   * The package's live attempts in this project. `request_json` is read in both
   * shapes a driver can leave it in: an object, or a JSON string holding one
   * (Bun's SQL driver types a text parameter as json, so a text-to-jsonb cast can
   * store a string scalar). Every field of the pinned tuple is compared, so two
   * packages that share bytes but not a tuple never fence each other.
   */
  private async liveAttemptsInTransaction(transaction: MigrationDb, projectId: string, reference: RunnerReference): Promise<readonly FactoryPackageLiveAttempt[]> {
    const found = rows<LiveRow>(await transaction.execute(sql`
      SELECT e.run_id, e.attempt_id, e.status, l.state AS launch_state
      FROM factory_executions e
      CROSS JOIN LATERAL (SELECT (CASE WHEN jsonb_typeof(e.request_json)='string' THEN (e.request_json #>> '{}')::jsonb ELSE e.request_json END)->'runner' AS runner) request
      LEFT JOIN factory_attempt_launches l ON l.attempt_id=e.attempt_id
      WHERE e.tenant_id=${this.tenantId} AND e.project_id=${projectId} AND e.status IN ('admitted','running')
        AND request.runner->>'package'=${reference.package} AND request.runner->>'manifestName'=${reference.manifestName}
        AND request.runner->>'version'=${reference.version} AND request.runner->>'digest'=${reference.digest}
        AND request.runner->>'export'=${reference.export}
        AND (request.runner->>'model') IS NOT DISTINCT FROM ${reference.model ?? null}::text
        AND (request.runner->>'configurationDigest') IS NOT DISTINCT FROM ${reference.configurationDigest ?? null}::text
      ORDER BY e.run_id, e.attempt_id`));
    return Object.freeze(found.map(liveAttempt));
  }

  /** The one cancel implementation, with the typed reason. A finished run is recorded, not refused. */
  private async cancelRun(transaction: MigrationDb, decision: FactoryPackageFenceDecision, runId: string, reason: FactoryPackageBlockedCode): Promise<{ readonly disposition: FactoryPackageFenceDisposition; readonly eventId?: string }> {
    try {
      const cancellation = await requestFactoryRunCancellationInTransaction(transaction, { tenantId: this.tenantId, inbox: this.inbox, now: this.now }, { projectId: decision.projectId, runId }, { principal: decision.actor, reason });
      return { disposition: cancellation.requested ? "cancel-requested" : "already-cancelling", eventId: cancellation.eventId };
    } catch (error) {
      if (error instanceof FactoryRunLifecycleError && error.code === "factory_run_terminal") return { disposition: "run-terminal" };
      throw error;
    }
  }

  private async record(transaction: MigrationDb, value: Omit<FactoryPackageFenceRecord, "recordDigest">): Promise<void> {
    const [name, version, digest, exported, referenceDigest] = factoryRunnerPackageKey(value.reference);
    const recordDigest = recordSeal(this.tenantId, value);
    await transaction.execute(sql`INSERT INTO factory_package_fence_runs (tenant_id, project_id, package_name, package_version, package_digest, export_name, reference_digest, trust_revision, state, reason, run_id, attempt_id, attempt_status, launch_state, disposition, cancellation_event_id, recorded_at_ms, record_digest)
      VALUES (${this.tenantId}, ${value.projectId}, ${name}, ${version}, ${digest}, ${exported}, ${referenceDigest}, ${value.trustRevision}, ${value.state}, ${value.reason}, ${value.runId}, ${value.attemptId}, ${value.attemptStatus}, ${value.launchState}, ${value.disposition}, ${value.cancellationEventId ?? null}, ${value.recordedAtMs}, ${recordDigest})
      ON CONFLICT DO NOTHING`);
  }

  private decode(projectId: string, reference: RunnerReference, row: RecordRow): FactoryPackageFenceRecord {
    const trustRevision = Number(row.trust_revision), recordedAtMs = Number(row.recorded_at_ms);
    if (!Number.isSafeInteger(trustRevision) || trustRevision < 1 || !Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0 || (row.state !== "quarantined" && row.state !== "revoked") || row.reason !== FACTORY_PACKAGE_BLOCKED_CODES[row.state] || !DISPOSITIONS.has(row.disposition)) corrupt();
    const unsigned: Omit<FactoryPackageFenceRecord, "recordDigest"> = {
      ...liveAttempt({ run_id: row.run_id, attempt_id: row.attempt_id, status: row.attempt_status, launch_state: row.launch_state }),
      projectId, reference, trustRevision, state: row.state, reason: row.reason, disposition: row.disposition as FactoryPackageFenceDisposition,
      ...(row.cancellation_event_id === null ? {} : { cancellationEventId: row.cancellation_event_id }), recordedAtMs,
    };
    if (row.record_digest !== recordSeal(this.tenantId, unsigned)) corrupt();
    return Object.freeze({ ...unsigned, recordDigest: row.record_digest });
  }
}

/**
 * The trust store as the product must compose it: with the production fence
 * behind its stop seam. A composition that builds `FactoryPackageTrusts` without
 * a fence cannot quarantine or revoke at all (`factory_package_fence_unavailable`).
 */
export function createFactoryPackageTrusts(database: TransactionalDb, tenantId: string, grants: FactoryGrants, now: () => number = Date.now): FactoryPackageTrusts {
  return new FactoryPackageTrusts(database, tenantId, grants, new FactoryPackageFence(database, tenantId, grants, now));
}
