import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryBudgetAmount, FactoryBudgets } from "./budgets";
import { FactoryCommandAuthorityError, type FactoryAuthorizedCommand, type FactoryCommandAuthority } from "./command-authority";
import { FactoryCommandOutbox, type FactoryCommandDelivery } from "./outbox";
import { normalizePoolResourceVector, type PoolResourceVector } from "./pool/ledger";
import type { PoolAdmissionRequest } from "./pool/service";
import { encodeFactoryPayload } from "./records";
import type { FactoryRunFence } from "./run-lifecycle";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

export interface FactoryTaskResourceProfile {
  readonly resources: PoolResourceVector;
  readonly memoryBytes: number;
  readonly budget: FactoryBudgetAmount;
}

/** The pool receives only request; the remaining product facts stay in the tenant database. */
export interface FactoryComputeAdmissionRequest {
  readonly schemaVersion: "factory.compute-admission.v1";
  readonly reference: TrustedFactoryCommandReference;
  readonly fence: FactoryRunFence;
  readonly budget: FactoryBudgetAmount;
  readonly memoryBytes: number;
  readonly request: PoolAdmissionRequest;
}

export interface FactoryTaskAdmissionReceipt {
  readonly reservationId: string;
  readonly outboxCommandId: string;
}

/** Admission and dispatch identify the same task attempt without using mutable caller input. */
export function factoryTaskReservationId(reference: TrustedFactoryCommandReference, context: FactoryAuthorizedCommand): string {
  const attempt = context.state.nodes[context.command.nodeId]!.attempts.at(-1)!;
  return `factory-reservation:${digestObject({ tenantId: reference.tenantId, projectId: reference.projectId, logicalRunId: reference.logicalRunId, interpreterId: reference.interpreterId, nodeId: context.command.nodeId, candidateGeneration: context.command.candidateGeneration, attempt: attempt.attempt }).slice(7)}`;
}

/** First step of C03: hold product budget and enqueue an immutable compute request together. */
export class FactoryTaskAdmission {
  private readonly profiles: Readonly<Record<string, FactoryTaskResourceProfile>>;

  constructor(private readonly database: TransactionalDb, private readonly authority: FactoryCommandAuthority, private readonly budgets: FactoryBudgets, profiles: Readonly<Record<string, FactoryTaskResourceProfile>>, private readonly now: () => number = Date.now) {
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
      const limits = context.node.resources;
      const requestedCost = BigInt(limits?.maxCostMicros ?? profile.budget.costMicros);
      const costCeiling = BigInt(profile.budget.costMicros);
      const amount = {
        costMicros: String(requestedCost < costCeiling ? requestedCost : costCeiling),
        tokens: Math.min(limits?.maxTokens ?? profile.budget.tokens, profile.budget.tokens),
        computeMs: Math.min(limits?.maxComputeMs ?? profile.budget.computeMs, profile.budget.computeMs),
      };
      const reservationId = factoryTaskReservationId(reference, context);
      const computeRequest: FactoryComputeAdmissionRequest = {
        schemaVersion: "factory.compute-admission.v1", reference, fence: context.fence, budget: amount, memoryBytes: profile.memoryBytes,
        request: { reservationId, grantRevision: context.fence.grantRevision, grantScope: `${context.fence.tenantId}:factory`, resources: profile.resources, admissionDeadline: new Date(context.command.deadlineAtMs).toISOString() },
      };
      const outbox = new FactoryCommandOutbox(this.database, this.authority.tenantId, reference.projectId, this.now, "pool");
      const command = { kind: "compute_admission" as const, projectId: reference.projectId, logicalRunId: reference.logicalRunId, reservationId, body: computeRequest };
      let created: FactoryCommandDelivery | undefined;
      const enqueue = (tx: MigrationDb) => outbox.enqueueInTransaction(tx, command);
      await this.budgets.reserveInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId, envelopeId: "root", reservationId, amount, computeRequest }, async tx => { created = await enqueue(tx); });
      // Exact retries return the existing delivery; they never create a second budget hold.
      const delivery = created ?? await enqueue(transaction);
      return { reservationId, outboxCommandId: delivery.command.commandId };
    });
  }
}
