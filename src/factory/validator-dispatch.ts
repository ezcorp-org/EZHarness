import type { FactoryRunnerResult } from "@ezcorp/factory-sdk";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import type { FactoryArtifacts } from "./artifacts";
import { factoryAttemptAuthority, type FactoryAttemptQueue } from "./attempt-queue";
import type { FactoryCommandAuthority } from "./command-authority";
import type { FactoryAttemptAuthority, FactoryExecutionJournal, FactoryExecutionTerminalFact } from "./executions";
import { assertFactoryIdentity } from "./records";
import type { FactoryTaskCompletionReceipt } from "./task-completions";
import type { FactoryTaskOutcomeReceipt } from "./task-outcomes";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import type { FactoryTrustedValidators } from "./validator-materials";

export class FactoryValidatorDispatchError extends Error {
  constructor(readonly code: "factory_validator_dispatch_scope" | "factory_validator_dispatch_unbound" | "factory_validator_dispatch_invalid") {
    super(code);
    this.name = "FactoryValidatorDispatchError";
  }
}

type NonSuccessfulRunnerResult = Exclude<FactoryRunnerResult, { status: "completed" }>;
const snapshot = <Value>(value: Value): Value => JSON.parse(canonicalJson(value)) as Value;

/**
 * Settles a protected validator attempt through the journal instead of the kernel task path.
 *
 * `FactoryAttemptDispatcher` takes its completion and outcome collaborators as structural seams, so
 * a validator reuses the whole dispatch path unchanged: the queue claim, the attempt-token mint, the
 * readiness re-check, the lease, and every recovery branch. Only the settlement differs, and it has
 * to: `FactoryTaskCompletions` keys on a transition command, and a protected validator has none.
 *
 * Nothing here writes a kernel fact. No inbox event is enqueued and no task completion row is
 * written, because no kernel node is waiting on this attempt; the acceptance path reads the terminal
 * fact through the trusted gateway instead. The receipt's `event` is a local acknowledgement for the
 * dispatcher's own return type and is never delivered to a kernel.
 */
