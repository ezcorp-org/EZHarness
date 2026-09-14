import { createPublicKey, type KeyLike } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryRunnerResult, FactoryUsage } from "@ezcorp/factory-sdk";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import { factoryAttemptAuthority, type FactoryAttemptQueue } from "./attempt-queue";
import type { FactoryBudgets } from "./budgets";
import type { FactoryCommandAuthority } from "./command-authority";
import type { FactoryComputeAdmissions } from "./compute-admissions";
import type { FactoryAttemptAuthority, FactoryExecutionJournal } from "./executions";
import type { FactoryInbox } from "./inbox";
import { firstFactoryJournalIssue, validateFactoryStopReceipt, type FactoryJournalHostKey, type FactoryPhysicalStopExpectation } from "./journal-validation";
import { lockFactoryScope } from "./locks";
import type { PoolLeaseStatus } from "./pool/ledger";
import { assertFactoryIdentity, encodeFactoryPayload } from "./records";
import { factoryAttemptWorkerId, readFactoryAttemptLaunchFacts, type FactoryAttemptLaunchState, type FactoryPhysicalStopReason, type FactoryPhysicalStopReceipt } from "./runner/attempt-runtime";
import type { FactoryTaskOutcomes, FactoryVerifiedTaskOutcome } from "./task-outcomes";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import type { FactoryUsageSettlementAuthority, FactoryUsageSettlements, FactoryUsageSettlementScope } from "./usage-settlement";

/** C02: abort, then at most this much cleanup, then kill the whole sandbox. */
export { FACTORY_SANDBOX_ABORT_GRACE_MS as FACTORY_STOP_ABORT_GRACE_MS } from "./runner/sandbox-stop";
/** Ten seconds of contract grace plus ten seconds of kill-and-confirm margin. */
export const FACTORY_PHYSICAL_STOP_TIMEOUT_MS = 20_000;

/** Where the stop authority came from. `sealed-launch` is the live path. */
export type FactoryStopSource = "terminal-outcome" | "sealed-launch";

/**
 * Stop authority derived from the exact sealed admission plus the durable
 * launch record. A live cancellation never needs a terminal result, so
 * `terminalOutcome` is present only when one already exists.
 */
export interface FactoryLiveStopAuthority {
  readonly schemaVersion: "factory.stop-authority.v1";
  readonly attemptId: string;
  readonly authority: FactoryAttemptAuthority;
  readonly reservationId: string;
  readonly workerId: string;
  readonly invocationId: string;
  readonly hostId: string;
  readonly holderGeneration: number;
  readonly allocationGeneration: number;
  readonly allocationToken: string;
  readonly requestDigest: string;
  readonly launchState: FactoryAttemptLaunchState;
  readonly terminalOutcome?: FactoryVerifiedTaskOutcome;
  /**
   * The durable terminal result W01 stores on `factory_attempt_launches`
   * (freeze section 16). Present when the guest finished before the stop, so a
   * live cancellation can settle a measured cost without an outcome row.
   */
  readonly terminalResult?: FactoryRunnerResult;
}

/** The sealed stop request. It carries every fact a signed receipt must reproduce. */
export interface FactoryTaskStopRequest extends FactoryPhysicalStopExpectation {
  readonly cancelReference: TrustedFactoryCommandReference;
  /** Absent when the attempt is still running and has no outcome row. */
  readonly attemptReference?: TrustedFactoryCommandReference;
  readonly attemptId: string;
  readonly reservationId: string;
  readonly workerId: string;
  readonly holderGeneration: number;
  readonly allocationGeneration: number;
  readonly hostId: string;
  readonly reason: FactoryPhysicalStopReason;
  readonly source: FactoryStopSource;
}

export interface FactoryPhysicalStopper {
  /** Calls the authenticated host supervisor. The product process cannot sign this response. */
  stop(request: FactoryTaskStopRequest, signal: AbortSignal): Promise<FactoryPhysicalStopReceipt>;
}

/** Trusted pool presenter. It authenticates the host receipt outside the product transaction. */
export interface FactoryPoolStopAcknowledger {
  confirmStopped(input: { readonly reservationId: string; readonly holderGeneration: number; readonly hostId: string }, signal?: AbortSignal): Promise<PoolLeaseStatus>;
}

export interface FactoryStopHostKey {
  readonly hostId: string;
  readonly hostKeyId: string;
  readonly publicKey: string | Buffer | KeyLike;
}

export type FactoryTaskStopState = "accepted" | "uncertain" | "stopped";

export interface FactoryTaskStopReceipt {
  readonly state: "uncertain" | "stopped";
  readonly event: Extract<KernelEvent, { readonly kind: "attempt-stopped" }>;
  readonly stopReceipt?: FactoryPhysicalStopReceipt;
}

