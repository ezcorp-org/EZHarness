import type { FactoryRunnerRequest, FactoryRunnerRequestIdentity } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest, factoryRunnerRequestIdentity } from "@ezcorp/factory-sdk/compiler";
import { validateFactoryRunnerRequest } from "@ezcorp/factory-sdk/validation";
import { sql } from "drizzle-orm";
import type { MigrationDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import {
  assertFactoryAdmissionOrigin,
  factoryValidatorAttemptId,
  factoryValidatorNodeInstanceId,
  factoryAdmissionOriginDigest,
  factoryReservationIdForOrigin,
  FACTORY_ADMISSION_ORIGIN_SCHEMA_VERSION,
  type FactoryProtectedValidatorOrigin,
} from "./admission-origin";
import type { FactoryAttemptDelivery, FactoryAttemptQueue } from "./attempt-queue";
import type { FactoryComputeAdmissions } from "./compute-admissions";
import type { FactoryExecutionJournal } from "./executions";
import type { FactoryBudgetAmount, FactoryBudgets } from "./budgets";
import type { FactoryAuthorizedAcceptanceCommand, FactoryCommandAuthority } from "./command-authority";
import { normalizePoolResourceVector, type PoolResourceVector } from "./pool/ledger";
import { resolveFactoryProtectedTaskSource } from "./protected-command-provenance";
import { assertFactoryIdentity, encodeFactoryPayload } from "./records";
import { factoryExecutionFence } from "./run-lifecycle";
import type { FactoryComputeAdmissionRequest } from "./task-admission";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import type { FactoryTrustedValidators, FactoryValidatorRuntimePlan } from "./validator-materials";

/** What one admitted runtime will run: a shared execution profile and its exact claim set. */
export interface FactoryProtectedValidatorSchedule {
  readonly origin: FactoryProtectedValidatorOrigin;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly nodeInstanceId: string;
  readonly runtime: FactoryValidatorRuntimePlan;
}

export interface FactoryValidatorResourceProfile {
  readonly envelopeId: string;
  readonly amount: FactoryBudgetAmount;
  readonly resources: PoolResourceVector;
  readonly memoryBytes: number;
}

/** A production policy must check package trust, live grants, and the pool resource class. */
export interface FactoryValidatorResourcePolicy {
  resolveInTransaction(transaction: MigrationDb, input: { readonly reference: TrustedFactoryCommandReference; readonly schedule: FactoryProtectedValidatorSchedule }): Promise<FactoryValidatorResourceProfile>;
}

export class FactoryProtectedValidatorSchedulerError extends Error {
  constructor(readonly code: "factory_validator_schedule_invalid" | "factory_validator_schedule_scope" | "factory_validator_schedule_stale" | "factory_validator_schedule_conflict") {
    super(code);
    this.name = "FactoryProtectedValidatorSchedulerError";
  }
}

const snapshot = <Value>(value: Value): Value => JSON.parse(encodeFactoryPayload(value)) as Value;

function sorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/**
 * Schedules the protected validators a candidate still needs.
 *
 * The acceptance command is the authority for *needing* a validator; it is never the authority for
 * running one. This class therefore never forges a transition command and never reuses the
 * acceptance command id as an attempt id: both the reservation and the attempt are derived from the
 * typed origin, so a repeated schedule, a lost admission response, and a restart all converge on the
 * same reservation and the same attempt.
 */
export class FactoryProtectedValidatorScheduler {
  constructor(
    readonly tenantId: string,
    private readonly authority: FactoryCommandAuthority,
    private readonly validators: FactoryTrustedValidators,
    private readonly budgets: FactoryBudgets,
    private readonly admissions: FactoryComputeAdmissions,
    private readonly journal: FactoryExecutionJournal,
    private readonly attemptQueue: FactoryAttemptQueue,
    private readonly policy: FactoryValidatorResourcePolicy,
    private readonly now: () => number = Date.now,
  ) {
    assertFactoryIdentity(tenantId);
    if (authority.tenantId !== tenantId || validators.tenantId !== tenantId || admissions.tenantId !== tenantId || attemptQueue.tenantId !== tenantId) throw new FactoryProtectedValidatorSchedulerError("factory_validator_schedule_scope");
  }

  /**
   * Groups every missing claim of the current candidate by the execution profile it shares.
   *
   * One schedule is one admitted runtime. Claims that pin different runners, models, or
   * configurations land in different schedules, so a single admission can never cover two profiles.
   */
  async planInTransaction(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference): Promise<readonly FactoryProtectedValidatorSchedule[]> {
    const reference = snapshot(value);
    return this.authority.withCurrentAcceptanceInTransaction(transaction, service, reference, async (tx, context) => {
      const candidateKey = this.candidateKey(reference, context);
      const plan = await this.validators.planMissingInTransaction(tx, this.tenantId, candidateKey);
      const groups = new Map<string, FactoryValidatorRuntimePlan[]>();
      for (const entry of plan.missing) groups.set(entry.executionProfileDigest, [...(groups.get(entry.executionProfileDigest) ?? []), entry]);
      return [...groups.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([executionProfileDigest, entries]) => {
          const origin: FactoryProtectedValidatorOrigin = assertFactoryAdmissionOrigin({
            schemaVersion: FACTORY_ADMISSION_ORIGIN_SCHEMA_VERSION,
            kind: "protected-validator",
            acceptanceCommandId: context.command.id,
            candidate: candidateKey,
            validatorIds: sorted(entries.map(entry => entry.validatorId)),
            validatorLockDigest: plan.candidate.validatorLockDigest,
            executionProfileDigest,
          }) as FactoryProtectedValidatorOrigin;
          return Object.freeze({
            origin,
            reservationId: factoryReservationIdForOrigin(reference, origin),
            attemptId: factoryValidatorAttemptId(origin),
            nodeInstanceId: factoryValidatorNodeInstanceId(origin),
            runtime: entries[0] as FactoryValidatorRuntimePlan,
          });
        });
    });
  }

  /**
   * Holds budget and enlists exactly one durable compute admission per validator identity.
   *
   * The origin is sealed onto both rows, and the partial unique index on
   * `factory_compute_admissions` makes a second admission for the same identity impossible, so a
   * repeated call, a lost pool response, and a concurrent poll all resolve to one reservation.
   */
  async reserveInTransaction(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, schedule: FactoryProtectedValidatorSchedule): Promise<{ readonly created: boolean }> {
    const reference = snapshot(value);
    return this.authority.withCurrentAcceptanceInTransaction(transaction, service, reference, async (tx, context) => {
      this.assertSchedule(reference, context, schedule);
      const profile = snapshot(await this.policy.resolveInTransaction(tx, { reference, schedule }));
      assertFactoryIdentity(profile.envelopeId);
      if (!Number.isSafeInteger(profile.memoryBytes) || profile.memoryBytes < 1) throw new FactoryProtectedValidatorSchedulerError("factory_validator_schedule_invalid");
      const originDigest = factoryAdmissionOriginDigest(schedule.origin);
      const request: FactoryComputeAdmissionRequest = {
        schemaVersion: "factory.compute-admission.v1",
        reference,
        fence: factoryExecutionFence(context.fence),
        budget: profile.amount,
        memoryBytes: profile.memoryBytes,
        request: { reservationId: schedule.reservationId, grantRevision: context.fence.grantRevision, grantScope: `${this.tenantId}:factory`, resources: normalizePoolResourceVector(profile.resources), admissionDeadline: new Date(context.command.deadlineAtMs).toISOString() },
        origin: schedule.origin,
      };
      let created = false;
      const enlist = async (inner: MigrationDb) => {
        created = (await this.admissions.enlistInTransaction(inner, request)).created;
        await this.sealOrigin(inner, reference, schedule, originDigest);
      };
      const held = await this.budgets.reserveInTransaction(tx, { projectId: reference.projectId, runId: reference.logicalRunId, envelopeId: profile.envelopeId, reservationId: schedule.reservationId, amount: profile.amount, computeRequest: request }, inner => enlist(inner));
      // An exact retry returns the existing hold; it never creates a second one.
      if (!held.created) await enlist(tx);
      return { created: held.created && created };
    });
  }

  /**
   * The candidate this acceptance command is about.
   *
   * It is the task node the command references, not the acceptance node itself, and it is resolved
   * through the same provenance rule the acceptance path uses, so a scheduler cannot address a
   * candidate the command does not actually name.
   */
  private candidateKey(reference: TrustedFactoryCommandReference, context: FactoryAuthorizedAcceptanceCommand) {
    const source = resolveFactoryProtectedTaskSource(context.compiled, context.commandState, context.command.nodeId, context.node.candidate, context.command.candidate);
    return { projectId: reference.projectId, runId: reference.logicalRunId, nodeInstanceId: source.nodeInstanceId, candidateGeneration: source.candidateGeneration };
  }

  /** A schedule may only be acted on under the exact acceptance command that produced it. */
  private assertSchedule(reference: TrustedFactoryCommandReference, context: FactoryAuthorizedAcceptanceCommand, schedule: FactoryProtectedValidatorSchedule): void {
    const origin = assertFactoryAdmissionOrigin(schedule.origin);
    if (origin.kind !== "protected-validator" || origin.acceptanceCommandId !== context.command.id) throw new FactoryProtectedValidatorSchedulerError("factory_validator_schedule_stale");
    const candidate = this.candidateKey(reference, context);
    if (encodeFactoryPayload(origin.candidate) !== encodeFactoryPayload(candidate)) throw new FactoryProtectedValidatorSchedulerError("factory_validator_schedule_stale");
    if (schedule.reservationId !== factoryReservationIdForOrigin(reference, origin) || schedule.attemptId !== factoryValidatorAttemptId(origin) || schedule.nodeInstanceId !== factoryValidatorNodeInstanceId(origin)) throw new FactoryProtectedValidatorSchedulerError("factory_validator_schedule_invalid");
    if (!origin.validatorIds.includes(schedule.runtime.validatorId) || schedule.runtime.executionProfileDigest !== origin.executionProfileDigest) throw new FactoryProtectedValidatorSchedulerError("factory_validator_schedule_invalid");
  }

  /**
   * Stamps the origin kind onto the budget reservation.
   *
   * `FactoryComputeAdmissions` seals the admission's own origin columns from the request it stores
   * and refuses a row whose columns disagree with it, so the admission side needs nothing here. The
   * reservation row has no such writer, and the update is keyed on the `dispatch-node` default so a
   * row already stamped for another identity is never re-stamped.
   */
  private async sealOrigin(transaction: MigrationDb, reference: TrustedFactoryCommandReference, schedule: FactoryProtectedValidatorSchedule, originDigest: string): Promise<void> {
    await transaction.execute(sql`UPDATE factory_budget_reservations SET origin_kind='protected-validator'
      WHERE tenant_id=${this.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND reservation_id=${schedule.reservationId} AND origin_kind='dispatch-node'`);
    const sealed = rows<{ origin_kind: string; origin_json: string; origin_digest: string }>(await transaction.execute(sql`SELECT origin_kind,origin_json,origin_digest FROM factory_compute_admissions WHERE tenant_id=${this.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND reservation_id=${schedule.reservationId} FOR UPDATE`))[0];
    if (sealed?.origin_kind !== "protected-validator" || sealed.origin_json !== encodeFactoryPayload(schedule.origin) || sealed.origin_digest !== originDigest) throw new FactoryProtectedValidatorSchedulerError("factory_validator_schedule_conflict");
  }

  /**
   * Mints the durable attempt for an admitted schedule and binds it to its claims.
   *
   * The attempt id is derived from the origin, never from the acceptance command, and the request
   * carries the candidate artifact read-only as its only input: no grants, no tools, no workspace.
   * Binding runs through the trusted gateway, so the assignment is checked against the pinned runner
   * before a queue row exists. A repeat returns the stored delivery rather than a second attempt.
   */
  async admitInTransaction(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, schedule: FactoryProtectedValidatorSchedule): Promise<FactoryAttemptDelivery> {
    const reference = snapshot(value);
    return this.authority.withCurrentAcceptanceInTransaction(transaction, service, reference, async (tx, context) => {
      this.assertSchedule(reference, context, schedule);
      const compute = await this.admissions.readAdmittedInTransaction(tx, { projectId: reference.projectId, runId: reference.logicalRunId, reservationId: schedule.reservationId });
      if (compute.request.request.reservationId !== schedule.reservationId || encodeFactoryPayload(compute.request.origin) !== encodeFactoryPayload(schedule.origin)) throw new FactoryProtectedValidatorSchedulerError("factory_validator_schedule_stale");
      const plan = await this.validators.planMissingInTransaction(tx, this.tenantId, schedule.origin.candidate);
      const lease = compute.receipt.lease;
      const deadlineAtMs = lease.deadlineAt.getTime();
      if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= this.now() || deadlineAtMs > context.command.deadlineAtMs) throw new FactoryProtectedValidatorSchedulerError("factory_validator_schedule_stale");
      const input: FactoryRunnerRequest = {
        schemaVersion: "factory.runner.request.v1",
        authority: {
          attemptId: schedule.attemptId, tenantId: this.tenantId, projectId: reference.projectId, runId: reference.logicalRunId,
          nodeInstanceId: schedule.nodeInstanceId, candidateGeneration: schedule.origin.candidate.candidateGeneration, attemptNumber: 1,
          grantRevision: context.fence.grantRevision, reservationGeneration: lease.allocationGeneration,
          executionEpoch: context.fence.executionEpoch, cancellationEpoch: context.fence.cancellationEpoch,
          deadlineAtMs, nextOperationIndex: 0,
        },
        runner: schedule.runtime.runner,
        input: { kind: "artifact", artifact: plan.candidate.artifact },
        grants: [],
        resources: schedule.runtime.resources,
        ...(schedule.runtime.model ? { model: schedule.runtime.model } : {}),
        tools: [],
        broker: { audience: schedule.runtime.brokerAudience, attemptToken: "durable-validator-admission" },
      };
      if (!validateFactoryRunnerRequest(input).ok) throw new FactoryProtectedValidatorSchedulerError("factory_validator_schedule_invalid");
      const request: FactoryRunnerRequestIdentity = factoryRunnerRequestIdentity(input);
      const requestDigest = factoryRunnerRequestDigest(input);
      const admission = {
        attemptId: schedule.attemptId, tenantId: this.tenantId, projectId: reference.projectId, runId: reference.logicalRunId,
        nodeInstanceId: schedule.nodeInstanceId, candidateGeneration: schedule.origin.candidate.candidateGeneration, attemptNumber: 1,
        grantRevision: context.fence.grantRevision, reservationGeneration: lease.allocationGeneration,
        executionEpoch: context.fence.executionEpoch, cancellationEpoch: context.fence.cancellationEpoch,
        requestDigest, deadlineAt: new Date(deadlineAtMs), request,
      };
      const stored = await this.attemptQueue.readStoredInTransaction(tx, reference.projectId, schedule.attemptId);
      if (stored) {
        if (stored.delivery.reference.reservationId !== schedule.reservationId || stored.delivery.reference.requestDigest !== requestDigest) throw new FactoryProtectedValidatorSchedulerError("factory_validator_schedule_conflict");
        return stored.delivery;
      }
      await this.journal.admitDurableInTransaction(tx, admission);
      for (const validatorId of schedule.origin.validatorIds) {
        await this.validators.bindAttemptInTransaction(tx, { candidate: schedule.origin.candidate, validatorId, authority: admission });
      }
      // The queue's command reference is the attempt itself: no transition command exists for it.
      return this.attemptQueue.enqueueDurableInTransaction(tx, admission, { tenantId: this.tenantId, projectId: reference.projectId, logicalRunId: reference.logicalRunId, interpreterId: reference.interpreterId, commandId: schedule.attemptId }, schedule.reservationId);
    });
  }
}
