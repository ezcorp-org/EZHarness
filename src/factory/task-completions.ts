import { validateFactoryRunnerResult, type FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { validateNodeOutput } from "@ezcorp/factory-sdk/kernel";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import { MAX_ACTIVITY_PAYLOAD_BYTES } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import { artifactJson, type FactoryArtifacts } from "./artifacts";
import type { FactoryAttemptQueue } from "./attempt-queue";
import type { FactoryBudgets } from "./budgets";
import type { FactoryCommandAuthority } from "./command-authority";
import type { FactoryComputeAdmissions } from "./compute-admissions";
import type { FactoryExecutionJournal, FactoryExecutionTerminalFact, FactoryAttemptAuthority } from "./executions";
import { lockFactoryScope } from "./locks";
import type { FactoryInbox } from "./inbox";
import { assertFactoryIdentity, encodeFactoryPayload } from "./records";
import { factoryTaskReservationId } from "./task-admission";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

export interface FactoryTaskCompletionReceipt {
  readonly reservationId: string;
  readonly event: Extract<KernelEvent, { kind: "node-result" }>;
  readonly terminal: FactoryExecutionTerminalFact;
}
interface ReceiptRow { input_digest: string; receipt_json: string; receipt_digest: string; authority_json: string }
export class FactoryTaskCompletionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryTaskCompletionError"; }
}
function snapshot<T>(value: T): T { return JSON.parse(encodeFactoryPayload(value)) as T; }
function hash(value: unknown): string { return `sha256:${digestObject(value)}`; }

/** One successful task commits its journal fact, measured spend and workflow reply together. */
export class FactoryTaskCompletions {
  constructor(private readonly database: TransactionalDb, private readonly authority: FactoryCommandAuthority, private readonly compute: FactoryComputeAdmissions, private readonly journal: FactoryExecutionJournal, private readonly attempts: FactoryAttemptQueue, private readonly artifacts: FactoryArtifacts, private readonly budgets: FactoryBudgets, private readonly inbox: FactoryInbox, private readonly now: () => number = Date.now) {
    if ([compute.tenantId, attempts.tenantId, artifacts.tenantId, inbox.tenantId].some(tenant => tenant !== authority.tenantId) || journal.database !== database || artifacts.database !== database) throw new FactoryTaskCompletionError("factory_task_completion_scope");
  }

  async complete(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, valueResult: FactoryRunnerResult): Promise<FactoryTaskCompletionReceipt> {
    const captured = snapshot({ service, reference: value, result: valueResult });
    return this.database.transaction(transaction => this.completeInTransaction(transaction, captured.service, captured.reference, captured.result));
  }

  async readInTransaction(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference): Promise<FactoryTaskCompletionReceipt | undefined> {
    service = snapshot(service);
    const reference = snapshot(value);
    this.authority.assertService(service);
    assertFactoryIdentity(...Object.values(reference));
    if (reference.tenantId !== this.authority.tenantId) throw new FactoryTaskCompletionError("factory_task_completion_scope");
    return this.withRun(transaction, reference, () => this.readReceipt(transaction, reference));
  }

