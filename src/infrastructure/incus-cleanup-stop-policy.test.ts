import { expect, test } from "bun:test";
import { permitsLinkedCleanupStop as permits, permitsFailedCleanupInspection as permitsInspect } from "./incus-cleanup-stop-policy";

type Binding = Parameters<typeof permits>[0];
type Recovery = NonNullable<Parameters<typeof permits>[1]>;
type Journal = NonNullable<Parameters<typeof permits>[2]>;
const binding: Binding = { id: "binding", generation: 1, currentOperationId: "stop", tombstonedAt: new Date(0),
  desiredState: "ABSENT", providerInstallationId: "installation", providerReleaseId: "release", connectionId: "connection", connectionRevision: 1 };
const recovery: Recovery = { id: "recovery", bindingId: "binding", generation: 1, failedDestroyOperationId: "failed",
  stopOperationId: "stop", destroyOperationId: "destroy", installationId: "installation", releaseId: "release",
  connectionId: "connection", connectionRevision: 1, providerResourceId: "guest", providerGeneration: 2,
  state: "STOP_REQUIRED", createdAt: new Date(0), updatedAt: new Date(0) };
const failed: Journal = { id: "failed", bindingId: "binding", generation: 1, kind: "DESTROY", state: "FAILED",
  providerOperationId: null, errorCode: "REVISION_CONFLICT", requestPayload: { expectedGeneration: 2 } };
const stop: Journal = { ...failed, id: "stop", kind: "STOP", state: "DISPATCHING", errorCode: null };

test("only the exact linked STOP retains cleanup authority", () => {
  for (const state of ["JOURNALED", "DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN", "SUCCEEDED"] as const)
    expect(permits(binding, recovery, failed, { ...stop, state }, "guest")).toBe(true);
  expect(permits(binding, undefined, failed, stop, "guest")).toBe(false);
  expect(permits(binding, recovery, undefined, stop, "guest")).toBe(false);
  expect(permits(binding, recovery, failed, undefined, "guest")).toBe(false);
  expect(permits(binding, recovery, failed, stop, "foreign-guest")).toBe(false);
  const bindingPatches: Partial<Binding>[] = [{ tombstonedAt: null }, { desiredState: "RUNNING" }, { generation: 2 },
    { currentOperationId: "failed" }, { providerInstallationId: "foreign" }, { providerReleaseId: "foreign" },
    { connectionId: "foreign" }, { connectionRevision: 2 }];
  for (const patch of bindingPatches) expect(permits({ ...binding, ...patch }, recovery, failed, stop, "guest")).toBe(false);
  const recoveryPatches: Partial<Recovery>[] = [{ state: "DESTROY_REQUIRED" }, { state: "COMPLETED" }, { bindingId: "foreign" },
    { failedDestroyOperationId: "foreign" }, { stopOperationId: "foreign" }, { destroyOperationId: "stop" },
    { destroyOperationId: "failed" }, { providerGeneration: 0 }, { providerGeneration: 1.5 },
    { failedDestroyOperationId: "stop" }];
  for (const patch of recoveryPatches) expect(permits(binding, { ...recovery, ...patch }, failed, stop, "guest")).toBe(false);
  const failedPatches: Partial<Journal>[] = [{ bindingId: "foreign" }, { generation: 2 }, { kind: "STOP" }, { state: "OUTCOME_UNKNOWN" },
    { errorCode: "INTERNAL" }, { providerOperationId: "provider" }, { requestPayload: { expectedGeneration: 3 } },
    { requestPayload: { expectedGeneration: 2, extra: true } }];
  for (const patch of failedPatches) expect(permits(binding, recovery, { ...failed, ...patch }, stop, "guest")).toBe(false);
  const stopPatches: Partial<Journal>[] = [{ bindingId: "foreign" }, { generation: 2 }, { kind: "START" }, { state: "FAILED" },
    { requestPayload: { expectedGeneration: 3 } }, { requestPayload: { expectedGeneration: 2, extra: true } }];
  for (const patch of stopPatches) expect(permits(binding, recovery, failed, { ...stop, ...patch }, "guest")).toBe(false);
});

test("failed cleanup inspection grants readback only for the exact current no-effect failure", () => {
  const failedBinding = { ...binding, currentOperationId: "failed" };
  expect(permitsInspect(failedBinding, failed)).toBe(true);
  expect(permitsInspect(failedBinding, undefined)).toBe(false);
  for (const patch of [{ tombstonedAt: null }, { desiredState: "RUNNING" as const }, { currentOperationId: "other" }, { generation: 2 }])
    expect(permitsInspect({ ...failedBinding, ...patch }, failed)).toBe(false);
  const patches: Partial<Journal>[] = [{ bindingId: "foreign" }, { generation: 2 }, { kind: "STOP" }, { state: "OUTCOME_UNKNOWN" },
    { errorCode: "INTERNAL" }, { providerOperationId: "provider" }, { requestPayload: { expectedGeneration: 0 } },
    { requestPayload: { expectedGeneration: 1.5 } }, { requestPayload: { expectedGeneration: 2, extra: true } }];
  for (const patch of patches) expect(permitsInspect(failedBinding, { ...failed, ...patch })).toBe(false);
});
