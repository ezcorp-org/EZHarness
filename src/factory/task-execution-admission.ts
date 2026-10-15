import type { FactoryCheckpointReference, FactoryModelPin, FactoryRunnerRequest, FactoryRunnerRequestIdentity, FactoryToolDeclaration, JsonValue, ResourceBounds } from "@ezcorp/factory-sdk";
import { validateFactoryRunnerRequest } from "@ezcorp/factory-sdk/validation";
import { factoryRunnerRequestDigest, factoryRunnerRequestIdentity } from "@ezcorp/factory-sdk/compiler";
import { sql } from "drizzle-orm";
import type { MigrationDb } from "../db/migrations/types";
import type { FactoryAttemptDelivery, FactoryAttemptQueue } from "./attempt-queue";
import type { FactoryAuthorizedCommand, FactoryCommandAuthority } from "./command-authority";
import { FactoryComputeAdmissionError, type FactoryComputeAdmissionMaterial, type FactoryComputeAdmissions } from "./compute-admissions";
import type { FactoryDispatchRefusedStopRecorder } from "./dispatch-refused-stops";
import type { FactoryDurableAttemptAdmission, FactoryExecutionJournal } from "./executions";
import type { FactoryPrincipal } from "./grants";
import { factoryErrorCode } from "./plain-values";
import { encodeFactoryPayload } from "./records";
import { factoryTaskReservationId } from "./task-admission";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

export interface FactoryTaskRunnerResolution {
  readonly grants: readonly string[];
  readonly resources: ResourceBounds;
  readonly model?: FactoryModelPin;
  readonly tools: readonly FactoryToolDeclaration[];
  readonly brokerAudience: string;
  readonly checkpoint?: FactoryCheckpointReference;
}

export interface FactoryTaskRunnerPolicyInput {
  readonly reference: TrustedFactoryCommandReference;
  readonly command: Extract<FactoryAuthorizedCommand["command"], { kind: "dispatch-node" }>;
  readonly context: FactoryAuthorizedCommand;
  readonly initiator: FactoryPrincipal;
  readonly compute: FactoryComputeAdmissionMaterial;
}

/** A production resolver must verify package trust, live grants, model policy, and tool policy. */
export interface FactoryTaskRunnerPolicy {
  resolveInTransaction(transaction: MigrationDb, input: FactoryTaskRunnerPolicyInput): Promise<FactoryTaskRunnerResolution>;
}

/**
 * One dispatch's answer: admitted, or refused by name together with whether an attempt is queued
 * for the command, both read in the refusal's own transaction under the run lock.
 */
export type FactoryTaskDispatchDecision =
  | { readonly admitted: FactoryTaskExecutionAdmissionReceipt }
  | { readonly refused: string; readonly queued: boolean };

export interface FactoryTaskExecutionAdmissionReceipt {
  readonly reservationId: string;
  readonly delivery: FactoryAttemptDelivery;
  readonly request: FactoryRunnerRequestIdentity;
}

export class FactoryTaskExecutionAdmissionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "FactoryTaskExecutionAdmissionError"; }
}

function snapshot<T>(value: T): T {
  return JSON.parse(encodeFactoryPayload(value)) as T;
}

function exactCapabilities(expected: readonly string[], actual: readonly string[]): boolean {
  return new Set(expected).size === expected.length && new Set(actual).size === actual.length && encodeFactoryPayload([...expected].sort()) === encodeFactoryPayload([...actual].sort());
}

function authorityInput(context: FactoryAuthorizedCommand, request: FactoryRunnerRequestIdentity, requestDigest: string): FactoryDurableAttemptAdmission {
  if (context.command.kind !== "dispatch-node") throw new FactoryTaskExecutionAdmissionError("factory_task_execution_forbidden");
  return {
    attemptId: context.command.id,
    tenantId: context.fence.tenantId,
    projectId: context.fence.projectId,
    runId: context.fence.runId,
    nodeInstanceId: context.command.nodeId,
    candidateGeneration: context.command.candidateGeneration,
    attemptNumber: context.command.attempt,
    grantRevision: context.fence.grantRevision,
    reservationGeneration: request.authority.reservationGeneration,
    executionEpoch: context.fence.executionEpoch,
    cancellationEpoch: context.fence.cancellationEpoch,
    requestDigest,
    deadlineAt: new Date(request.authority.deadlineAtMs),
    request,
  };
}

