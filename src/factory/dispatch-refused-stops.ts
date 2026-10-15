import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryBudgets } from "./budgets";
import { firstFactoryJournalIssue, validateFactoryStopReceipt, type FactoryJournalHostKey } from "./journal-validation";
import type { PoolLease } from "./pool/ledger";
import { assertFactoryIdentity } from "./records";
import { factoryAttemptWorkerId, type FactoryPhysicalStopReceipt } from "./runner/attempt-runtime";
import {
  FACTORY_PHYSICAL_STOP_TIMEOUT_MS, FactoryTaskStopError, assertFactoryPoolConfirmsStop, factoryStopHostKeyMap, factoryStopWithDeadline,
  type FactoryPhysicalStopper, type FactoryPoolStopAcknowledger, type FactoryStopHostKey, type FactoryTaskStopRequest,
} from "./task-stops";
import type { TrustedFactoryCommandReference } from "./trusted-command-gateway";
import { settleFactoryNothingLaunchedInTransaction, type FactoryUsageSettlementAttempt, type FactoryUsageSettlements } from "./usage-settlement";

/**
 * W02d R8: a dispatch refused after its compute was admitted, with nothing queued, ends through a signed host stop.
 *
 * The refusal rolls back to its savepoint, so the attempt has no execution row, no launch row and no kernel
 * attempt: the kernel already failed the node through the admission-refused event. Only the admitted compute lease
 * and its budget hold remain, and C03 frees the lease only on a supervisor's signed word: the remote runtime
 * launches before it acknowledges a start, so a held lease never proves that nothing started. So the refusal's own
 * transaction records a stop of source `dispatch-refused` for the admitted reservation, addressed to the worker
 * the attempt would have had; the stop settlement role asks the host, which signs that no process group exists;
 * the pool confirms the stop; and the hold settles all zero, once, as the node attempt's "nothing launched" usage
 * (W09h's basis), proved by the host's signed stop.
 *
 * Lock order: this path locks only the stop row. There is no launch row, so FACTORY_STOP_LAUNCH_LOCK_ORDER
 * (W01h: the stop row, then the launch row) is respected trivially.
 */
export const FACTORY_DISPATCH_REFUSED_SOURCE = "dispatch-refused" as const;

/** Settles a refused dispatch's hold all zero, with the host's signed absence as its proof (W09h's basis). */
export type FactoryNothingLaunchedSettle = (transaction: MigrationDb, input: {
  readonly projectId: string; readonly runId: string; readonly interpreterId: string; readonly reservationId: string;
  readonly authority: FactoryUsageSettlementAttempt; readonly stopReceiptDigest: string;
}) => Promise<void>;

/** The production settle: W09h's shared "nothing launched, all zero" settlement of the hold and the attempt's usage. */
export function factoryNothingLaunchedSettle(stores: { readonly budgets: Pick<FactoryBudgets, "settleWithoutOperationsInTransaction">; readonly settlements: Pick<FactoryUsageSettlements, "recordInTransaction"> }): FactoryNothingLaunchedSettle {
  return (transaction, input) => settleFactoryNothingLaunchedInTransaction(transaction, stores, input, input.stopReceiptDigest, input.authority);
}

/** One recorded stop of a refused dispatch that the host has not yet signed for. */
export interface FactoryDispatchRefusedStop {
  readonly projectId: string;
  readonly runId: string;
  readonly interpreterId: string;
  readonly dispatchCommandId: string;
  readonly reservationId: string;
  readonly workerId: string;
  /** The node attempt whose usage the stop settles. */
  readonly authority: FactoryUsageSettlementAttempt;
}

interface RefusedRow {
  project_id: string; run_id: string; interpreter_id: string; cancel_command_id: string; reservation_id: string;
  worker_id: string; attempt_authority_json: string; request_json: string; request_digest: string; state: string; accepted_at_ms: number | string;
}

const REFUSED_COLUMNS = sql.raw("project_id,run_id,interpreter_id,cancel_command_id,reservation_id,worker_id,attempt_authority_json,request_json,request_digest,state,accepted_at_ms");

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The stored attempt authority, exactly as recorded, or undefined when the row does not hold one. */
function storedAuthority(json: string): FactoryUsageSettlementAttempt | undefined {
  let value: Partial<Record<keyof FactoryUsageSettlementAttempt, unknown>>;
  try { value = JSON.parse(json) as typeof value; }
  catch { return undefined; }
  if (!value || typeof value !== "object" || !text(value.attemptId) || !text(value.nodeInstanceId) || !count(value.candidateGeneration) || !count(value.attemptNumber)) return undefined;
  const authority = { attemptId: value.attemptId, nodeInstanceId: value.nodeInstanceId, candidateGeneration: value.candidateGeneration, attemptNumber: value.attemptNumber };
  return canonicalJson(authority) === json ? Object.freeze(authority) : undefined;
}

