import { expect, test } from "bun:test";
import type { Database } from "../db/connection";
import { sandboxBindings, sandboxOperations, sandboxReservations } from "../db/schema";
import type { IncusQualificationCheckpointStore } from "./incus-qualification-checkpoint";
import type { IncusQualificationFixtureService, IncusQualificationStore } from "./incus-qualification";
import type { HostIncusLostDestroyReplyFault } from "./incus-destroy-reply-fault";
import type { IncusFeatureService } from "./incus-feature-service";
import { IncusLiveCleanupController } from "./incus-live-cleanup-controller";

const now = Date.now();
const scope = { installationId: "install", releaseId: "release", connectionId: "connection", presetId: "preset" };
const handle = { operationId: "qual-recovery-run-one", sandboxId: "recovery-binding" };
const destroyId = "11111111-1111-4111-8111-111111111111";

function harness(fault?: "readback" | "other-operation" | "readiness" | "expired") {
  let phase = 0;
  let settled = false;
  const calls: string[] = [];
  const status = () => ({ fixture: { ...scope, operationId: handle.operationId,
    bindingId: handle.sandboxId, connectionRevision: 2 },
  binding: { id: handle.sandboxId, generation: 1,
    desiredState: phase === 0 ? "STOPPED" : "ABSENT",
    observedState: phase === 0 ? "STOPPED" : phase === 1 ? "UNKNOWN" : "ABSENT" },
  operation: { id: phase === 0 ? "create-one" : destroyId,
    kind: phase === 0 ? "CREATE" : "DESTROY",
    state: phase === 0 || phase === 2 ? "SUCCEEDED" : "OUTCOME_UNKNOWN", generation: 1 } });
  const db = { select: (shape?: Record<string, unknown>) => ({ from: (table: unknown) => ({ where: () => ({
    limit: async () => table === sandboxOperations ? shape?.id ? [{ id: fault === "other-operation" ? "other" : destroyId }]
      : [{ id: destroyId, bindingId: handle.sandboxId, kind: "DESTROY",
        state: phase === 1 ? "OUTCOME_UNKNOWN" : "SUCCEEDED", generation: 1,
        idempotencyScope: "incus-qualification", idempotencyKey: `${handle.operationId}:destroy`,
        requestPayload: { expectedGeneration: 7 } }]
      : table === sandboxBindings ? [{ id: handle.sandboxId, generation: 1, connectionRevision: 2,
        currentOperationId: destroyId, desiredState: "ABSENT", observedState: phase === 2 ? "ABSENT" : "UNKNOWN",
        cleanupConfirmedAt: new Date() }]
        : table === sandboxReservations ? [{ bindingId: handle.sandboxId, generation: 1,
          cleanupIntentId: `incus-qualification-destroy-${handle.operationId}`,
          computeState: settled ? "RELEASED" : "RESERVED",
          diskState: settled ? "RELEASED" : "RESERVED" }] : [],
  }) }) }) } as unknown as Database;
  const fixtures = { status: async () => status(),
    destroyWithLostReplyFault: async () => { calls.push("destroy"); phase = 1; throw new Error("reply lost"); },
  } as unknown as IncusQualificationFixtureService;
  const checkpoints = { get: async () => ({ state: "CLAIMED", nonce: "nonce", scope,
    bindingId: "primary-binding", connectionRevision: 2,
    deadlineAt: new Date(now - 1),
    claimedAt: new Date(now - (fault === "expired" ? 20 * 60_000 : 60_000)) }),
  authorizeRecoveryFixtureForRun: async (arm: Record<string, unknown>) => {
    expect(arm.fixtureOperationId).toBe(handle.operationId);
    expect(arm.bindingId).toBe(handle.sandboxId);
  } } as unknown as IncusQualificationCheckpointStore;
  const readback = { fact: fault === "readback" ? null : "RECONCILE_REQUIRED",
    destroyOperationId: destroyId, bindingId: handle.sandboxId };
  const operatorFault = { readback: async () => { calls.push("readback"); return readback; } } as unknown as HostIncusLostDestroyReplyFault;
  const featureGate = { checkReadiness: async (input: { projectId: string; installationId: string;
    connectionId: string; presetId: string }) => {
    expect(input).toEqual({ projectId: "controlled-user-project", installationId: scope.installationId,
      connectionId: scope.connectionId, presetId: scope.presetId });
    calls.push("readiness");
    if (fault === "readiness") return;
    throw Object.assign(new Error("cleanup pending"), { code: "QUALIFICATION_CLEANUP_UNVERIFIED" });
  }, reconcile: async () => { calls.push("reconcile"); phase = 2; },
  settleCompletedOperation: async (id: string) => {
    expect(id).toBe(destroyId); calls.push("settle"); settled = true; },
  } as unknown as IncusFeatureService;
  const reopen = () => new IncusLiveCleanupController({ db, fixtures,
    qualifications: {} as IncusQualificationStore, readinessProjectId: "controlled-user-project",
    checkpoints, fault: async () => operatorFault, freshFeatureGate: () => featureGate, now: () => now });
  const reopenWithDefaultGate = () => new IncusLiveCleanupController({ db, fixtures,
    qualifications: {} as IncusQualificationStore, readinessProjectId: "controlled-user-project",
    checkpoints, fault: async () => operatorFault, now: () => now });
  return { controller: reopen(), reopen, reopenWithDefaultGate, calls, completed: () => { phase = 2; } };
}