function durableRequest(context: FactoryAuthorizedCommand, compute: FactoryComputeAdmissionMaterial, resolution: FactoryTaskRunnerResolution, nextOperationIndex: number, now: number): { readonly request: FactoryRunnerRequestIdentity; readonly digest: string } {
  if (context.command.kind !== "dispatch-node") throw new FactoryTaskExecutionAdmissionError("factory_task_execution_forbidden");
  const lease = compute.receipt.lease;
  // The attempt's deadline is the node command's, not the first pool lease's.
  // The lease is liveness: the runtime renews it while the guest lives, so a
  // guest slower than one lease period is not killed for it (option 2, W01h).
  // Admission still requires a live lease that the command deadline outlasts.
  const leaseDeadlineAtMs = lease.deadlineAt.getTime();
  const deadlineAtMs = context.command.deadlineAtMs;
  if (lease.tenantId !== context.fence.tenantId || lease.grantRevision !== context.fence.grantRevision || lease.reservationId !== compute.request.request.reservationId || !Number.isSafeInteger(lease.allocationGeneration) || lease.allocationGeneration < 1 || !Number.isSafeInteger(leaseDeadlineAtMs) || leaseDeadlineAtMs <= now || leaseDeadlineAtMs > deadlineAtMs || !Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= now || !Number.isSafeInteger(nextOperationIndex) || nextOperationIndex < 0) throw new FactoryTaskExecutionAdmissionError("factory_task_execution_stale");
  const declaredGrants = context.node.capabilities ?? [];
  if (!exactCapabilities(declaredGrants, resolution.grants) || !resolution.brokerAudience || resolution.brokerAudience.length > 512) throw new FactoryTaskExecutionAdmissionError("factory_task_execution_policy_invalid");
  const input: FactoryRunnerRequest = {
    schemaVersion: "factory.runner.request.v1",
    authority: {
      attemptId: context.command.id,
      tenantId: context.fence.tenantId,
      projectId: context.fence.projectId,
      runId: context.fence.runId,
      nodeInstanceId: context.command.nodeId,
      candidateGeneration: context.command.candidateGeneration,
      attemptNumber: context.command.attempt,
      grantRevision: context.fence.grantRevision,
      reservationGeneration: lease.allocationGeneration,
      executionEpoch: context.fence.executionEpoch,
      cancellationEpoch: context.fence.cancellationEpoch,
      deadlineAtMs,
      nextOperationIndex,
    },
    runner: context.node.runner,
    input: { kind: "inline", value: context.command.input as JsonValue },
    grants: [...resolution.grants],
    resources: resolution.resources,
    ...(resolution.model === undefined ? {} : { model: resolution.model }),
    tools: [...resolution.tools],
    broker: { audience: resolution.brokerAudience, attemptToken: "durable-admission-validation" },
    ...(resolution.checkpoint === undefined ? {} : { checkpoint: resolution.checkpoint }),
  };
  if (!validateFactoryRunnerRequest(input).ok) throw new FactoryTaskExecutionAdmissionError("factory_task_execution_policy_invalid");
  const request = factoryRunnerRequestIdentity(input);
  return { request, digest: factoryRunnerRequestDigest(input) };
}

function sameRequest(left: FactoryRunnerRequestIdentity, right: FactoryRunnerRequestIdentity): boolean {
  return encodeFactoryPayload(left) === encodeFactoryPayload(right);
}

/** Atomically converts one current dispatch command into a durable journal request and queue row. */
export class FactoryTaskExecutionAdmission {
  constructor(
    private readonly authority: FactoryCommandAuthority,
    private readonly computeAdmissions: FactoryComputeAdmissions,
    private readonly journal: FactoryExecutionJournal,
    private readonly attemptQueue: FactoryAttemptQueue,
    private readonly runnerPolicy: FactoryTaskRunnerPolicy,
    private readonly now: () => number = Date.now,
    /** Records the stop that releases a refused dispatch's admitted lease (W02d R8). */
    private readonly refusedStops?: Pick<FactoryDispatchRefusedStopRecorder, "recordInTransaction">,
  ) {}

  async admit(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference): Promise<FactoryTaskExecutionAdmissionReceipt> {
    const reference = snapshot(value);
    return this.authority.withCurrent(service, reference, (transaction, context) => this.admitInTransaction(transaction, reference, context));
  }

  /**
   * Admit one dispatch, or answer its named refusal and whether an attempt is queued for it.
   *
   * The admission runs under a savepoint inside the run-locked transaction. A refusal that names
   * itself (`factory_…`) rolls back to the savepoint, which undoes every write the admission made,
   * and the queue is read in the same transaction under the same lock. So `queued: false` is
   * certain: no attempt existed when the refusal was decided, this refusal queued none, and no
   * other admission of the command can interleave. Any other error still throws and rolls back.
   */
  async dispatch(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference): Promise<FactoryTaskDispatchDecision> {
    const reference = snapshot(value);
    return this.authority.withCurrent(service, reference, async (transaction, context) => {
      await transaction.execute(sql`SAVEPOINT factory_task_dispatch`);
      try {
        const admitted = await this.admitInTransaction(transaction, reference, context);
        await transaction.execute(sql`RELEASE SAVEPOINT factory_task_dispatch`);
        return { admitted };
      } catch (error) {
        const code = factoryErrorCode(error);
        if (!code?.startsWith("factory_")) throw error;
        await transaction.execute(sql`ROLLBACK TO SAVEPOINT factory_task_dispatch`);
        const stored = await this.attemptQueue.readStoredInTransaction(transaction, reference.projectId, context.command.id);
        if (stored === null) await this.recordRefusedStopInTransaction(transaction, reference, context);
        return { refused: code, queued: stored !== null };
      }
    });
  }