const stopHash = (value: unknown): string => `sha256:${digestObject(value)}`;

/** Records, in a refusal's own transaction, the stop that releases the refused dispatch's admitted lease. */
export class FactoryDispatchRefusedStopRecorder {
  constructor(readonly tenantId: string, private readonly hostId: string, private readonly now: () => number = Date.now) {
    assertFactoryIdentity(tenantId, hostId);
  }

  /**
   * Records the stop once for this dispatch command; a repeated refusal records nothing new. The attempt id is the
   * dispatch command's own, as the admission would have named it; the host is the lease's pinned host, or this
   * installation's for an ordinary CPU lease, as the dispatch preflight would have chosen. `authority` is the node
   * attempt the admitted hold belongs to, whose usage the stop settles.
   */
  async recordInTransaction(transaction: MigrationDb, reference: TrustedFactoryCommandReference, reservationId: string, lease: PoolLease, authority: FactoryUsageSettlementAttempt): Promise<void> {
    if (reference.tenantId !== this.tenantId || lease.tenantId !== this.tenantId || lease.reservationId !== reservationId) throw new FactoryTaskStopError("factory_task_stop_scope");
    const attemptId = reference.commandId;
    const request: FactoryTaskStopRequest = {
      cancelReference: reference, attemptId, reservationId, workerId: factoryAttemptWorkerId(attemptId),
      holderGeneration: lease.holderGeneration, allocationGeneration: lease.allocationGeneration, hostId: lease.hostId ?? this.hostId,
      reason: "failed", source: FACTORY_DISPATCH_REFUSED_SOURCE,
    };
    const attempt = { attemptId: authority.attemptId, nodeInstanceId: authority.nodeInstanceId, candidateGeneration: authority.candidateGeneration, attemptNumber: authority.attemptNumber };
    if (storedAuthority(canonicalJson(attempt)) === undefined) throw new FactoryTaskStopError("factory_task_stop_scope");
    await transaction.execute(sql`INSERT INTO factory_task_stops (tenant_id,project_id,run_id,interpreter_id,cancel_command_id,attempt_command_id,attempt_id,worker_id,attempt_authority_json,reservation_id,request_json,request_digest,source,state,accepted_at_ms)
      VALUES (${this.tenantId},${reference.projectId},${reference.logicalRunId},${reference.interpreterId},${reference.commandId},NULL,NULL,${request.workerId},${canonicalJson(attempt)},${reservationId},${canonicalJson(request)},${stopHash(request)},${FACTORY_DISPATCH_REFUSED_SOURCE},'accepted',${this.now()})
      ON CONFLICT DO NOTHING`);
  }
}