test("the default production readiness gate denies an unprepared user project", async () => {
  const { controller, reopenWithDefaultGate, calls } = harness();
  await expect(controller.injectLostDestroyReply(scope, handle)).rejects.toThrow("reply lost");
  await expect(reopenWithDefaultGate().attemptReadiness(scope, handle))
    .rejects.toThrow("Incus feature project is unavailable");
  expect(calls).toEqual(["destroy", "readback"]);
});

test("reopened controller resumes the exact uncertain destroy from durable identities", async () => {
  const { controller, reopen, calls } = harness();
  await expect(controller.injectLostDestroyReply(scope, handle)).rejects.toThrow("reply lost");
  const replacement = reopen();
  await expect(replacement.attemptReadiness(scope, handle)).rejects.toMatchObject({
    code: "QUALIFICATION_CLEANUP_UNVERIFIED" });
  await replacement.reconcileFromReopenedController(scope, handle);
  expect(calls).toEqual(["destroy", "readback", "readiness", "readiness", "reconcile", "settle"]);
});

test("reopened controller settles an already completed destroy without another provider effect", async () => {
  const { controller, completed, calls } = harness();
  completed();
  await expect(controller.verifySettledDestroy(scope, handle, destroyId))
    .rejects.toThrow("resource release is unverified");
  await controller.settleAlreadyCompletedDestroy(scope, handle, destroyId);
  expect(calls).toEqual(["settle"]);
  await expect(controller.settleAlreadyCompletedDestroy(scope, handle, "other-operation"))
    .rejects.toThrow("completed destroy journal identity changed");
  expect(calls).toEqual(["settle"]);
});

test("operator cleanup uses one lost reply, exact readback, readiness denial and same journal recovery", async () => {
  const { controller, calls } = harness();
  await expect(controller.injectLostDestroyReply(scope, handle)).rejects.toThrow("reply lost");
  await expect(controller.attemptReadiness(scope, handle)).rejects.toMatchObject({
    code: "QUALIFICATION_CLEANUP_UNVERIFIED" });
  await controller.reconcileFromReopenedController(scope, handle);
  expect(calls).toEqual(["destroy", "readback", "readiness", "readiness", "reconcile", "settle"]);
  await expect(controller.reconcileFromReopenedController(scope, handle))
    .rejects.toThrow("recovery destroy is not the exact uncertain fixture");
});

test("missing independent readback or an unrelated pending operation fails closed", async () => {
  const expired = harness("expired");
  await expect(expired.controller.injectLostDestroyReply(scope, handle))
    .rejects.toThrow("claimed operator run is unavailable");
  expect(expired.calls).toEqual([]);
  const noReadback = harness("readback");
  await expect(noReadback.controller.injectLostDestroyReply(scope, handle))
    .rejects.toThrow("operator destroy readback did not confirm uncertainty");
  await expect(noReadback.controller.attemptReadiness(scope, handle))
    .rejects.toMatchObject({ code: "QUALIFICATION_CLEANUP_UNVERIFIED" });
  const competing = harness("other-operation");
  await expect(competing.controller.injectLostDestroyReply(scope, handle)).rejects.toThrow("reply lost");
  await expect(competing.controller.attemptReadiness(scope, handle))
    .rejects.toMatchObject({ code: "QUALIFICATION_CLEANUP_UNVERIFIED" });
  await expect(competing.controller.reconcileFromReopenedController(scope, handle))
    .rejects.toThrow("another pending operation blocks exact recovery");
  expect(competing.calls).not.toContain("reconcile");
  const noDenial = harness("readiness");
  await expect(noDenial.controller.injectLostDestroyReply(scope, handle)).rejects.toThrow("reply lost");
  await noDenial.controller.attemptReadiness(scope, handle);
  await expect(noDenial.controller.reconcileFromReopenedController(scope, handle))
    .rejects.toThrow("production readiness did not deny");
  expect(noDenial.calls).not.toContain("reconcile");
});