/** Widened from `string`. W14 maps each member to an HTTP status. */
export type FactoryTaskStopCode =
  | "factory_task_stop_scope"
  | "factory_task_stop_key_invalid"
  | "factory_task_stop_invalid"
  | "factory_task_stop_corrupt"
  | "factory_task_stop_not_found"
  | "factory_task_stop_conflict"
  | "factory_task_stop_stale"
  | "factory_task_stop_pool_mismatch"
  | "factory_task_stop_proof_invalid"
  | "factory_task_stop_clock_invalid"
  | "factory_task_stop_timeout";

/** Every member of `FactoryTaskStopCode`, so W14 can prove its mapping is total. */
export const FACTORY_TASK_STOP_CODES: readonly FactoryTaskStopCode[] = Object.freeze([
  "factory_task_stop_scope",
  "factory_task_stop_key_invalid",
  "factory_task_stop_invalid",
  "factory_task_stop_corrupt",
  "factory_task_stop_not_found",
  "factory_task_stop_conflict",
  "factory_task_stop_stale",
  "factory_task_stop_pool_mismatch",
  "factory_task_stop_proof_invalid",
  "factory_task_stop_clock_invalid",
  "factory_task_stop_timeout",
]);

/** Keyset position of one scanned stop. Pass the last item's cursor to continue. */
export interface FactoryStoppableCursor {
  readonly acceptedAtMs: number;
  readonly cancelCommandId: string;
}

/** One accepted cancellation the stop worker still has to drive to a settled stop. */
export interface FactoryStoppableAttempt {
  /** The cancel command reference `stop` takes. */
  readonly reference: TrustedFactoryCommandReference;
  readonly attemptId: string;
  readonly reservationId: string;
  readonly source: FactoryStopSource;
  readonly state: Exclude<FactoryTaskStopState, "stopped">;
  readonly acceptedAtMs: number;
  readonly cursor: FactoryStoppableCursor;
}

export const FACTORY_STOP_SCAN_DEFAULT_LIMIT = 100;
export const FACTORY_STOP_SCAN_MAX_LIMIT = 1_000;

const STOPPABLE_STATES = new Set<FactoryTaskStopState>(["accepted", "uncertain"]);
const STOP_SOURCES = new Set<FactoryStopSource>(["terminal-outcome", "sealed-launch"]);

export class FactoryTaskStopError extends Error {
  constructor(readonly code: FactoryTaskStopCode) { super(code); this.name = "FactoryTaskStopError"; }
}

type StopEvent = Extract<KernelEvent, { readonly kind: "attempt-stopped" }>;

interface StopRow {
  tenant_id: string; project_id: string; run_id: string; interpreter_id: string;
  cancel_command_id: string; attempt_command_id: string | null; attempt_id: string; reservation_id: string;
  request_json: string; request_digest: string; source: FactoryStopSource; state: FactoryTaskStopState;
  uncertain_event_json: string | null; uncertain_event_digest: string | null;
  stop_receipt_json: string | null; stop_receipt_digest: string | null;
  stopped_event_json: string | null; stopped_event_digest: string | null;
  accepted_at_ms: number | string;
}

/** The sealed stop and everything the settlement transaction needs to finish it. */
interface SealedStop {
  readonly request: FactoryTaskStopRequest;
  readonly liveAuthority: FactoryLiveStopAuthority;
  readonly acceptedAtMs: number;
  readonly receipt?: FactoryTaskStopReceipt;
}

function stopCopy<Value>(value: Value): Value { return JSON.parse(encodeFactoryPayload(value)) as Value; }
function stopHash(value: unknown): string { return `sha256:${digestObject(value)}`; }

function stopCount(value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new FactoryTaskStopError("factory_task_stop_invalid");
}

/** Comparable sealed facts. The deadline is compared as an instant, not an object. */
function stopAuthorityFacts(authority: FactoryAttemptAuthority) {
  return { ...authority, deadlineAt: authority.deadlineAt.getTime() };
}

function terminalStopReason(result: FactoryRunnerResult | undefined): FactoryPhysicalStopReason {
  if (!result) return "cancelled";
  return result.status === "completed" ? "completed" : result.status === "cancelled" ? "cancelled" : result.status === "failed" ? "failed" : "cancelled";
}

function stopEventFor(request: FactoryTaskStopRequest, authority: FactoryAttemptAuthority, atMs: number, phase: "stop-uncertain" | "stopped", uncertain: boolean): StopEvent {
  return Object.freeze({
    kind: "attempt-stopped",
    id: `${request.cancelReference.commandId}:${phase}`,
    atMs,
    nodeId: authority.nodeInstanceId,
    commandId: authority.attemptId,
    candidateGeneration: authority.candidateGeneration,
    attempt: authority.attemptNumber,
    ...(uncertain ? { uncertain: true } : {}),
  });
}