  async completeInTransaction(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, valueResult: FactoryRunnerResult): Promise<FactoryTaskCompletionReceipt> {
    service = snapshot(service);
    const reference = snapshot(value);
    const result = snapshot(valueResult);
    this.authority.assertService(service);
    assertFactoryIdentity(...Object.values(reference));
    if (reference.tenantId !== this.authority.tenantId || !validateFactoryRunnerResult(result).ok || result.status !== "completed") throw new FactoryTaskCompletionError("factory_task_completion_invalid");
    const inputDigest = hash({ reference, result });
    return this.withRun(transaction, reference, async () => {
      const saved = await this.readReceipt(transaction, reference, inputDigest);
      if (saved) return saved;
      return this.authority.withCurrentInTransaction(transaction, service, reference, async (transaction, context) => {
      if (context.command.kind !== "dispatch-node") throw new FactoryTaskCompletionError("factory_task_completion_invalid");
      const reservationId = factoryTaskReservationId(reference, context);
      const compute = await this.compute.readAdmittedInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, reservationId });
      const stored = await this.attempts.readStoredInTransaction(transaction, reference.projectId, reference.commandId);
      if (!stored || stored.delivery.reference.reservationId !== reservationId || stored.request.authority.reservationGeneration !== compute.receipt.lease.allocationGeneration || stored.request.authority.deadlineAtMs !== compute.receipt.lease.deadlineAt.getTime() || stored.delivery.reference.nodeInstanceId !== context.command.nodeId || stored.delivery.reference.candidateGeneration !== context.command.candidateGeneration || stored.delivery.reference.attemptNumber !== context.command.attempt) throw new FactoryTaskCompletionError("factory_task_completion_stale");
      const attempt = { ...stored.delivery.reference, deadlineAt: new Date(stored.delivery.reference.deadlineAtMs) };
      const atMs = this.now();
      if (!Number.isSafeInteger(atMs) || atMs < context.state.nowMs || atMs >= attempt.deadlineAt.getTime()) throw new FactoryTaskCompletionError("factory_task_completion_expired");
      const terminal = await this.journal.recordCompletedTerminalInTransaction(transaction, attempt, result, this.artifacts);
      const loaded = await this.artifacts.loadInTransaction(transaction, reference, { objectId: result.output.artifactId, digest: result.output.digest, encodedBytes: result.output.encodedBytes }, ["candidate_output"]);
      const event: FactoryTaskCompletionReceipt["event"] = { kind: "node-result", id: `${reference.commandId}:result`, atMs, nodeId: context.command.nodeId, commandId: reference.commandId, candidateGeneration: context.command.candidateGeneration, attempt: context.command.attempt, output: artifactJson.parse(loaded.content) };
      if (!validateNodeOutput(context.node, event.output)) throw new FactoryTaskCompletionError("factory_task_completion_output_invalid");
      const receipt: FactoryTaskCompletionReceipt = { reservationId, terminal, event };
      if (artifactJson.canonical(receipt).byteLength > MAX_ACTIVITY_PAYLOAD_BYTES) throw new FactoryTaskCompletionError("factory_task_completion_oversized");
      await this.budgets.settleInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, reservationId }, { costMicros: result.usage.costMicros, tokens: result.usage.inputTokens + result.usage.outputTokens, computeMs: result.usage.computeMs }, terminal.terminalFactDigest);
      await this.inbox.enqueueInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, interpreterId: reference.interpreterId }, event);
      const authorityJson = canonicalJson({ ...attempt, deadlineAt: attempt.deadlineAt.getTime() });
      const receiptJson = canonicalJson(receipt);
      const receiptDigest = hash({ reference, inputDigest, authorityJson, receipt });
      await transaction.execute(sql`INSERT INTO factory_task_completions (tenant_id,project_id,run_id,interpreter_id,command_id,attempt_id,input_digest,authority_json,receipt_json,receipt_digest) VALUES (${reference.tenantId},${reference.projectId},${reference.logicalRunId},${reference.interpreterId},${reference.commandId},${attempt.attemptId},${inputDigest},${authorityJson},${receiptJson},${receiptDigest})`);
      return receipt;
      });
    });
  }

  private async withRun<Result>(transaction: MigrationDb, reference: TrustedFactoryCommandReference, work: () => Promise<Result>): Promise<Result> {
    if (!await lockFactoryScope(transaction, reference.tenantId, reference.projectId)) throw new FactoryTaskCompletionError("factory_task_completion_scope");
    const run = rows(await transaction.execute(sql`SELECT run_id FROM factory_runs WHERE tenant_id=${reference.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} FOR UPDATE`))[0];
    if (!run) throw new FactoryTaskCompletionError("factory_task_completion_scope");
    return work();
  }

  private async readReceipt(transaction: MigrationDb, reference: TrustedFactoryCommandReference, inputDigest?: string): Promise<FactoryTaskCompletionReceipt | undefined> {
    const row = rows<ReceiptRow>(await transaction.execute(sql`SELECT input_digest,authority_json,receipt_json,receipt_digest FROM factory_task_completions WHERE tenant_id=${reference.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND interpreter_id=${reference.interpreterId} AND command_id=${reference.commandId}`))[0];
    if (!row) return undefined;
    const receipt = JSON.parse(row.receipt_json) as FactoryTaskCompletionReceipt;
    if (row.receipt_digest !== hash({ reference, inputDigest: row.input_digest, authorityJson: row.authority_json, receipt }) || canonicalJson(receipt) !== row.receipt_json) throw new FactoryTaskCompletionError("factory_task_completion_corrupt");
    if (inputDigest !== undefined && row.input_digest !== inputDigest) throw new FactoryTaskCompletionError("factory_task_completion_conflict");
    const raw = JSON.parse(row.authority_json) as Omit<FactoryAttemptAuthority, "deadlineAt"> & { deadlineAt: number };
    const verified = await this.journal.readCompletedTerminalInTransaction(transaction, { ...raw, deadlineAt: new Date(raw.deadlineAt) }, this.artifacts);
    if (hash({ reference, result: verified.result }) !== row.input_digest || canonicalJson(verified.terminal) !== canonicalJson(receipt.terminal)) throw new FactoryTaskCompletionError("factory_task_completion_corrupt");
    return receipt;
  }
}
