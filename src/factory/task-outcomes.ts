import { validateFactoryRunnerResult, type FactoryRunnerResult } from "@ezcorp/factory-sdk";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryAttemptQueue } from "./attempt-queue";
import { factoryAttemptAuthority } from "./attempt-queue";
import type { FactoryBudgets } from "./budgets";
import type { FactoryCommandAuthority } from "./command-authority";
import type { FactoryComputeAdmissions } from "./compute-admissions";
import type { FactoryAttemptAuthority, FactoryExecutionJournal } from "./executions";
import type { FactoryInbox } from "./inbox";
import { lockFactoryScope } from "./locks";
import { assertFactoryIdentity, encodeFactoryPayload } from "./records";
import { factoryTaskReservationId } from "./task-admission";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

export type FactoryNonSuccessfulRunnerResult = Exclude<FactoryRunnerResult, { readonly status: "completed" }>;

export interface FactoryTaskOutcomeReceipt {
  readonly reservationId: string;
  readonly resultStatus: FactoryNonSuccessfulRunnerResult["status"];
  readonly terminalResultDigest: string;
  readonly evidenceDigest: string;
  readonly usageDisposition: "measured_pending_stop" | "unknown_held";
  readonly event: Extract<KernelEvent, { readonly kind: "node-failed" }>;
}

interface OutcomeRow {
  reservation_id: string;
  input_digest: string;
  authority_json: string;
  result_json: string;
  evidence_digest: string;
  receipt_json: string;
  receipt_digest: string;
}

export class FactoryTaskOutcomeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryTaskOutcomeError"; }
}

function snapshot<T>(value: T): T { return JSON.parse(encodeFactoryPayload(value)) as T; }
function hash(value: unknown): string { return `sha256:${digestObject(value)}`; }

function outcomeReceipt(
  reservationId: string,
  result: FactoryNonSuccessfulRunnerResult,
  evidence: { readonly terminalResultDigest: string; readonly evidenceDigest: string },
  authority: FactoryAttemptAuthority,
  atMs: number,
): FactoryTaskOutcomeReceipt {
  const event: FactoryTaskOutcomeReceipt["event"] = {
    kind: "node-failed",
    id: `${authority.attemptId}:failed`,
    atMs,
    nodeId: authority.nodeInstanceId,
    commandId: authority.attemptId,
    candidateGeneration: authority.candidateGeneration,
    attempt: authority.attemptNumber,
    error: result.status === "failed" ? result.error.code : result.status === "cancelled" ? "RUNNER_CANCELLED" : "RUNNER_OUTCOME_UNCERTAIN",
    failureKind: result.status === "cancelled" ? "cancelled" : "execution",
  };
  return Object.freeze({
    reservationId,
    resultStatus: result.status,
    terminalResultDigest: evidence.terminalResultDigest,
    evidenceDigest: evidence.evidenceDigest,
    usageDisposition: result.usage?.kind === "measured" ? "measured_pending_stop" : "unknown_held",
    event,
  });
}

/** Commits a failed, cancelled, or uncertain runner report without releasing its hold. */
export class FactoryTaskOutcomes {
  constructor(
    private readonly database: TransactionalDb,
    private readonly authority: FactoryCommandAuthority,
    private readonly compute: FactoryComputeAdmissions,
    private readonly journal: FactoryExecutionJournal,
    private readonly attempts: FactoryAttemptQueue,
    private readonly budgets: FactoryBudgets,
    private readonly inbox: FactoryInbox,
    private readonly now: () => number = Date.now,
  ) {
    if ([compute.tenantId, attempts.tenantId, inbox.tenantId].some(tenant => tenant !== authority.tenantId) || journal.database !== database || attempts.transactionalDatabase !== database) throw new FactoryTaskOutcomeError("factory_task_outcome_scope");
  }