function parseStopJson<Value>(value: string | null): Value | undefined {
  if (value === null) return undefined;
  try { return JSON.parse(value) as Value; }
  catch { throw new FactoryTaskStopError("factory_task_stop_corrupt"); }
}

/**
 * Coordinates product cancellation with a signed, physical host stop.
 *
 * A still-running attempt has no terminal result, so the stop authority comes
 * from the exact sealed compute admission plus the durable launch record. No
 * outcome is ever fabricated to satisfy a store precondition.
 */
export class FactoryTaskStops implements FactoryUsageSettlementAuthority {
  private readonly keys: ReadonlyMap<string, FactoryJournalHostKey>;
  private readonly now: () => number;

  constructor(
    private readonly database: TransactionalDb,
    private readonly authority: FactoryCommandAuthority,
    private readonly compute: FactoryComputeAdmissions,
    private readonly journal: FactoryExecutionJournal,
    private readonly outcomes: FactoryTaskOutcomes,
    private readonly attempts: FactoryAttemptQueue,
    private readonly budgets: FactoryBudgets,
    private readonly inbox: FactoryInbox,
    private readonly settlements: FactoryUsageSettlements,
    private readonly stopper: FactoryPhysicalStopper,
    private readonly pool: FactoryPoolStopAcknowledger,
    hostKeys: readonly FactoryStopHostKey[],
    now: () => number = Date.now,
    private readonly stopTimeoutMs = FACTORY_PHYSICAL_STOP_TIMEOUT_MS,
  ) {
    if (compute.tenantId !== authority.tenantId || inbox.tenantId !== authority.tenantId || attempts.tenantId !== authority.tenantId || settlements.tenantId !== authority.tenantId || journal.database !== database || hostKeys.length < 1) throw new FactoryTaskStopError("factory_task_stop_scope");
    this.keys = factoryStopHostKeyMap(hostKeys);
    stopCount(stopTimeoutMs, 1);
    this.now = now;
  }

  /** Accepts one current cancel command before asking the host to stop its process. */
  async stop(valueService: TrustedFactoryServiceIdentity, valueReference: TrustedFactoryCommandReference): Promise<FactoryTaskStopReceipt> {
    const service = stopCopy(valueService);
    const reference = stopCopy(valueReference);
    const prior = await this.database.transaction(transaction => this.readSealed(transaction, service, reference, true));
    // Only a settled stop is terminal. Durable uncertainty is retryable: the
    // sealed request is reused, so a retry never mints a second stop identity.
    if (prior?.receipt?.state === "stopped") return prior.receipt;
    const accepted = prior ?? await this.accept(service, reference);
    try {
      const physical = await this.withDeadline(signal => this.stopper.stop(accepted.request, signal));
      return await this.confirm(service, reference, physical);
    } catch { return this.markUncertain(service, reference); }
  }

  /** Reconciles a late host receipt without invoking or relaunching the runner. */
  async confirm(valueService: TrustedFactoryServiceIdentity, valueReference: TrustedFactoryCommandReference, valueReceipt: FactoryPhysicalStopReceipt): Promise<FactoryTaskStopReceipt> {
    const service = stopCopy(valueService);
    const reference = stopCopy(valueReference);
    const receipt = stopCopy(valueReceipt);
    const current = await this.database.transaction(transaction => this.readSealed(transaction, service, reference, true));
    if (!current) throw new FactoryTaskStopError("factory_task_stop_not_found");
    if (current.receipt?.state === "stopped") {
      if (canonicalJson(current.receipt.stopReceipt) !== canonicalJson(receipt)) throw new FactoryTaskStopError("factory_task_stop_conflict");
      return current.receipt;
    }
    this.assertHostReceipt(current, receipt);
    const acknowledged = await this.withDeadline(signal => this.pool.confirmStopped({ reservationId: receipt.reservationId, holderGeneration: receipt.holderGeneration, hostId: receipt.hostId }, signal));
    // The pool records a host only for an allocation that binds a whole one, so
    // a CPU reservation has none. The host binding is proven by the signed
    // receipt this method already verified; the pool must not contradict it,
    // and having no opinion is not a contradiction.
    if (acknowledged.reservationId !== receipt.reservationId || acknowledged.state !== "settled" || acknowledged.holderGeneration !== receipt.holderGeneration || acknowledged.allocationGeneration !== receipt.allocationGeneration || (acknowledged.hostId !== undefined && acknowledged.hostId !== receipt.hostId)) throw new FactoryTaskStopError("factory_task_stop_pool_mismatch");
    return this.database.transaction(transaction => this.finalize(transaction, service, reference, receipt));
  }

