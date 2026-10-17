import type { BudgetBounds } from "@ezcorp/factory-sdk";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import type { FactoryAdmissionOrigin } from "./admission-origin";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryBudgetAmount, FactoryBudgets } from "./budgets";
import { FactoryCommandAuthorityError, type FactoryAuthorizedCommand, type FactoryCommandAuthority } from "./command-authority";
import type { FactoryComputeAdmissions } from "./compute-admissions";
import { FactoryCommandOutbox, type FactoryCommandDelivery } from "./outbox";
import { normalizePoolResourceVector, type PoolResourceVector } from "./pool/ledger";
import type { PoolAdmissionRequest } from "./pool/service";
import { encodeFactoryPayload } from "./records";
import { factoryExecutionFence, type FactoryExecutionFence } from "./run-lifecycle";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

export interface FactoryTaskResourceProfile {
  readonly resources: PoolResourceVector;
  readonly memoryBytes: number;
  readonly budget: FactoryBudgetAmount;
}

/**
 * What one task attempt holds from the run's budget: the node's declared bounds, each capped at the
 * allocation's. A bound the node does not declare defaults to the allocation's whole bound.
 */
export function factoryTaskReservationAmount(limits: BudgetBounds | undefined, budget: FactoryBudgetAmount): FactoryBudgetAmount {
  const requestedCost = BigInt(limits?.maxCostMicros ?? budget.costMicros);
  const costCeiling = BigInt(budget.costMicros);
  return {
    costMicros: String(requestedCost < costCeiling ? requestedCost : costCeiling),
    tokens: Math.min(limits?.maxTokens ?? budget.tokens, budget.tokens),
    computeMs: Math.min(limits?.maxComputeMs ?? budget.computeMs, budget.computeMs),
  };
}

/** The pool receives only request; the remaining product facts stay in the tenant database. */
export interface FactoryComputeAdmissionRequest {
  readonly schemaVersion: "factory.compute-admission.v1";
  readonly reference: TrustedFactoryCommandReference;
  readonly fence: FactoryExecutionFence;
  readonly budget: FactoryBudgetAmount;
  readonly memoryBytes: number;
  readonly request: PoolAdmissionRequest;
  /** Absent means `dispatch-node`. A protected validator names its claims instead. */
  readonly origin?: FactoryAdmissionOrigin;
}

export interface FactoryTaskAdmissionReceipt {
  readonly reservationId: string;
  readonly outboxCommandId: string;
}

/**
 * Admission and dispatch identify the same task attempt without using mutable caller input. It reads only the
 * command's node and generation and the node's last attempt, so a cancel-node for that attempt names it too (W09h).
 */
export function factoryTaskReservationId(reference: TrustedFactoryCommandReference, context: Pick<FactoryAuthorizedCommand, "state"> & { readonly command: { readonly nodeId: string; readonly candidateGeneration: number } }): string {
  const attempt = context.state.nodes[context.command.nodeId]!.attempts.at(-1)!;
  return `factory-reservation:${digestObject({ tenantId: reference.tenantId, projectId: reference.projectId, logicalRunId: reference.logicalRunId, interpreterId: reference.interpreterId, nodeId: context.command.nodeId, candidateGeneration: context.command.candidateGeneration, attempt: attempt.attempt }).slice(7)}`;
}

/** First step of C03: hold product budget and enqueue an immutable compute request together. */
export class FactoryTaskAdmission {
  private readonly profiles: Readonly<Record<string, FactoryTaskResourceProfile>>;

  constructor(private readonly database: TransactionalDb, private readonly authority: FactoryCommandAuthority, private readonly budgets: FactoryBudgets, profiles: Readonly<Record<string, FactoryTaskResourceProfile>>, private readonly admissions: Pick<FactoryComputeAdmissions, "enlistInTransaction">, private readonly now: () => number = Date.now) {
    const snapshot = JSON.parse(encodeFactoryPayload(profiles)) as Record<string, FactoryTaskResourceProfile>;
    this.profiles = Object.fromEntries(Object.entries(snapshot).map(([name, profile]) => [name, { ...profile, resources: normalizePoolResourceVector(profile.resources) }]));
  }

  async request(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference): Promise<FactoryTaskAdmissionReceipt> {
    const reference = JSON.parse(encodeFactoryPayload(value)) as TrustedFactoryCommandReference;
    return this.authority.withCurrent(service, reference, async (transaction, context) => {
      if (context.command.kind !== "request-admission") throw new FactoryCommandAuthorityError("factory_command_forbidden");
      const resourceClass = context.node.resources?.resourceClass ?? "cpu";
      const profile = Object.hasOwn(this.profiles, resourceClass) ? this.profiles[resourceClass] : undefined;
      if (!profile || !Number.isSafeInteger(profile.memoryBytes) || profile.memoryBytes < 1 || (context.node.resources?.memoryBytes ?? 0) > profile.memoryBytes) throw new FactoryCommandAuthorityError("factory_command_forbidden");
      const amount = factoryTaskReservationAmount(context.node.resources, profile.budget);
      const reservationId = factoryTaskReservationId(reference, context);
      const computeRequest: FactoryComputeAdmissionRequest = {
        schemaVersion: "factory.compute-admission.v1", reference, fence: factoryExecutionFence(context.fence), budget: amount, memoryBytes: profile.memoryBytes,
        request: { reservationId, grantRevision: context.fence.grantRevision, grantScope: `${context.fence.tenantId}:factory`, resources: profile.resources, admissionDeadline: new Date(context.command.deadlineAtMs).toISOString() },
      };
      const outbox = new FactoryCommandOutbox(this.database, this.authority.tenantId, reference.projectId, this.now, "pool");
      const command = { kind: "compute_admission" as const, projectId: reference.projectId, logicalRunId: reference.logicalRunId, reservationId, body: computeRequest };
      let created: FactoryCommandDelivery | undefined;
      const enqueue = async (tx: MigrationDb) => {
        await this.admissions.enlistInTransaction(tx, computeRequest);
        return outbox.enqueueInTransaction(tx, command);
      };
      await this.budgets.reserveInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, envelopeId: "root", reservationId, amount, computeRequest }, async tx => { created = await enqueue(tx); });
      // Exact retries return the existing delivery; they never create a second budget hold.
      const delivery = created ?? await enqueue(transaction);
      return { reservationId, outboxCommandId: delivery.command.commandId };
    });
  }
}
