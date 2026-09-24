import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/connection";
import { sandboxBindings, sandboxOperations, sandboxReservations } from "../db/schema";
import { getHostIncusLostDestroyReplyFault } from "../extensions/extension-lifecycle-service";
import { IncusQualificationCheckpointStore } from "./incus-qualification-checkpoint";
import type { IncusQualificationFixtureService, IncusQualificationStore,
  IncusQualificationScope } from "./incus-qualification";
import type { LostDestroyReplyArm, HostIncusLostDestroyReplyFault } from "./incus-destroy-reply-fault";
import { IncusFeatureService } from "./incus-feature-service";
import type { LiveFixtureHandle } from "./incus-live-cases";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

type FeatureGate = Pick<IncusFeatureService, "checkReadiness" | "reconcile">;

export interface IncusLiveCleanupControllerDependencies {
  db: Database;
  fixtures: IncusQualificationFixtureService;
  qualifications: IncusQualificationStore;
  /** Existing user project chosen by the operator; never from a request. */
  readinessProjectId: string;
  checkpoints?: IncusQualificationCheckpointStore;
  fault?: () => Promise<HostIncusLostDestroyReplyFault>;
  freshFeatureGate?: () => FeatureGate;
  now?: () => number;
}

function requireCleanup(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Incus live cleanup unavailable: ${message}`);
}

/** Operator-only SP05 effects. Missing socket/authority in the shared fault object denies before dispatch. */
export class IncusLiveCleanupController {
  private readonly checkpoints: IncusQualificationCheckpointStore;
  private readonly fault: () => Promise<HostIncusLostDestroyReplyFault>;
  private readonly freshFeatureGate: () => FeatureGate;
  private readonly now: () => number;
  private pending: { scope: IncusQualificationScope; handle: LiveFixtureHandle;
    operationId: string; readinessDenied: boolean } | null = null;

  constructor(private readonly deps: IncusLiveCleanupControllerDependencies) {
    this.checkpoints = deps.checkpoints ?? new IncusQualificationCheckpointStore(deps.db);
    this.fault = deps.fault ?? getHostIncusLostDestroyReplyFault;
    this.freshFeatureGate = deps.freshFeatureGate ?? (() => new IncusFeatureService({ db: deps.db,
      loadQualification: scope => deps.qualifications.load(scope) }));
    this.now = deps.now ?? Date.now;
  }

  private runId(handle: LiveFixtureHandle): string {
    const runId = handle.operationId.startsWith("qual-recovery-")
      ? handle.operationId.slice("qual-recovery-".length) : "";
    requireCleanup(ID.test(runId) && ID.test(handle.sandboxId), "recovery fixture identity is invalid");
    return runId;
  }

  private async claimed(scope: IncusQualificationScope, handle: LiveFixtureHandle) {
    const runId = this.runId(handle);
    const row = await this.checkpoints.get(runId);
    const recoveryDeadlineMs = row?.claimedAt ? new Date(row.claimedAt).getTime() + 20 * 60_000 : Number.NaN;
    const deadlineMs = Math.min(recoveryDeadlineMs, this.now() + 25_000);
    requireCleanup(row?.state === "CLAIMED" && Number.isSafeInteger(recoveryDeadlineMs)
      && deadlineMs > this.now() && row.scope.installationId === scope.installationId
      && row.scope.releaseId === scope.releaseId && row.scope.connectionId === scope.connectionId
      && row.scope.presetId === scope.presetId,
    "claimed operator run is unavailable");
    const status = await this.deps.fixtures.status(scope, handle.operationId);
    requireCleanup(status.fixture.bindingId === handle.sandboxId && status.binding.id === handle.sandboxId
      && status.binding.desiredState === "STOPPED" && status.binding.observedState === "STOPPED",
    "exact recovery fixture is not stopped");
    const authority = { runId, nonce: row.nonce, scope,
      fixtureOperationId: handle.operationId, bindingId: handle.sandboxId,
      generation: status.binding.generation,
      connectionRevision: status.fixture.connectionRevision, deadlineMs };
    await this.checkpoints.authorizeRecoveryFixtureForRun(authority);
    return authority;
  }

  async injectLostDestroyReply(scope: IncusQualificationScope, handle: LiveFixtureHandle): Promise<void> {
    requireCleanup(!this.pending, "another recovery fault is pending");
    const authority = await this.claimed(scope, handle);
    const fault = await this.fault();
    let lost: unknown;
    try {
      await this.deps.fixtures.destroyWithLostReplyFault(scope, handle.operationId,
        { runId: authority.runId, nonce: authority.nonce, deadlineMs: authority.deadlineMs }, fault);
    } catch (error) { lost = error; }
    requireCleanup(lost, "destroy reply was not lost");
    const status = await this.deps.fixtures.status(scope, handle.operationId);
    requireCleanup(status.fixture.bindingId === handle.sandboxId && status.operation?.kind === "DESTROY"
      && status.operation.state === "OUTCOME_UNKNOWN" && status.operation.generation === authority.generation
      && status.binding.desiredState === "ABSENT", "destroy effect is not durably uncertain");
    const [operation] = await this.deps.db.select().from(sandboxOperations)
      .where(and(eq(sandboxOperations.id, status.operation.id),
        eq(sandboxOperations.bindingId, handle.sandboxId))).limit(1);
    const payload = operation?.requestPayload as Record<string, unknown> | undefined;
    const providerGeneration = payload?.expectedGeneration;
    requireCleanup(operation && Number.isSafeInteger(providerGeneration) && Number(providerGeneration) > 0,
      "destroy provider generation is unavailable");
    const arm: LostDestroyReplyArm = { ...authority, destroyOperationId: operation.id,
      providerGeneration: Number(providerGeneration) };
    const readback = await fault.readback(arm);
    requireCleanup(readback.fact === "RECONCILE_REQUIRED"
      && readback.destroyOperationId === operation.id
      && readback.bindingId === handle.sandboxId,
    "operator destroy readback did not confirm uncertainty");
    this.pending = { scope, handle, operationId: operation.id, readinessDenied: false };
    throw lost;
  }

  async attemptReadiness(scope: IncusQualificationScope, handle: LiveFixtureHandle): Promise<void> {
    const pending = this.pending;
    requireCleanup(pending && pending.handle.operationId === handle.operationId
      && pending.handle.sandboxId === handle.sandboxId
      && pending.scope.installationId === scope.installationId
      && pending.scope.releaseId === scope.releaseId
      && pending.scope.connectionId === scope.connectionId
      && pending.scope.presetId === scope.presetId,
    "operator readback is not bound to this readiness request");
    requireCleanup(ID.test(this.deps.readinessProjectId), "operator readiness project is unavailable");
    try {
      await this.freshFeatureGate().checkReadiness({ projectId: this.deps.readinessProjectId,
        installationId: scope.installationId, connectionId: scope.connectionId, presetId: scope.presetId });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error
        && error.code === "QUALIFICATION_CLEANUP_UNVERIFIED") pending.readinessDenied = true;
      throw error;
    }
  }

  async reconcileFromReopenedController(scope: IncusQualificationScope, handle: LiveFixtureHandle): Promise<void> {
    const pending = this.pending;
    requireCleanup(pending && pending.handle.operationId === handle.operationId
      && pending.handle.sandboxId === handle.sandboxId
      && pending.scope.installationId === scope.installationId
      && pending.scope.releaseId === scope.releaseId
      && pending.scope.connectionId === scope.connectionId
      && pending.scope.presetId === scope.presetId,
    "recovery journal identity changed");
    requireCleanup(pending.readinessDenied, "production readiness did not deny uncertain cleanup");
    // The bounded reconciliation pass must not dispatch an unrelated pending effect.
    const candidates = await this.deps.db.select({ id: sandboxOperations.id }).from(sandboxOperations)
      .where(inArray(sandboxOperations.state, ["JOURNALED", "DISPATCHING",
        "PROVIDER_PENDING", "OUTCOME_UNKNOWN"])).limit(2);
    requireCleanup(candidates.length === 1 && candidates[0]?.id === pending.operationId,
      "another pending operation blocks exact recovery");
    await this.freshFeatureGate().reconcile(1);
    await this.freshFeatureGate().settleCompletedOperation(pending.operationId);
    const status = await this.deps.fixtures.status(scope, handle.operationId);
    const [binding] = await this.deps.db.select().from(sandboxBindings)
      .where(eq(sandboxBindings.id, handle.sandboxId)).limit(1);
    const [reservation] = await this.deps.db.select().from(sandboxReservations)
      .where(eq(sandboxReservations.bindingId, handle.sandboxId)).limit(1);
    requireCleanup(status.operation?.id === pending.operationId && status.operation.kind === "DESTROY"
      && status.operation.state === "SUCCEEDED" && status.binding.desiredState === "ABSENT"
      && status.binding.observedState === "ABSENT" && binding?.cleanupConfirmedAt
      && reservation?.cleanupIntentId === `incus-qualification-destroy-${handle.operationId}`
      && reservation.computeState === "RELEASED" && reservation.diskState === "RELEASED",
    "original destroy journal or resource release is unverified");
    this.pending = null;
  }
}
