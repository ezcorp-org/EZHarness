import type { IncusQualificationFixtureService, IncusQualificationScope } from "./incus-qualification";
import type { LiveFixtureHandle, LiveFixtureInspection } from "./incus-live-cases";

type FixtureStatus = Awaited<ReturnType<IncusQualificationFixtureService["status"]>>;

export interface RecoveryObservation {
  /** Read by the application process that owns this controller connection. */
  processId: string;
  durable: FixtureStatus;
  backend: LiveFixtureInspection;
}

export interface ReopenProbe {
  /** The caller must reopen a durable database/controller after an actual app restart. */
  readBefore: () => Promise<RecoveryObservation>;
  restartAndRead: () => Promise<RecoveryObservation>;
}

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Incus recovery probe failed: ${message}`);
}

function matchesScope(value: FixtureStatus, scope: IncusQualificationScope,
  handle: LiveFixtureHandle): boolean {
  return value.fixture.operationId === handle.operationId
    && value.fixture.bindingId === handle.sandboxId
    && value.binding.id === handle.sandboxId
    && value.fixture.installationId === scope.installationId
    && value.fixture.releaseId === scope.releaseId
    && value.fixture.connectionId === scope.connectionId
    && value.fixture.presetId === scope.presetId;
}

function stableObservation(value: RecoveryObservation, scope: IncusQualificationScope,
  handle: LiveFixtureHandle): void {
  requireFact(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.processId), "invalid process identity");
  requireFact(matchesScope(value.durable, scope, handle), "durable fixture scope changed");
  requireFact(value.backend.sandboxId === handle.sandboxId
    && value.durable.binding.desiredState === value.durable.binding.observedState
    && value.backend.state === value.durable.binding.observedState.toLowerCase(),
  "backend and durable fixture state differ");
  requireFact(Number.isSafeInteger(value.durable.binding.generation)
    && value.durable.binding.generation > 0,
  "durable generation is unavailable");
  requireFact(value.durable.operation?.state === "SUCCEEDED"
    && value.durable.operation.generation === value.durable.binding.generation,
  "last operation is not durably complete");
  requireFact(value.backend.state === "running" || value.backend.bootId === null,
    "stopped fixture has a running boot identity");
  requireFact(value.backend.state !== "running" || !!value.backend.bootId,
    "running fixture lacks a boot identity");
}

/** Returns only raw observations. The caller must prove that restartAndRead
 * came from a newly started EZHarness process; this cannot be proved inside
 * an in-process callback. */
export async function observeFixtureAcrossRestart(scope: IncusQualificationScope,
  handle: LiveFixtureHandle, probe: ReopenProbe): Promise<{
    before: RecoveryObservation; after: RecoveryObservation;
  }> {
  const before = await probe.readBefore();
  stableObservation(before, scope, handle);
  const after = await probe.restartAndRead();
  stableObservation(after, scope, handle);
  requireFact(after.processId !== before.processId, "controller process did not change");
  requireFact(after.durable.fixture.bindingId === before.durable.fixture.bindingId
    && after.durable.fixture.connectionRevision === before.durable.fixture.connectionRevision
    && after.durable.binding.generation === before.durable.binding.generation
    && after.durable.operation?.id === before.durable.operation?.id
    && after.durable.binding.desiredState === before.durable.binding.desiredState
    && after.backend.state === before.backend.state
    && after.backend.imageDigest === before.backend.imageDigest
    && after.backend.helperDigest === before.backend.helperDigest
    && after.backend.bootId === before.backend.bootId,
  "fixture changed across controller restart");
  return { before, after };
}

export interface FailedCleanupProbe {
  readDurable: (handle: LiveFixtureHandle) => Promise<FixtureStatus>;
  readBackend: (handle: LiveFixtureHandle) => Promise<LiveFixtureInspection>;
  /** Must dispatch one destroy whose provider reply is deliberately lost. */
  injectLostDestroyReply: () => Promise<void>;
  /** Must attempt the real feature readiness path and reject. */
  attemptReadiness: () => Promise<void>;
  /** Must reopen the controller and inspect the same journaled destroy. */
  reconcileFromReopenedController: () => Promise<void>;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/** A lost reply is safe to reconcile only when the durable journal says the
 * outcome is unknown. A terminal FAILED operation needs a separate retry
 * design and is rejected here. */
export async function observeFailedCleanupRecovery(scope: IncusQualificationScope,
  handle: LiveFixtureHandle, unrelated: LiveFixtureHandle, probe: FailedCleanupProbe): Promise<{
    failed: FixtureStatus; recovered: FixtureStatus; unrelated: FixtureStatus;
    backend: LiveFixtureInspection; unrelatedBackend: LiveFixtureInspection;
    readinessErrorCode: string;
  }> {
  requireFact(handle.operationId !== unrelated.operationId && handle.sandboxId !== unrelated.sandboxId,
    "recovery fixture is not independent");
  const initial = await probe.readDurable(handle);
  const otherBefore = await probe.readDurable(unrelated);
  requireFact(matchesScope(initial, scope, handle) && matchesScope(otherBefore, scope, unrelated)
    && initial.binding.observedState === "STOPPED"
    && initial.binding.desiredState === "STOPPED" && initial.operation?.state === "SUCCEEDED"
    && otherBefore.binding.observedState === "STOPPED"
    && otherBefore.binding.desiredState === "STOPPED" && otherBefore.operation?.state === "SUCCEEDED",
  "fixture is not stopped or scope changed");
  let lostReply = false;
  try { await probe.injectLostDestroyReply(); }
  catch { lostReply = true; }
  requireFact(lostReply, "injected destroy reply was not lost");
  const failed = await probe.readDurable(handle);
  requireFact(matchesScope(failed, scope, handle)
    && failed.binding.generation === initial.binding.generation
    && failed.operation?.kind === "DESTROY"
    && failed.operation.state === "OUTCOME_UNKNOWN"
    && failed.operation.id !== initial.operation?.id
    && failed.operation.generation === failed.binding.generation
    && failed.binding.desiredState === "ABSENT",
  "lost destroy effect is not durably uncertain");
  let denial: unknown;
  try { await probe.attemptReadiness(); }
  catch (error) { denial = error; }
  const readinessErrorCode = errorCode(denial);
  requireFact(readinessErrorCode === "QUALIFICATION_CLEANUP_UNVERIFIED",
    "uncertain cleanup did not deny readiness");
  await probe.reconcileFromReopenedController();
  const [recovered, unrelatedAfter, backend, unrelatedBackend] = await Promise.all([
    probe.readDurable(handle), probe.readDurable(unrelated),
    probe.readBackend(handle), probe.readBackend(unrelated),
  ]);
  requireFact(matchesScope(recovered, scope, handle) && matchesScope(unrelatedAfter, scope, unrelated)
    && recovered.binding.generation === failed.binding.generation
    && recovered.operation?.id === failed.operation.id
    && recovered.operation.kind === "DESTROY"
    && recovered.operation.state === "SUCCEEDED"
    && recovered.binding.observedState === "ABSENT"
    && backend.sandboxId === handle.sandboxId && backend.state === "absent"
    && unrelatedAfter.binding.observedState === "STOPPED"
    && unrelatedAfter.binding.generation === otherBefore.binding.generation
    && unrelatedBackend.sandboxId === unrelated.sandboxId && unrelatedBackend.state === "stopped",
  "destroy reconciliation or unrelated fixture readback changed");
  return { failed, recovered, unrelated: unrelatedAfter, backend, unrelatedBackend,
    readinessErrorCode };
}