  async recordInTransaction(transaction: MigrationDb, valueService: TrustedFactoryServiceIdentity, valueReference: TrustedFactoryCommandReference, valueResult: FactoryRunnerResult): Promise<FactoryTaskOutcomeReceipt> {
    const service = snapshot(valueService);
    const reference = snapshot(valueReference);
    const result = snapshot(valueResult);
    this.authority.assertService(service);
    assertFactoryIdentity(...Object.values(reference));
    if (reference.tenantId !== this.authority.tenantId || !validateFactoryRunnerResult(result).ok || result.status === "completed") throw new FactoryTaskOutcomeError("factory_task_outcome_invalid");
    const nonSuccess = result as FactoryNonSuccessfulRunnerResult;
    const inputDigest = hash({ reference, result: nonSuccess });
    return this.withRun(transaction, reference, async () => {
      const saved = await this.readReceipt(transaction, reference, inputDigest);
      if (saved) return saved;
      return this.authority.withCurrentInTransaction(transaction, service, reference, async (locked, context) => {
        if (context.command.kind !== "dispatch-node") throw new FactoryTaskOutcomeError("factory_task_outcome_invalid");
        const stored = await this.attempts.readAuthorizedStoredInTransaction(locked, reference.projectId, reference.commandId);
        const expectedReservation = factoryTaskReservationId(reference, context);
        if (!stored || stored.delivery.reference.reservationId !== expectedReservation || stored.delivery.reference.nodeInstanceId !== context.command.nodeId || stored.delivery.reference.candidateGeneration !== context.command.candidateGeneration || stored.delivery.reference.attemptNumber !== context.command.attempt) throw new FactoryTaskOutcomeError("factory_task_outcome_stale");
        const compute = await this.compute.readAdmittedInTransaction(locked, { projectId: reference.projectId, runId: reference.logicalRunId, reservationId: stored.delivery.reference.reservationId });
        if (stored.request.authority.reservationGeneration !== compute.receipt.lease.allocationGeneration || stored.request.authority.deadlineAtMs !== compute.receipt.lease.deadlineAt.getTime()) throw new FactoryTaskOutcomeError("factory_task_outcome_stale");
        const attempt = factoryAttemptAuthority(stored.delivery.reference);
        const evidence = await this.journal.verifyRunnerResultInTransaction(locked, attempt, nonSuccess);
        const atMs = this.now();
        if (!Number.isSafeInteger(atMs) || atMs < context.state.nowMs) throw new FactoryTaskOutcomeError("factory_task_outcome_clock_invalid");
        const receipt = outcomeReceipt(stored.delivery.reference.reservationId, nonSuccess, evidence, attempt, atMs);
        if (nonSuccess.status === "uncertain") await this.budgets.markUncertainInTransaction(locked, { projectId: reference.projectId, runId: reference.logicalRunId, reservationId: receipt.reservationId }, "runner_outcome_uncertain");
        await this.inbox.enqueueInTransaction(locked, { projectId: reference.projectId, runId: reference.logicalRunId, interpreterId: reference.interpreterId }, receipt.event);
        const authorityJson = canonicalJson({ ...attempt, deadlineAt: attempt.deadlineAt.getTime() });
        const resultJson = evidence.resultJson;
        const receiptJson = encodeFactoryPayload(receipt);
        const receiptDigest = hash({ reference, inputDigest, authorityJson, resultJson, receipt });
        await locked.execute(sql`INSERT INTO factory_task_outcomes (tenant_id,project_id,run_id,interpreter_id,command_id,attempt_id,reservation_id,input_digest,authority_json,result_json,evidence_digest,receipt_json,receipt_digest) VALUES (${reference.tenantId},${reference.projectId},${reference.logicalRunId},${reference.interpreterId},${reference.commandId},${attempt.attemptId},${receipt.reservationId},${inputDigest},${authorityJson},${resultJson},${evidence.evidenceDigest},${receiptJson},${receiptDigest})`);
        return Object.freeze(receipt);
      });
    });
  }

  async readInTransaction(transaction: MigrationDb, valueService: TrustedFactoryServiceIdentity, valueReference: TrustedFactoryCommandReference): Promise<FactoryTaskOutcomeReceipt | undefined> {
    const service = snapshot(valueService);
    const reference = snapshot(valueReference);
    this.authority.assertService(service);
    assertFactoryIdentity(...Object.values(reference));
    if (reference.tenantId !== this.authority.tenantId) throw new FactoryTaskOutcomeError("factory_task_outcome_scope");
    return this.withRun(transaction, reference, () => this.readReceipt(transaction, reference));
  }

  private async withRun<Result>(transaction: MigrationDb, reference: TrustedFactoryCommandReference, work: () => Promise<Result>): Promise<Result> {
    if (!await lockFactoryScope(transaction, reference.tenantId, reference.projectId)) throw new FactoryTaskOutcomeError("factory_task_outcome_scope");
    const run = rows(await transaction.execute(sql`SELECT run_id FROM factory_runs WHERE tenant_id=${reference.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} FOR UPDATE`))[0];
    if (!run) throw new FactoryTaskOutcomeError("factory_task_outcome_scope");
    return work();
  }

  private async readReceipt(transaction: MigrationDb, reference: TrustedFactoryCommandReference, inputDigest?: string): Promise<FactoryTaskOutcomeReceipt | undefined> {
    const row = rows<OutcomeRow>(await transaction.execute(sql`SELECT reservation_id,input_digest,authority_json,result_json,evidence_digest,receipt_json,receipt_digest FROM factory_task_outcomes WHERE tenant_id=${reference.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND interpreter_id=${reference.interpreterId} AND command_id=${reference.commandId}`))[0];
    if (!row) return undefined;
    const receipt = JSON.parse(row.receipt_json) as FactoryTaskOutcomeReceipt;
    const result = JSON.parse(row.result_json) as FactoryRunnerResult;
    if (row.receipt_digest !== hash({ reference, inputDigest: row.input_digest, authorityJson: row.authority_json, resultJson: row.result_json, receipt }) || canonicalJson(receipt) !== row.receipt_json || canonicalJson(result) !== row.result_json) throw new FactoryTaskOutcomeError("factory_task_outcome_corrupt");
    if (inputDigest !== undefined && row.input_digest !== inputDigest) throw new FactoryTaskOutcomeError("factory_task_outcome_conflict");
    const raw = JSON.parse(row.authority_json) as Omit<FactoryAttemptAuthority, "deadlineAt"> & { deadlineAt: number };
    const authority = { ...raw, deadlineAt: new Date(raw.deadlineAt) };
    const evidence = await this.journal.verifyRunnerResultInTransaction(transaction, authority, result);
    const delivery = await this.attempts.readInTransaction(transaction, reference.projectId, reference.commandId);
    const atMs = (receipt as Partial<FactoryTaskOutcomeReceipt>).event?.atMs;
    if (result.status === "completed" || typeof atMs !== "number" || !Number.isSafeInteger(atMs) || atMs < 0 || !delivery
      || delivery.reference.reservationId !== row.reservation_id || canonicalJson(delivery.reference.command) !== canonicalJson(reference)
      || row.input_digest !== hash({ reference, result })
      || row.evidence_digest !== evidence.evidenceDigest
      || canonicalJson(receipt) !== canonicalJson(outcomeReceipt(row.reservation_id, result, evidence, authority, atMs))) {
      throw new FactoryTaskOutcomeError("factory_task_outcome_corrupt");
    }
    return Object.freeze(receipt);
  }
}
