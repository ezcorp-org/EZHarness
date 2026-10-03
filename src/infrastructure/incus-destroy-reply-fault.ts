import { and, eq, or } from "drizzle-orm";
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
  /** Must verify the matching durable run checkpoint and nonce on each call. */
  authorizeRun: (arm: Readonly<LostDestroyReplyArm>) => Promise<void>;
  /** Must verify a live operator readback capability for this exact run. */
  authorizeReadback: (arm: Readonly<LostDestroyReplyArm>) => Promise<void>;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const RESERVED_OPERATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function requireScope(condition: unknown): asserts condition {
  if (!condition) throw new Error("Incus destroy reply fault scope is unavailable");
}

function requireArmInput(input: Readonly<LostDestroyReplyArm>, now: number): void {
  requireScope(IDENTIFIER.test(input.runId) && IDENTIFIER.test(input.nonce)
    && IDENTIFIER.test(input.fixtureOperationId) && IDENTIFIER.test(input.bindingId)
    && RESERVED_OPERATION_ID.test(input.destroyOperationId)
    && Number.isSafeInteger(input.generation) && input.generation > 0
    && Number.isSafeInteger(input.providerGeneration) && input.providerGeneration > 0
    && Number.isSafeInteger(input.connectionRevision) && input.connectionRevision > 0
    && Number.isSafeInteger(input.deadlineMs) && input.deadlineMs > now
    && input.deadlineMs - now <= 30_000);
}

function requireFixture(fixture: typeof incusQualificationFixtures.$inferSelect | undefined,
  input: Readonly<LostDestroyReplyArm>): asserts fixture is typeof incusQualificationFixtures.$inferSelect {
  requireScope(fixture && fixture.bindingId === input.bindingId
    && fixture.installationId === input.scope.installationId
    && fixture.releaseId === input.scope.releaseId
    && fixture.connectionId === input.scope.connectionId
    && fixture.presetId === input.scope.presetId
    && fixture.connectionRevision === input.connectionRevision);
}

function requireStoppedBinding(binding: typeof sandboxBindings.$inferSelect | undefined,
  fixture: typeof incusQualificationFixtures.$inferSelect, input: Readonly<LostDestroyReplyArm>): void {
  requireScope(binding && binding.projectId === fixture.projectId && binding.id === fixture.bindingId
    && binding.resourceKey === fixture.bindingId
    && binding.providerInstallationId === fixture.installationId
    && binding.providerReleaseId === fixture.releaseId
    && binding.connectionId === fixture.connectionId
    && binding.connectionRevision === input.connectionRevision
    && binding.generation === input.generation
    && binding.desiredState === "STOPPED" && binding.observedState === "STOPPED"
    && binding.tombstonedAt === null);
}

function requireAvailableResources(connection: typeof providerConnections.$inferSelect | undefined,
  reservation: typeof sandboxReservations.$inferSelect | undefined,
  fixture: typeof incusQualificationFixtures.$inferSelect, input: Readonly<LostDestroyReplyArm>): void {
  requireScope(connection && connection.providerInstallationId === fixture.installationId
    && connection.providerReleaseId === fixture.releaseId
    && connection.revision === input.connectionRevision && connection.revokedAt === null
    && reservation && reservation.projectId === fixture.projectId
    && reservation.connectionId === fixture.connectionId
    && reservation.generation === input.generation
    && reservation.cleanupIntentId === null
    && reservation.diskState === "RESERVED");
}

/** Host-only, single-use fault. No model or public request can arm it. */
export class HostIncusLostDestroyReplyFault implements PostEffectDestroyReplyFault {
  private armed: LostDestroyReplyArm | null = null;
  private wasArmed = false;
  private arming = false;

  constructor(private readonly db: Database, private readonly authority: Authority,
    private readonly now: () => number = Date.now) {}

  /** Complete all fallible authority checks before cleanup intent or journal exists. */
  async arm(input: Readonly<LostDestroyReplyArm>): Promise<void> {
    await this.authority.authenticateOperator();
    requireScope(!this.wasArmed && !this.armed && !this.arming);
    this.arming = true;
    try {
    requireArmInput(input, this.now());
    const [fixture] = await this.db.select().from(incusQualificationFixtures)
      .where(eq(incusQualificationFixtures.operationId, input.fixtureOperationId)).limit(1);
    requireFixture(fixture, input);
    const [[project], [binding], [connection], [operation], [reservation]] = await Promise.all([
      this.db.select().from(projects).where(eq(projects.id, fixture.projectId)).limit(1),
      this.db.select().from(sandboxBindings).where(eq(sandboxBindings.id, fixture.bindingId)).limit(1),
      this.db.select().from(providerConnections).where(eq(providerConnections.id, fixture.connectionId)).limit(1),
      this.db.select().from(sandboxOperations).where(or(eq(sandboxOperations.id, input.destroyOperationId),
        and(eq(sandboxOperations.bindingId, fixture.bindingId),
          eq(sandboxOperations.idempotencyScope, "incus-qualification"),
          eq(sandboxOperations.idempotencyKey, `${input.fixtureOperationId}:destroy`)))).limit(1),
      this.db.select().from(sandboxReservations).where(eq(sandboxReservations.bindingId, fixture.bindingId)).limit(1),
    ]);
    requireScope(project?.purpose === "incus-qualification" && !operation);
    requireStoppedBinding(binding, fixture, input);
    requireAvailableResources(connection, reservation, fixture, input);
    await this.authority.authorizeRun(input);
    requireScope(!this.wasArmed && !this.armed && input.deadlineMs > this.now());
    this.armed = { ...input, scope: { ...input.scope } };
    this.wasArmed = true;
    } finally { this.arming = false; }
  }

  /** Recheck the exact arm after cleanup intent, before a dispatchable journal is published. */
  async assertArmedFor(input: Readonly<LostDestroyReplyArm>): Promise<void> {
    const armed = this.armed;
    requireScope(armed && armed.runId === input.runId && armed.nonce === input.nonce
      && armed.deadlineMs === input.deadlineMs && armed.fixtureOperationId === input.fixtureOperationId
      && armed.bindingId === input.bindingId && armed.destroyOperationId === input.destroyOperationId
      && armed.generation === input.generation && armed.providerGeneration === input.providerGeneration
      && armed.connectionRevision === input.connectionRevision
      && armed.scope.installationId === input.scope.installationId
      && armed.scope.releaseId === input.scope.releaseId
      && armed.scope.connectionId === input.scope.connectionId
      && armed.scope.presetId === input.scope.presetId
      && this.now() < armed.deadlineMs);
    await this.authority.authorizeRun(input);
    requireScope(this.armed === armed && this.now() < armed.deadlineMs);
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

  async readback(input: Readonly<LostDestroyReplyArm>) {
    await this.authority.authenticateOperator();
    await this.authority.authorizeReadback(input);
    requireScope(input.deadlineMs > this.now());
    return readIncusLostDestroyReplyState(this.db, input);
  }
}

/** Called only through the fault object after operator authorization. */
async function readIncusLostDestroyReplyState(db: Database, input: Pick<LostDestroyReplyArm,
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