export class FactoryValidatorAttemptDispatch {
  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly authority: FactoryCommandAuthority,
    private readonly validators: FactoryTrustedValidators,
    private readonly journal: FactoryExecutionJournal,
    private readonly queue: FactoryAttemptQueue,
    private readonly artifacts: FactoryArtifacts,
  ) {
    assertFactoryIdentity(tenantId);
    if (authority.tenantId !== tenantId || validators.tenantId !== tenantId || queue.tenantId !== tenantId || artifacts.tenantId !== tenantId || journal.database !== database || artifacts.database !== database) throw new FactoryValidatorDispatchError("factory_validator_dispatch_scope");
  }

  async completeInTransaction(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, valueResult: FactoryRunnerResult): Promise<FactoryTaskCompletionReceipt> {
    const { reference, attempt, reservationId } = await this.bound(transaction, service, value);
    const result = snapshot(valueResult);
    if (result.status !== "completed") throw new FactoryValidatorDispatchError("factory_validator_dispatch_invalid");
    const existing = await this.readTerminal(transaction, attempt);
    const terminal = existing ?? await this.journal.recordCompletedTerminalInTransaction(transaction, attempt, result, this.artifacts);
    return Object.freeze({ reservationId, event: this.acknowledgement(reference, attempt, terminal), terminal });
  }

  async readInTransaction(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference): Promise<FactoryTaskCompletionReceipt | undefined> {
    const { reference, attempt, reservationId } = await this.bound(transaction, service, value);
    const terminal = await this.readTerminal(transaction, attempt);
    return terminal ? Object.freeze({ reservationId, event: this.acknowledgement(reference, attempt, terminal), terminal }) : undefined;
  }

  /**
   * The outcome seam for a validator that did not complete.
   *
   * A failed, cancelled, or uncertain validator produces no terminal fact and therefore no evidence,
   * so acceptance keeps waiting on a claim it does not have rather than reading a verdict that was
   * never issued. The queue's own retry and dead-letter policy decides what happens next.
   */
  async recordInTransaction(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, valueResult: FactoryRunnerResult): Promise<FactoryTaskOutcomeReceipt> {
    const { reference, attempt, reservationId } = await this.bound(transaction, service, value);
    const result = snapshot(valueResult);
    if (result.status === "completed") throw new FactoryValidatorDispatchError("factory_validator_dispatch_invalid");
    return Object.freeze(this.outcome(reference, attempt, reservationId, result));
  }

  async readOutcomeInTransaction(): Promise<FactoryTaskOutcomeReceipt | undefined> {
    // A non-terminal validator attempt leaves no durable outcome row to recover; the queue owns it.
    return undefined;
  }

  /** Resolves the exact durable attempt behind a validator dispatch, or refuses. */
  private async bound(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference): Promise<{ readonly reference: TrustedFactoryCommandReference; readonly attempt: FactoryAttemptAuthority; readonly reservationId: string }> {
    const reference = snapshot(value);
    this.authority.assertService(service);
    assertFactoryIdentity(reference.tenantId, reference.projectId, reference.logicalRunId, reference.interpreterId, reference.commandId);
    if (reference.tenantId !== this.tenantId) throw new FactoryValidatorDispatchError("factory_validator_dispatch_scope");
    const delivery = await this.queue.readInTransaction(transaction, reference.projectId, reference.commandId);
    if (!delivery || delivery.reference.attemptId !== reference.commandId || delivery.reference.runId !== reference.logicalRunId) throw new FactoryValidatorDispatchError("factory_validator_dispatch_unbound");
    // A queue row alone is not authority: only an attempt bound to a claim settles this way.
    const bound = await this.validators.readBoundAttemptInTransaction(transaction, reference.projectId, reference.commandId)
      .catch(() => { throw new FactoryValidatorDispatchError("factory_validator_dispatch_unbound"); });
    if (bound.candidate.runId !== reference.logicalRunId) throw new FactoryValidatorDispatchError("factory_validator_dispatch_unbound");
    return { reference, attempt: factoryAttemptAuthority(delivery.reference), reservationId: delivery.reference.reservationId };
  }

  private async readTerminal(transaction: MigrationDb, attempt: FactoryAttemptAuthority): Promise<FactoryExecutionTerminalFact | undefined> {
    try { return (await this.journal.readCompletedTerminalInTransaction(transaction, attempt, this.artifacts)).terminal; }
    catch { return undefined; }
  }

  private acknowledgement(reference: TrustedFactoryCommandReference, attempt: FactoryAttemptAuthority, terminal: FactoryExecutionTerminalFact): Extract<KernelEvent, { kind: "node-result" }> {
    return Object.freeze({
      kind: "node-result" as const,
      id: `factory-validator-result:${terminal.terminalFactDigest.slice("sha256:".length)}`,
      atMs: attempt.deadlineAt.getTime(),
      nodeId: attempt.nodeInstanceId,
      commandId: reference.commandId,
      candidateGeneration: attempt.candidateGeneration,
      attempt: attempt.attemptNumber,
      output: { report: terminal.outputArtifactId },
    });
  }

  private outcome(reference: TrustedFactoryCommandReference, attempt: FactoryAttemptAuthority, reservationId: string, result: NonSuccessfulRunnerResult): FactoryTaskOutcomeReceipt {
    return {
      reservationId,
      resultStatus: result.status,
      terminalResultDigest: `sha256:${(result.status === "failed" ? result.resultDigest : result.status === "uncertain" ? result.providerReceiptDigest : attempt.requestDigest).padEnd(64, "0").slice(0, 64)}`,
      evidenceDigest: `sha256:${attempt.requestDigest}`,
      usageDisposition: result.status === "uncertain" ? "unknown_held" : "measured_pending_stop",
      event: Object.freeze({
        kind: "node-failed" as const,
        id: `factory-validator-failed:${attempt.requestDigest}`,
        atMs: attempt.deadlineAt.getTime(),
        nodeId: attempt.nodeInstanceId,
        commandId: reference.commandId,
        candidateGeneration: attempt.candidateGeneration,
        attempt: attempt.attemptNumber,
        error: `factory_validator_${result.status}`,
      }),
    };
  }
}
