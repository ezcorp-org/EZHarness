import { expect, test } from "bun:test";
import type { IncusQualificationFixtureService, IncusQualificationScope } from "./incus-qualification";
import type { LiveFixtureHandle, LiveFixtureInspection } from "./incus-live-cases";
import { observeFailedCleanupRecovery, observeFixtureAcrossRestart,
  type FailedCleanupProbe, type RecoveryObservation } from "./incus-live-recovery-probes";

type Status = Awaited<ReturnType<IncusQualificationFixtureService["status"]>>;
const scope: IncusQualificationScope = { installationId: "install", releaseId: "release",
  connectionId: "connection", presetId: "preset" };
const handle: LiveFixtureHandle = { operationId: "fixture-1", sandboxId: "binding-1" };
const other: LiveFixtureHandle = { operationId: "fixture-2", sandboxId: "binding-2" };

function status(fixture: LiveFixtureHandle, operationId: string, operationKind: "CREATE" | "DESTROY",
  operationState: "SUCCEEDED" | "OUTCOME_UNKNOWN" = "SUCCEEDED",
  observedState: "STOPPED" | "ABSENT" = "STOPPED"): Status {
  return { fixture: { ...scope, operationId: fixture.operationId, bindingId: fixture.sandboxId,
    projectId: `project-${fixture.sandboxId}`, connectionRevision: 1 },
  binding: { id: fixture.sandboxId, generation: 1,
    desiredState: operationKind === "DESTROY" ? "ABSENT" : "STOPPED", observedState },
  operation: { id: operationId, kind: operationKind, state: operationState, generation: 1,
    providerOperationId: null, errorCode: null, createdAt: new Date(), updatedAt: new Date() } };
}

function backend(fixture: LiveFixtureHandle, state: "stopped" | "absent" = "stopped"):
  LiveFixtureInspection {
  return { sandboxId: fixture.sandboxId, state, imageDigest: "a".repeat(64), helperDigest: "b".repeat(64),
    profile: "persistent-web-compose.v1", workspaceRoot: "/workspace", guestUser: "sandbox",
    memoryBytes: 1024, cpuMillis: 1000, pids: 100, diskBytes: 1024,
    storageDriver: "btrfs", privateNetwork: true, restrictedProject: true,
    unprivileged: true, bootId: null };
}

test("restart comparison retains exact durable operation and backend identity", async () => {
  const before: RecoveryObservation = { processId: "process-1", durable: status(handle, "stop-1", "CREATE"),
    backend: backend(handle) };
  const after: RecoveryObservation = { ...before, processId: "process-2" };
  const result = await observeFixtureAcrossRestart(scope, handle, {
    readBefore: async () => before, restartAndRead: async () => after });
  expect(result).toEqual({ before, after });
  await expect(observeFixtureAcrossRestart(scope, handle, {
    readBefore: async () => before, restartAndRead: async () => before }))
    .rejects.toThrow("process did not change");
  await expect(observeFixtureAcrossRestart(scope, handle, {
    readBefore: async () => before, restartAndRead: async () => ({ ...after,
      durable: status(handle, "another-operation", "CREATE") }) }))
    .rejects.toThrow("fixture changed across controller restart");
  await expect(observeFixtureAcrossRestart(scope, handle, {
    readBefore: async () => before, restartAndRead: async () => ({ ...after,
      backend: backend(other) }) }))
    .rejects.toThrow("backend and durable fixture state differ");
});

test("lost destroy reply needs durable uncertainty, readiness denial, same-operation recovery and backend absence", async () => {
  const initial = status(handle, "create-1", "CREATE");
  const failed = status(handle, "destroy-1", "DESTROY", "OUTCOME_UNKNOWN");
  const recovered = status(handle, "destroy-1", "DESTROY", "SUCCEEDED", "ABSENT");
  const otherStatus = status(other, "create-2", "CREATE");
  let phase = 0;
  const probe: FailedCleanupProbe = {
    readDurable: async fixture => fixture.sandboxId === other.sandboxId ? otherStatus
      : phase === 0 ? initial : phase === 1 ? failed : recovered,
    readBackend: async fixture => backend(fixture, fixture.sandboxId === handle.sandboxId ? "absent" : "stopped"),
    injectLostDestroyReply: async () => { phase = 1; throw new Error("provider response lost"); },
    attemptReadiness: async () => { throw Object.assign(new Error("cleanup uncertain"),
      { code: "QUALIFICATION_CLEANUP_UNVERIFIED" }); },
    reconcileFromReopenedController: async () => { phase = 2; },
  };
  const result = await observeFailedCleanupRecovery(scope, handle, other, probe);
  expect(result.failed.operation?.id).toBe("destroy-1");
  expect(result.recovered.operation?.id).toBe("destroy-1");
  expect(result.backend.state).toBe("absent");

  phase = 0;
  await expect(observeFailedCleanupRecovery(scope, handle, other, {
    ...probe, injectLostDestroyReply: async () => { phase = 1; },
  })).rejects.toThrow("reply was not lost");
  phase = 0;
  await expect(observeFailedCleanupRecovery(scope, handle, other, {
    ...probe, attemptReadiness: async () => {},
  })).rejects.toThrow("did not deny readiness");
  phase = 0;
  await expect(observeFailedCleanupRecovery(scope, handle, other, {
    ...probe, reconcileFromReopenedController: async () => { phase = 2; },
    readBackend: async fixture => backend(fixture),
  })).rejects.toThrow("readback changed");
  phase = 0;
  await expect(observeFailedCleanupRecovery(scope, handle, other, {
    ...probe, reconcileFromReopenedController: async () => { phase = 2; },
    readDurable: async fixture => fixture.sandboxId === other.sandboxId ? otherStatus
      : phase === 0 ? initial : phase === 1 ? failed : status(handle, "destroy-2", "DESTROY", "SUCCEEDED", "ABSENT"),
  })).rejects.toThrow("readback changed");
});