  /**
   * Accepted cancellations that have not reached a settled stop.
   *
   * These are exactly the rows a stop worker must drive: `accepted` means the
   * product cancelled but no host receipt has settled it, and `uncertain`
   * means a stop was attempted and left durable uncertainty, which is
   * retryable. A `stopped` row is terminal and never appears.
   *
   * Oldest first by the acceptance clock, with the cancel command breaking
   * ties, so the order is total and a keyset page can neither repeat nor skip
   * a row. The scan takes no row locks: exclusion between concurrent workers
   * belongs to `stop`, which locks the row it settles, so two workers may list
   * the same work and only one will commit it.
   */
  async listStoppableInTransaction(transaction: MigrationDb, options: { readonly limit?: number; readonly after?: FactoryStoppableCursor } = {}): Promise<readonly FactoryStoppableAttempt[]> {
    const limit = options.limit ?? FACTORY_STOP_SCAN_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > FACTORY_STOP_SCAN_MAX_LIMIT) throw new FactoryTaskStopError("factory_task_stop_invalid");
    const after = options.after;
    if (after) { stopCount(after.acceptedAtMs); assertFactoryIdentity(after.cancelCommandId); }
    const keyset = after ? sql` AND (accepted_at_ms, cancel_command_id) > (${after.acceptedAtMs}, ${after.cancelCommandId})` : sql``;
    const scanned = rows<Pick<StopRow, "tenant_id" | "project_id" | "run_id" | "interpreter_id" | "cancel_command_id" | "attempt_id" | "reservation_id" | "source" | "state" | "accepted_at_ms">>(await transaction.execute(sql`
      SELECT tenant_id, project_id, run_id, interpreter_id, cancel_command_id, attempt_id, reservation_id, source, state, accepted_at_ms
      FROM factory_task_stops
      WHERE tenant_id = ${this.authority.tenantId} AND state IN ('accepted', 'uncertain')${keyset}
      ORDER BY accepted_at_ms, cancel_command_id
      LIMIT ${limit}`));
    return Object.freeze(scanned.map(row => {
      const acceptedAtMs = Number(row.accepted_at_ms);
      stopCount(acceptedAtMs);
      if (!STOPPABLE_STATES.has(row.state) || !STOP_SOURCES.has(row.source)) throw new FactoryTaskStopError("factory_task_stop_corrupt");
      assertFactoryIdentity(row.project_id, row.run_id, row.interpreter_id, row.cancel_command_id, row.attempt_id, row.reservation_id);
      return Object.freeze({
        reference: Object.freeze({ tenantId: row.tenant_id, projectId: row.project_id, logicalRunId: row.run_id, interpreterId: row.interpreter_id, commandId: row.cancel_command_id }),
        attemptId: row.attempt_id, reservationId: row.reservation_id, source: row.source,
        state: row.state as Exclude<FactoryTaskStopState, "stopped">, acceptedAtMs,
        cursor: Object.freeze({ acceptedAtMs, cancelCommandId: row.cancel_command_id }),
      });
    }));
  }

  /** The settlement scope for one reservation, so later reconciliation binds the same attempt. */
  async readSettlementScopeInTransaction(transaction: MigrationDb, reservationId: string): Promise<FactoryUsageSettlementScope | undefined> {
    assertFactoryIdentity(reservationId);
    const row = rows<StopRow>(await transaction.execute(sql`SELECT * FROM factory_task_stops WHERE tenant_id=${this.authority.tenantId} AND reservation_id=${reservationId} FOR UPDATE`))[0];
    if (!row) return undefined;
    const authority = await this.journal.readAuthorityInTransaction(transaction, { tenantId: row.tenant_id, projectId: row.project_id, runId: row.run_id, attemptId: row.attempt_id });
    if (!authority) throw new FactoryTaskStopError("factory_task_stop_corrupt");
    return Object.freeze({ projectId: row.project_id, runId: row.run_id, interpreterId: row.interpreter_id, reservationId, authority });
  }

  private async accept(service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference): Promise<SealedStop> {
    return this.authority.withCurrentCancellation(service, reference, async (transaction, context) => {
      const attemptReference = Object.freeze({ ...reference, commandId: context.command.attemptCommandId });
      // The queue names the attempt the cancel command fences; the durable
      // execution row is the sealed authority. A stop requires both to agree
      // and never re-authorizes forward dispatch on a cancelling run.
      const delivery = await this.attempts.readInTransaction(transaction, reference.projectId, context.command.attemptCommandId);
      if (!delivery) throw new FactoryTaskStopError("factory_task_stop_stale");
      const queued = factoryAttemptAuthority(delivery.reference);
      const authority = await this.journal.readAuthorityInTransaction(transaction, { tenantId: reference.tenantId, projectId: reference.projectId, runId: reference.logicalRunId, attemptId: queued.attemptId });
      if (!authority || canonicalJson(stopAuthorityFacts(authority)) !== canonicalJson(stopAuthorityFacts(queued))) throw new FactoryTaskStopError("factory_task_stop_stale");
      if (authority.nodeInstanceId !== context.command.nodeId || authority.candidateGeneration !== context.command.candidateGeneration || authority.attemptNumber !== context.command.attempt) throw new FactoryTaskStopError("factory_task_stop_stale");
      const outcome = await this.outcomes.readVerifiedInTransaction(transaction, service, attemptReference);
      const liveAuthority = await this.sealAuthority(transaction, reference, authority, outcome);
      const acceptedAtMs = this.clock(context.state.nowMs);
      const request: FactoryTaskStopRequest = Object.freeze({
        cancelReference: reference,
        ...(outcome ? { attemptReference } : {}),
        attemptId: liveAuthority.attemptId,
        reservationId: liveAuthority.reservationId,
        workerId: liveAuthority.workerId,
        holderGeneration: liveAuthority.holderGeneration,
        allocationGeneration: liveAuthority.allocationGeneration,
        hostId: liveAuthority.hostId,
        reason: terminalStopReason(outcome?.result ?? liveAuthority.terminalResult),
        source: outcome ? "terminal-outcome" : "sealed-launch",
      });
      const requestJson = encodeFactoryPayload(request);
      const requestDigest = stopHash(request);
      if (!await this.journal.acceptCancellationInTransaction(transaction, authority)) throw new FactoryTaskStopError("factory_task_stop_stale");
      await transaction.execute(sql`INSERT INTO factory_task_stops (tenant_id,project_id,run_id,interpreter_id,cancel_command_id,attempt_command_id,attempt_id,reservation_id,request_json,request_digest,source,state,accepted_at_ms) VALUES (${reference.tenantId},${reference.projectId},${reference.logicalRunId},${reference.interpreterId},${reference.commandId},${request.attemptReference?.commandId ?? null},${request.attemptId},${request.reservationId},${requestJson},${requestDigest},${request.source},'accepted',${acceptedAtMs}) ON CONFLICT (tenant_id,project_id,run_id,interpreter_id,cancel_command_id) DO NOTHING`);
      const saved = await this.readRow(transaction, reference);
      if (!saved || saved.request_digest !== requestDigest || saved.request_json !== requestJson) throw new FactoryTaskStopError("factory_task_stop_conflict");
      return { request, liveAuthority, acceptedAtMs: Number(saved.accepted_at_ms) };
    });
  }

  /**
   * Derives the stop authority from the sealed admission plus the durable
   * launch record. Every generation, host, worker, and token must agree before
   * a stop request can name this holder.
   */
  private async sealAuthority(transaction: MigrationDb, reference: TrustedFactoryCommandReference, authority: FactoryAttemptAuthority, outcome: FactoryVerifiedTaskOutcome | undefined): Promise<FactoryLiveStopAuthority> {
    const launch = await readFactoryAttemptLaunchFacts(transaction, authority.attemptId, authority.candidateGeneration, authority.attemptNumber);
    if (!launch || launch.state === "prepared") throw new FactoryTaskStopError("factory_task_stop_stale");
    if (launch.tenantId !== reference.tenantId || launch.projectId !== reference.projectId || launch.runId !== reference.logicalRunId || launch.requestDigest !== authority.requestDigest || launch.grantRevision !== authority.grantRevision) throw new FactoryTaskStopError("factory_task_stop_stale");
    const material = await this.compute.readRetainedAdmittedInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, reservationId: launch.reservationId });
    const { lease } = material.receipt;
    if (!lease.hostId || lease.hostId !== launch.hostId || lease.holderGeneration !== launch.holderGeneration || lease.allocationGeneration !== launch.allocationGeneration || lease.allocationToken !== launch.allocationToken || lease.allocationGeneration !== authority.reservationGeneration) throw new FactoryTaskStopError("factory_task_stop_stale");
    if (outcome && (outcome.authority.attemptId !== authority.attemptId || outcome.receipt.reservationId !== launch.reservationId || outcome.authority.candidateGeneration !== authority.candidateGeneration || outcome.authority.attemptNumber !== authority.attemptNumber)) throw new FactoryTaskStopError("factory_task_stop_stale");
    stopCount(launch.holderGeneration, 1); stopCount(launch.allocationGeneration, 1);
    return Object.freeze({
      schemaVersion: "factory.stop-authority.v1" as const,
      attemptId: authority.attemptId,
      authority,
      reservationId: launch.reservationId,
      workerId: launch.workerId,
      invocationId: launch.invocationId,
      hostId: launch.hostId,
      holderGeneration: launch.holderGeneration,
      allocationGeneration: launch.allocationGeneration,
      allocationToken: launch.allocationToken,
      requestDigest: launch.requestDigest,
      launchState: launch.state,
      ...(launch.terminalResult === undefined ? {} : { terminalResult: launch.terminalResult }),
      ...(outcome ? { terminalOutcome: outcome } : {}),
    });
  }

  private async markUncertain(service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference): Promise<FactoryTaskStopReceipt> {
    return this.database.transaction(async transaction => {
      const current = await this.readSealed(transaction, service, reference, true);
      if (!current) throw new FactoryTaskStopError("factory_task_stop_not_found");
      if (current.receipt) return current.receipt;
      const atMs = this.clock(current.acceptedAtMs);
      const event = stopEventFor(current.request, current.liveAuthority.authority, atMs, "stop-uncertain", true);
      await this.retainUncertainBudget(transaction, reference, current.request.reservationId);
      await this.inbox.enqueueInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, interpreterId: reference.interpreterId }, event);
      await transaction.execute(sql`UPDATE factory_task_stops SET state='uncertain',uncertain_event_json=${encodeFactoryPayload(event)},uncertain_event_digest=${stopHash(event)},updated_at=NOW() WHERE tenant_id=${reference.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND interpreter_id=${reference.interpreterId} AND cancel_command_id=${reference.commandId} AND state IN ('accepted','uncertain')`);
      return Object.freeze({ state: "uncertain" as const, event });
    });
  }

  private async finalize(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, receipt: FactoryPhysicalStopReceipt): Promise<FactoryTaskStopReceipt> {
    const current = await this.readSealed(transaction, service, reference, true);
    if (!current) throw new FactoryTaskStopError("factory_task_stop_not_found");
    if (current.receipt?.state === "stopped") {
      if (canonicalJson(current.receipt.stopReceipt) !== canonicalJson(receipt)) throw new FactoryTaskStopError("factory_task_stop_conflict");
      return current.receipt;
    }
    this.assertHostReceipt(current, receipt);
    await this.assertUnconsumedReceipt(transaction, current.request, receipt);
    if (!await this.journal.confirmStoppedInTransaction(transaction, current.liveAuthority.authority)) throw new FactoryTaskStopError("factory_task_stop_stale");
    const usage = terminalStopUsage(current.liveAuthority);
    const settlementScope = { projectId: reference.projectId, runId: reference.logicalRunId, interpreterId: reference.interpreterId, reservationId: current.request.reservationId, authority: current.liveAuthority.authority };
    if (usage?.kind === "measured") {
      await this.budgets.settleInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, reservationId: current.request.reservationId }, { costMicros: usage.costMicros, tokens: usage.inputTokens + usage.outputTokens, computeMs: usage.computeMs }, receipt.receiptDigest);
      await this.settlements.recordInTransaction(transaction, settlementScope, { source: "stop", knownCostMicros: usage.costMicros });
    } else {
      await this.retainUncertainBudget(transaction, reference, current.request.reservationId);
      // A held cost is reported, never settled as zero: the reservation stays
      // uncertain and the event keeps the held amount visible to the kernel.
      if (usage) await this.settlements.recordInTransaction(transaction, settlementScope, { source: "stop", knownCostMicros: "0", unknownCostMicros: usage.heldCostMicros });
    }
    const event = stopEventFor(current.request, current.liveAuthority.authority, this.clock(current.acceptedAtMs), "stopped", usage?.kind !== "measured");
    await this.inbox.enqueueInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, interpreterId: reference.interpreterId }, event);
    await transaction.execute(sql`UPDATE factory_task_stops SET state='stopped',stop_receipt_json=${encodeFactoryPayload(receipt)},stop_receipt_digest=${receipt.receiptDigest},stopped_event_json=${encodeFactoryPayload(event)},stopped_event_digest=${stopHash(event)},updated_at=NOW() WHERE tenant_id=${reference.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND interpreter_id=${reference.interpreterId} AND cancel_command_id=${reference.commandId} AND state IN ('accepted','uncertain')`);
    return Object.freeze({ state: "stopped" as const, event, stopReceipt: Object.freeze(receipt) });
  }

  /** One signed receipt settles one attempt. A replay on another attempt is refused. */
  private async assertUnconsumedReceipt(transaction: MigrationDb, request: FactoryTaskStopRequest, receipt: FactoryPhysicalStopReceipt): Promise<void> {
    const consumed = rows<{ attempt_id: string }>(await transaction.execute(sql`SELECT attempt_id FROM factory_task_stops WHERE tenant_id=${request.cancelReference.tenantId} AND stop_receipt_digest=${receipt.receiptDigest}`));
    if (consumed.some(row => row.attempt_id !== request.attemptId)) throw new FactoryTaskStopError("factory_task_stop_conflict");
  }

  private async retainUncertainBudget(transaction: MigrationDb, reference: TrustedFactoryCommandReference, reservationId: string): Promise<void> {
    const row = rows<{ state: string }>(await transaction.execute(sql`SELECT state FROM factory_budget_reservations WHERE tenant_id=${reference.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND reservation_id=${reservationId} FOR UPDATE`))[0];
    if (row?.state === "running") await this.budgets.markUncertainInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, reservationId }, "physical_stop_unconfirmed");
    else if (row?.state !== "uncertain") throw new FactoryTaskStopError("factory_task_stop_stale");
  }

  private async readSealed(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, lock: boolean): Promise<SealedStop | undefined> {
    this.authority.assertService(service);
    assertFactoryIdentity(...Object.values(reference));
    if (reference.tenantId !== this.authority.tenantId || !await lockFactoryScope(transaction, reference.tenantId, reference.projectId)) throw new FactoryTaskStopError("factory_task_stop_scope");
    const run = rows(await transaction.execute(sql`SELECT run_id FROM factory_runs WHERE tenant_id=${reference.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} FOR UPDATE`))[0];
    if (!run) throw new FactoryTaskStopError("factory_task_stop_scope");
    const row = await this.readRow(transaction, reference, lock);
    if (!row) return undefined;
    const request = parseStopJson<FactoryTaskStopRequest>(row.request_json)!;
    if (row.request_digest !== stopHash(request) || canonicalJson(request) !== row.request_json || canonicalJson(request.cancelReference) !== canonicalJson(reference)
      || request.attemptId !== row.attempt_id || request.reservationId !== row.reservation_id || request.source !== row.source
      || (request.attemptReference?.commandId ?? null) !== row.attempt_command_id
      || factoryAttemptWorkerId(request.attemptId) !== request.workerId) throw new FactoryTaskStopError("factory_task_stop_corrupt");
    stopCount(Number(row.accepted_at_ms)); stopCount(request.holderGeneration, 1); stopCount(request.allocationGeneration, 1);
    const authority = await this.journal.readAuthorityInTransaction(transaction, { tenantId: reference.tenantId, projectId: reference.projectId, runId: reference.logicalRunId, attemptId: request.attemptId });
    if (!authority) throw new FactoryTaskStopError("factory_task_stop_corrupt");
    const outcome = request.attemptReference ? await this.outcomes.readVerifiedInTransaction(transaction, service, request.attemptReference) : undefined;
    if (Boolean(outcome) !== (request.source === "terminal-outcome")) throw new FactoryTaskStopError("factory_task_stop_corrupt");
    const launch = await readFactoryAttemptLaunchFacts(transaction, request.attemptId, authority.candidateGeneration, authority.attemptNumber);
    if (!launch || launch.hostId !== request.hostId || launch.reservationId !== request.reservationId || launch.workerId !== request.workerId || launch.holderGeneration !== request.holderGeneration || launch.allocationGeneration !== request.allocationGeneration) throw new FactoryTaskStopError("factory_task_stop_corrupt");
    const liveAuthority = Object.freeze({
      schemaVersion: "factory.stop-authority.v1" as const, attemptId: request.attemptId, authority,
      reservationId: launch.reservationId, workerId: launch.workerId, invocationId: launch.invocationId, hostId: launch.hostId,
      holderGeneration: launch.holderGeneration, allocationGeneration: launch.allocationGeneration, allocationToken: launch.allocationToken,
      requestDigest: launch.requestDigest, launchState: launch.state,
      ...(launch.terminalResult === undefined ? {} : { terminalResult: launch.terminalResult }),
      ...(outcome ? { terminalOutcome: outcome } : {}),
    });
    if (terminalStopReason(outcome?.result ?? launch.terminalResult) !== request.reason) throw new FactoryTaskStopError("factory_task_stop_corrupt");
    const uncertain = parseStopJson<StopEvent>(row.uncertain_event_json);
    const physical = parseStopJson<FactoryPhysicalStopReceipt>(row.stop_receipt_json);
    const stopped = parseStopJson<StopEvent>(row.stopped_event_json);
    if ((uncertain === undefined) !== (row.uncertain_event_digest === null) || uncertain && row.uncertain_event_digest !== stopHash(uncertain)
      || (physical === undefined) !== (row.stop_receipt_digest === null) || physical && row.stop_receipt_digest !== physical.receiptDigest
      || (stopped === undefined) !== (row.stopped_event_digest === null) || stopped && row.stopped_event_digest !== stopHash(stopped)
      || row.state === "accepted" && (uncertain || physical || stopped) || row.state === "stopped" && (!physical || !stopped)) throw new FactoryTaskStopError("factory_task_stop_corrupt");
    const acceptedAtMs = Number(row.accepted_at_ms);
    const sealed: SealedStop = { request: Object.freeze(request), liveAuthority, acceptedAtMs };
    if (uncertain) {
      stopCount(uncertain.atMs);
      if (uncertain.atMs < acceptedAtMs || canonicalJson(uncertain) !== canonicalJson(stopEventFor(request, authority, uncertain.atMs, "stop-uncertain", true))) throw new FactoryTaskStopError("factory_task_stop_corrupt");
    }
    if (physical && stopped) {
      this.assertHostReceipt(sealed, physical);
      stopCount(stopped.atMs);
      const measured = terminalStopUsage(liveAuthority)?.kind === "measured";
      if (stopped.atMs < acceptedAtMs || canonicalJson(stopped) !== canonicalJson(stopEventFor(request, authority, stopped.atMs, "stopped", !measured))) throw new FactoryTaskStopError("factory_task_stop_corrupt");
    }
    const receipt = row.state === "stopped"
      ? Object.freeze({ state: "stopped" as const, event: Object.freeze(stopped!), stopReceipt: Object.freeze(physical!) })
      : row.state === "uncertain" && uncertain ? Object.freeze({ state: "uncertain" as const, event: Object.freeze(uncertain) }) : undefined;
    return { ...sealed, ...(receipt ? { receipt } : {}) };
  }

  private async readRow(transaction: MigrationDb, reference: TrustedFactoryCommandReference, lock = true): Promise<StopRow | undefined> {
    return rows<StopRow>(await transaction.execute(sql`SELECT * FROM factory_task_stops WHERE tenant_id=${reference.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND interpreter_id=${reference.interpreterId} AND cancel_command_id=${reference.commandId}${lock ? sql` FOR UPDATE` : sql``}`))[0];
  }

  /** Only a configured supervisor key can assert a physical observation. */
  private assertHostReceipt(sealed: SealedStop, receipt: FactoryPhysicalStopReceipt): void {
    const observedAtMs = this.now();
    stopCount(observedAtMs);
    const verdict = validateFactoryStopReceipt(sealed.request, receipt, this.keys, { acceptedAtMs: sealed.acceptedAtMs, observedAtMs, toleranceMs: this.stopTimeoutMs });
    if (verdict.ok) return;
    const code = firstFactoryJournalIssue(verdict);
    throw new FactoryTaskStopError(code === "factory_stop_receipt_clock_out_of_bounds" || code === "factory_stop_receipt_clock_invalid" ? "factory_task_stop_clock_invalid" : "factory_task_stop_proof_invalid");
  }

  private clock(minimum: number): number {
    const value = this.now();
    stopCount(value);
    if (value < minimum) throw new FactoryTaskStopError("factory_task_stop_clock_invalid");
    return value;
  }

  private async withDeadline<Result>(work: (signal: AbortSignal) => Promise<Result>): Promise<Result> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new FactoryTaskStopError("factory_task_stop_timeout")); }, this.stopTimeoutMs); });
    try { return await Promise.race([work(controller.signal), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }
}

/** The one terminal usage a stop may settle: the outcome's, else the durable launch result's. */
function terminalStopUsage(liveAuthority: FactoryLiveStopAuthority): FactoryUsage | undefined {
  return liveAuthority.terminalOutcome?.result.usage ?? liveAuthority.terminalResult?.usage;
}

/** Loads the configured supervisor certificates once, rejecting duplicates and bad material. */
export function factoryStopHostKeyMap(hostKeys: readonly FactoryStopHostKey[]): ReadonlyMap<string, FactoryJournalHostKey> {
  const entries = hostKeys.map(key => {
    assertFactoryIdentity(key.hostId, key.hostKeyId);
    try { return [key.hostKeyId, Object.freeze({ hostId: key.hostId, publicKey: typeof key.publicKey === "string" || Buffer.isBuffer(key.publicKey) ? createPublicKey(key.publicKey) : key.publicKey })] as const; }
    catch { throw new FactoryTaskStopError("factory_task_stop_key_invalid"); }
  });
  if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new FactoryTaskStopError("factory_task_stop_key_invalid");
  return new Map(entries);
}
