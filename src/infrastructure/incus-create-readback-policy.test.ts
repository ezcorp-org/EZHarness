import { expect, test } from "bun:test";
import type { SandboxBinding, SandboxOperation } from "../db/schema";
import { permitsCreateReadbackDuringQueuedCleanup as permits } from "./incus-create-readback-policy";

const timestamp = new Date(0);
const binding: SandboxBinding = {
  id: "binding", projectId: "project", providerInstallationId: "installation", providerReleaseId: "release",
  connectionId: "connection", connectionRevision: 1, profile: "profile", presetId: "preset",
  presetDigest: "preset-digest", effectiveSettingsDigest: "settings-digest", resourceKey: "binding",
  generation: 1, currentOperationId: "cleanup", tombstonedAt: timestamp, cleanupConfirmedAt: null,
  desiredState: "ABSENT", observedState: "UNKNOWN", createdAt: timestamp, updatedAt: timestamp,
};
const cleanup: SandboxOperation = {
  id: "cleanup", bindingId: "binding", kind: "DESTROY", generation: 1, state: "JOURNALED",
  idempotencyScope: "qualification", idempotencyKey: "cleanup", payloadHash: "cleanup-hash",
  providerOperationId: null, requestPayload: { expectedGeneration: 1 }, errorCode: null, errorMessage: null,
  reconcileOrder: null, dispatchedAt: null, createdAt: timestamp, updatedAt: timestamp,
};
const create: SandboxOperation = { ...cleanup, id: "create", kind: "CREATE", state: "OUTCOME_UNKNOWN",
  providerOperationId: "saved-provider-create", idempotencyKey: "create", requestPayload: {} };

test("permits only the queued exact-generation cleanup shape", () => {
  expect(permits(binding, create, cleanup)).toBe(true);
  expect(permits(binding, create, undefined)).toBe(false);
  const deniedPatches: Partial<SandboxOperation>[] = [
    { bindingId: "foreign" }, { kind: "CREATE" }, { generation: 2 }, { state: "DISPATCHING" },
    { providerOperationId: "provider-operation" }, { requestPayload: { expectedGeneration: 2 } },
    { requestPayload: { expectedGeneration: 1, extra: true } }, { requestPayload: {} },
  ];
  for (const patch of deniedPatches) expect(permits(binding, create, { ...cleanup, ...patch })).toBe(false);
  expect(permits({ ...binding, tombstonedAt: null }, create, cleanup)).toBe(false);
  expect(permits({ ...binding, desiredState: "STOPPED" }, create, cleanup)).toBe(false);
});