/** Drives each recorded refused-dispatch stop to the host's signed absence, the pool's confirmation and the zero. */
export class FactoryDispatchRefusedStops {
  private readonly keys: ReadonlyMap<string, FactoryJournalHostKey>;

  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly stopper: FactoryPhysicalStopper,
    private readonly pool: FactoryPoolStopAcknowledger,
    hostKeys: readonly FactoryStopHostKey[],
    private readonly settle: FactoryNothingLaunchedSettle,
    private readonly now: () => number = Date.now,
    private readonly stopTimeoutMs = FACTORY_PHYSICAL_STOP_TIMEOUT_MS,
  ) {
    assertFactoryIdentity(tenantId);
    if (hostKeys.length < 1) throw new FactoryTaskStopError("factory_task_stop_scope");
    this.keys = factoryStopHostKeyMap(hostKeys);
  }

  /** The recorded stops still waiting for the host, oldest first. */
  async listInTransaction(transaction: MigrationDb, limit = 100): Promise<readonly FactoryDispatchRefusedStop[]> {
    const found = rows<RefusedRow>(await transaction.execute(sql`SELECT ${REFUSED_COLUMNS} FROM factory_task_stops
      WHERE tenant_id=${this.tenantId} AND source=${FACTORY_DISPATCH_REFUSED_SOURCE} AND state='accepted' AND reconcile_json IS NULL ORDER BY accepted_at_ms, cancel_command_id LIMIT ${limit}`));
    return found.map(row => {
      const authority = storedAuthority(row.attempt_authority_json);
      if (!authority) throw new FactoryTaskStopError("factory_task_stop_corrupt");
      return Object.freeze({ projectId: row.project_id, runId: row.run_id, interpreterId: row.interpreter_id, dispatchCommandId: row.cancel_command_id, reservationId: row.reservation_id, workerId: row.worker_id, authority });
    });
  }

  /**
   * Asks the host for a signed absence of the worker, has the pool confirm it, and settles the hold all zero in
   * the transaction that marks the stop stopped. A stop already stopped answers `stopped` and settles nothing again.
   */
  async stop(stop: FactoryDispatchRefusedStop): Promise<"stopped"> {
    const recorded = await this.database.transaction(transaction => this.read(transaction, stop, false));
    if (recorded.row.state === "stopped") return "stopped";
    const physical = await factoryStopWithDeadline(this.stopTimeoutMs, signal => this.stopper.stop(recorded.request, signal));
    this.assertReceipt(recorded.request, physical, Number(recorded.row.accepted_at_ms));
    const acknowledged = await factoryStopWithDeadline(this.stopTimeoutMs, signal => this.pool.confirmStopped({ reservationId: physical.reservationId, holderGeneration: physical.holderGeneration, hostId: physical.hostId }, signal));
    assertFactoryPoolConfirmsStop(acknowledged, physical);
    return this.database.transaction(async transaction => {
      const locked = await this.read(transaction, stop, true);
      if (locked.row.state === "stopped") return "stopped";
      await this.settle(transaction, { projectId: stop.projectId, runId: stop.runId, interpreterId: stop.interpreterId, reservationId: stop.reservationId, authority: locked.authority, stopReceiptDigest: physical.receiptDigest });
      // The stopped record the table keeps for every stop; a refused dispatch has no kernel attempt, so it is not
      // enqueued: the kernel already failed the node through the admission-refused event.
      const stopped = { kind: "dispatch-refused-stopped", reservationId: stop.reservationId, workerId: stop.workerId, stopReceiptDigest: physical.receiptDigest, stoppedAtMs: physical.stoppedAtMs };
      await transaction.execute(sql`UPDATE factory_task_stops SET state='stopped',stop_receipt_json=${canonicalJson(physical)},stop_receipt_digest=${physical.receiptDigest},stopped_event_json=${canonicalJson(stopped)},stopped_event_digest=${stopHash(stopped)},updated_at=NOW()
        WHERE tenant_id=${this.tenantId} AND project_id=${stop.projectId} AND run_id=${stop.runId} AND interpreter_id=${stop.interpreterId} AND cancel_command_id=${stop.dispatchCommandId} AND state='accepted'`);
      return "stopped" as const;
    });
  }

  private async read(transaction: MigrationDb, stop: FactoryDispatchRefusedStop, lock: boolean): Promise<{ readonly row: RefusedRow; readonly request: FactoryTaskStopRequest; readonly authority: FactoryUsageSettlementAttempt }> {
    const [row] = rows<RefusedRow>(await transaction.execute(sql`SELECT ${REFUSED_COLUMNS} FROM factory_task_stops
      WHERE tenant_id=${this.tenantId} AND project_id=${stop.projectId} AND run_id=${stop.runId} AND interpreter_id=${stop.interpreterId} AND cancel_command_id=${stop.dispatchCommandId} AND source=${FACTORY_DISPATCH_REFUSED_SOURCE}${lock ? sql` FOR UPDATE` : sql``}`));
    if (!row) throw new FactoryTaskStopError("factory_task_stop_not_found");
    const request = JSON.parse(row.request_json) as FactoryTaskStopRequest;
    const authority = storedAuthority(row.attempt_authority_json);
    if (!authority || row.request_digest !== stopHash(request) || canonicalJson(request) !== row.request_json || request.reservationId !== row.reservation_id || request.workerId !== row.worker_id
      || request.source !== FACTORY_DISPATCH_REFUSED_SOURCE || factoryAttemptWorkerId(request.attemptId) !== request.workerId) throw new FactoryTaskStopError("factory_task_stop_corrupt");
    return { row, request, authority };
  }

  private assertReceipt(request: FactoryTaskStopRequest, receipt: FactoryPhysicalStopReceipt, acceptedAtMs: number): void {
    const verdict = validateFactoryStopReceipt(request, receipt, this.keys, { acceptedAtMs, observedAtMs: this.now(), toleranceMs: this.stopTimeoutMs });
    if (verdict.ok) return;
    const code = firstFactoryJournalIssue(verdict);
    throw new FactoryTaskStopError(code === "factory_stop_receipt_clock_out_of_bounds" || code === "factory_stop_receipt_clock_invalid" ? "factory_task_stop_clock_invalid" : "factory_task_stop_proof_invalid");
  }
}