  /**
   * Nothing is queued, so nothing will ever run this dispatch; but its compute may already be admitted, and only a
   * supervisor's signed word frees an admitted lease (C03). So the refusal's own transaction records the stop that
   * gets that word (W02d R8). A dispatch whose compute was never admitted holds nothing and records nothing.
   */
  private async recordRefusedStopInTransaction(transaction: MigrationDb, reference: TrustedFactoryCommandReference, context: FactoryAuthorizedCommand): Promise<void> {
    if (this.refusedStops === undefined || context.command.kind !== "dispatch-node") return;
    const reservationId = factoryTaskReservationId(reference, context);
    let admitted: Awaited<ReturnType<FactoryComputeAdmissions["readAdmittedInTransaction"]>>;
    try { admitted = await this.computeAdmissions.readAdmittedInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, reservationId }); }
    catch (error) {
      // Never admitted: nothing is held, nothing to release. Any other fault is not a refusal's to hide.
      if (error instanceof FactoryComputeAdmissionError && error.code === "factory_compute_admission_not_admitted") return;
      throw error;
    }
    // The node attempt the hold belongs to, as the reservation id names it (the kernel's last attempt of this node).
    const attempt = context.state.nodes[context.command.nodeId]!.attempts.at(-1)!;
    await this.refusedStops.recordInTransaction(transaction, reference, reservationId, admitted.receipt.lease,
      { attemptId: attempt.commandId, nodeInstanceId: context.command.nodeId, candidateGeneration: context.command.candidateGeneration, attemptNumber: attempt.attempt });
  }

  private async admitInTransaction(transaction: MigrationDb, reference: TrustedFactoryCommandReference, context: FactoryAuthorizedCommand): Promise<FactoryTaskExecutionAdmissionReceipt> {
    if (context.command.kind !== "dispatch-node") throw new FactoryTaskExecutionAdmissionError("factory_task_execution_forbidden");
    const reservationId = factoryTaskReservationId(reference, context);
    const timestamp = this.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new FactoryTaskExecutionAdmissionError("factory_task_execution_clock_invalid");
    const compute = await this.computeAdmissions.readAdmittedInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, reservationId });
    this.assertCompute(reference, context, compute);
    const resolution = snapshot(await this.runnerPolicy.resolveInTransaction(transaction, { reference, command: context.command, context, initiator: context.initiator, compute }));
    const stored = await this.attemptQueue.readStoredInTransaction(transaction, reference.projectId, context.command.id);
    if (stored) {
      if (stored.delivery.reference.reservationId !== reservationId) throw new FactoryTaskExecutionAdmissionError("factory_task_execution_conflict");
      const expected = durableRequest(context, compute, resolution, stored.request.authority.nextOperationIndex, timestamp);
      if (expected.digest !== stored.delivery.reference.requestDigest || !sameRequest(expected.request, stored.request)) throw new FactoryTaskExecutionAdmissionError("factory_task_execution_conflict");
      return Object.freeze({ reservationId, delivery: stored.delivery, request: stored.request });
    }
    const nextOperationIndex = await this.journal.nextOperationIndexInTransaction(transaction, {
      tenantId: context.fence.tenantId, projectId: reference.projectId, runId: reference.logicalRunId,
      nodeInstanceId: context.command.nodeId, candidateGeneration: context.command.candidateGeneration, executionEpoch: context.fence.executionEpoch,
    });
    const admitted = durableRequest(context, compute, resolution, nextOperationIndex, timestamp);
    const delivery = await this.attemptQueue.enqueueDurableInTransaction(transaction, authorityInput(context, admitted.request, admitted.digest), reference, reservationId);
    return Object.freeze({ reservationId, delivery, request: admitted.request });
  }

  private assertCompute(reference: TrustedFactoryCommandReference, context: FactoryAuthorizedCommand, compute: FactoryComputeAdmissionMaterial): void {
    const source = compute.request;
    const lease = compute.receipt.lease;
    if (source.reference.tenantId !== reference.tenantId || source.reference.projectId !== reference.projectId || source.reference.logicalRunId !== reference.logicalRunId || source.reference.interpreterId !== reference.interpreterId || source.fence.executionEpoch !== context.fence.executionEpoch || source.fence.cancellationEpoch !== context.fence.cancellationEpoch || source.fence.grantRevision !== context.fence.grantRevision || source.fence.deadlineAtMs !== context.fence.deadlineAtMs || source.fence.definitionDigest !== context.fence.definitionDigest || source.request.reservationId !== factoryTaskReservationId(reference, context) || lease.allocationGeneration < 1 || lease.deadlineAt.getTime() <= 0) throw new FactoryTaskExecutionAdmissionError("factory_task_execution_stale");
  }
}
