import type { RecoveryObservation } from "../incus-live-recovery-probes";

export const checkpointTestScope = { installationId: "installation", releaseId: "release",
  connectionId: "connection", presetId: "preset" };
export const checkpointTestHandle = { operationId: "fixture", sandboxId: "binding" };

export function checkpointTestObservation(processId: string): RecoveryObservation {
  return {
    processId,
    durable: {
      fixture: { ...checkpointTestScope, operationId: checkpointTestHandle.operationId,
        bindingId: checkpointTestHandle.sandboxId, connectionRevision: 2 },
      binding: { id: checkpointTestHandle.sandboxId, generation: 3,
        desiredState: "STOPPED", observedState: "STOPPED" },
      operation: { id: "stop-operation", state: "SUCCEEDED", generation: 3 },
    },
    backend: { sandboxId: checkpointTestHandle.sandboxId, state: "stopped", bootId: null,
      imageDigest: "a".repeat(64), helperDigest: "b".repeat(64) },
  } as RecoveryObservation;
}
