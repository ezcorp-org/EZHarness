import { and, eq } from "drizzle-orm";
import type { IncusTransportRequest } from "../../extensions/incus-sandbox/transport";
import type { Database } from "../db/connection";
import { incusQualificationFixtures, projects, providerConnections, sandboxBindings,
  sandboxOperations, sandboxReservations } from "../db/schema";
import type { PostEffectDestroyReplyFault } from "./incus-transport/lifecycle";
import type { HostConnectionScope } from "./incus-transport/transport";
import type { IncusQualificationScope } from "./incus-qualification";

export interface LostDestroyReplyArm {
  runId: string;
  nonce: string;
  deadlineMs: number;
  scope: IncusQualificationScope;
  fixtureOperationId: string;
  bindingId: string;
  destroyOperationId: string;
  generation: number;
  providerGeneration: number;
  connectionRevision: number;
}

type Authority = {
  /** Must authenticate the private operator socket's OS peer, outside this module. */
  authenticateOperator: () => Promise<void>;
  /** Must claim the matching durable run checkpoint and nonce once. */
  authorizeRun: (arm: Readonly<LostDestroyReplyArm>) => Promise<void>;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function requireScope(condition: unknown): asserts condition {
  if (!condition) throw new Error("Incus destroy reply fault scope is unavailable");
}

/** Host-only, single-use fault. No model or public request can arm it. */
export class HostIncusLostDestroyReplyFault implements PostEffectDestroyReplyFault {
  private armed: LostDestroyReplyArm | null = null;
  private wasArmed = false;
  private arming = false;

  constructor(private readonly db: Database, private readonly authority: Authority,
    private readonly now: () => number = Date.now) {}

  async arm(input: Readonly<LostDestroyReplyArm>): Promise<void> {
    await this.authority.authenticateOperator();
    requireScope(!this.wasArmed && !this.armed && !this.arming);
    this.arming = true;
    try {
    requireScope(IDENTIFIER.test(input.runId) && IDENTIFIER.test(input.nonce)
      && IDENTIFIER.test(input.fixtureOperationId) && IDENTIFIER.test(input.bindingId)
      && IDENTIFIER.test(input.destroyOperationId)
      && Number.isSafeInteger(input.generation) && input.generation > 0
      && Number.isSafeInteger(input.providerGeneration) && input.providerGeneration > 0
      && Number.isSafeInteger(input.connectionRevision) && input.connectionRevision > 0
      && Number.isSafeInteger(input.deadlineMs) && input.deadlineMs > this.now()
      && input.deadlineMs - this.now() <= 30_000);
    const [fixture] = await this.db.select().from(incusQualificationFixtures)
      .where(eq(incusQualificationFixtures.operationId, input.fixtureOperationId)).limit(1);
    requireScope(fixture && fixture.bindingId === input.bindingId
      && fixture.installationId === input.scope.installationId
      && fixture.releaseId === input.scope.releaseId
      && fixture.connectionId === input.scope.connectionId
      && fixture.presetId === input.scope.presetId
      && fixture.connectionRevision === input.connectionRevision);
    const [[project], [binding], [connection], [operation], [reservation]] = await Promise.all([
      this.db.select().from(projects).where(eq(projects.id, fixture.projectId)).limit(1),
      this.db.select().from(sandboxBindings).where(eq(sandboxBindings.id, fixture.bindingId)).limit(1),
      this.db.select().from(providerConnections).where(eq(providerConnections.id, fixture.connectionId)).limit(1),
      this.db.select().from(sandboxOperations).where(eq(sandboxOperations.id, input.destroyOperationId)).limit(1),
      this.db.select().from(sandboxReservations).where(eq(sandboxReservations.bindingId, fixture.bindingId)).limit(1),
    ]);
    requireScope(project?.purpose === "incus-qualification" && binding
      && binding.projectId === fixture.projectId && binding.id === fixture.bindingId
      && binding.resourceKey === fixture.bindingId
      && binding.providerInstallationId === fixture.installationId
      && binding.providerReleaseId === fixture.releaseId
      && binding.connectionId === fixture.connectionId
      && binding.connectionRevision === input.connectionRevision
      && binding.generation === input.generation
      && binding.currentOperationId === input.destroyOperationId
      && binding.desiredState === "ABSENT" && binding.cleanupConfirmedAt === null
      && connection && connection.providerInstallationId === fixture.installationId
      && connection.providerReleaseId === fixture.releaseId
      && connection.revision === input.connectionRevision && connection.revokedAt === null
      && operation && operation.bindingId === fixture.bindingId
      && operation.kind === "DESTROY" && operation.generation === input.generation
      && operation.idempotencyScope === "incus-qualification"
      && operation.idempotencyKey === `${input.fixtureOperationId}:destroy`
      && operation.requestPayload.expectedGeneration === input.providerGeneration
      && (operation.state === "JOURNALED" || operation.state === "DISPATCHING")
      && operation.providerOperationId === null
      && reservation && reservation.projectId === fixture.projectId
      && reservation.connectionId === fixture.connectionId
      && reservation.generation === input.generation
      && reservation.cleanupIntentId === `incus-qualification-destroy-${input.fixtureOperationId}`
      && reservation.diskState !== "RELEASED");
    await this.authority.authorizeRun(input);
    requireScope(!this.wasArmed && !this.armed && input.deadlineMs > this.now());
    this.armed = { ...input, scope: { ...input.scope } };
    this.wasArmed = true;
    } finally { this.arming = false; }
  }

  matches(command: IncusTransportRequest, scope: HostConnectionScope): boolean {
    const arm = this.armed;
    return !!arm && this.now() < arm.deadlineMs
      && command.action === "instance.destroy"
      && command.connectionId === arm.scope.connectionId
      && command.tags.sandboxId === arm.bindingId
      && command.idempotency?.requestId === arm.destroyOperationId
      && command.idempotency.key === arm.destroyOperationId
      && typeof command.payload === "object" && command.payload !== null
      && "expectedGeneration" in command.payload
      && command.payload.expectedGeneration === arm.providerGeneration
      && scope.providerInstallationId === arm.scope.installationId
      && scope.providerReleaseId === arm.scope.releaseId
      && scope.revision === arm.connectionRevision;
  }

  consume(command: IncusTransportRequest, scope: HostConnectionScope): boolean {
    if (!this.matches(command, scope)) return false;
    this.armed = null;
    return true;
  }
}

/** Operator-only durable projection for the affected qualification fixture. */
export async function readIncusLostDestroyReplyState(db: Database, input: Pick<LostDestroyReplyArm,
  "scope" | "fixtureOperationId" | "bindingId" | "destroyOperationId" | "generation" | "connectionRevision">) {
  const [fixture] = await db.select().from(incusQualificationFixtures)
    .where(eq(incusQualificationFixtures.operationId, input.fixtureOperationId)).limit(1);
  requireScope(fixture && fixture.bindingId === input.bindingId
    && fixture.installationId === input.scope.installationId
    && fixture.releaseId === input.scope.releaseId
    && fixture.connectionId === input.scope.connectionId
    && fixture.presetId === input.scope.presetId
    && fixture.connectionRevision === input.connectionRevision);
  const [[project], [binding], [operation], [reservation]] = await Promise.all([
    db.select({ purpose: projects.purpose }).from(projects).where(eq(projects.id, fixture.projectId)).limit(1),
    db.select().from(sandboxBindings).where(eq(sandboxBindings.id, fixture.bindingId)).limit(1),
    db.select().from(sandboxOperations).where(and(eq(sandboxOperations.id, input.destroyOperationId),
      eq(sandboxOperations.bindingId, fixture.bindingId))).limit(1),
    db.select().from(sandboxReservations).where(eq(sandboxReservations.bindingId, fixture.bindingId)).limit(1),
  ]);
  requireScope(project?.purpose === "incus-qualification" && binding && operation && reservation
    && binding.currentOperationId === operation.id
    && binding.generation === input.generation && operation.generation === input.generation
    && operation.kind === "DESTROY" && operation.idempotencyScope === "incus-qualification"
    && operation.idempotencyKey === `${input.fixtureOperationId}:destroy`
    && reservation.generation === input.generation
    && reservation.cleanupIntentId === `incus-qualification-destroy-${input.fixtureOperationId}`);
  return { fixtureOperationId: fixture.operationId, bindingId: binding.id,
    generation: binding.generation, connectionRevision: fixture.connectionRevision,
    cleanupIntentId: reservation.cleanupIntentId,
    destroyOperationId: operation.id, providerOperationId: operation.providerOperationId,
    operationState: operation.state, desiredState: binding.desiredState,
    observedState: binding.observedState, cleanupConfirmedAt: binding.cleanupConfirmedAt,
    reservationComputeState: reservation.computeState, reservationDiskState: reservation.diskState,
    fact: operation.state === "OUTCOME_UNKNOWN" && binding.desiredState === "ABSENT"
      && (reservation.computeState !== "RELEASED" || reservation.diskState !== "RELEASED")
      ? "RECONCILE_REQUIRED" as const : null };
}
