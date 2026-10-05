import type { SandboxBinding, SandboxCleanupRecovery, SandboxOperation } from "../db/schema";

type Binding = Pick<SandboxBinding, "id" | "generation" | "currentOperationId" | "tombstonedAt" | "desiredState" | "providerInstallationId" | "providerReleaseId" | "connectionId" | "connectionRevision">;
type Journal = Pick<SandboxOperation, "id" | "bindingId" | "generation" | "kind" | "state" | "providerOperationId" | "errorCode" | "requestPayload">;

/** Known failure classes retain separate backend state and intent-generation proofs. */
export function failedCleanupExpectation(failed: Journal | undefined): { observedState: "running" | "stopped"; providerGeneration: number } | null {
  if (failed?.kind !== "DESTROY" || failed.state !== "FAILED"
    || Object.keys(failed.requestPayload).length !== 1) return null;
  const generation = failed.requestPayload.expectedGeneration;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) return null;
  if (failed.errorCode === "REVISION_CONFLICT" && failed.providerOperationId === null)
    return { observedState: "running", providerGeneration: generation as number };
  if (failed.errorCode === "INTERNAL" && /^incus-destroy-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(failed.providerOperationId ?? "")
    && Number.isSafeInteger((generation as number) + 1))
    return { observedState: "stopped", providerGeneration: (generation as number) + 1 };
  return null;
}

export function matchesCleanupRecoveryBinding(binding: Binding, recovery: SandboxCleanupRecovery, providerResourceId: string): boolean {
  return recovery.bindingId === binding.id && recovery.generation === binding.generation
    && recovery.installationId === binding.providerInstallationId && recovery.releaseId === binding.providerReleaseId
    && recovery.connectionId === binding.connectionId && recovery.connectionRevision === binding.connectionRevision
    && recovery.providerResourceId === providerResourceId;
}

export function matchesFailedCleanupDestroy(binding: Binding, recovery: SandboxCleanupRecovery, failed: Journal): boolean {
  return failed.id === recovery.failedDestroyOperationId && failed.bindingId === binding.id && failed.generation === binding.generation
    && failedCleanupExpectation(failed)?.providerGeneration === recovery.providerGeneration;
}

function matchesLinkedStop(binding: Binding, recovery: SandboxCleanupRecovery, stop: Journal): boolean {
  return stop.id === recovery.stopOperationId && binding.currentOperationId === stop.id && stop.bindingId === binding.id
    && stop.generation === binding.generation && stop.kind === "STOP" && ["JOURNALED", "DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN", "SUCCEEDED"].includes(stop.state)
    && stop.requestPayload.expectedGeneration === recovery.providerGeneration && Object.keys(stop.requestPayload).length === 1
    && recovery.failedDestroyOperationId !== recovery.stopOperationId && recovery.destroyOperationId !== recovery.stopOperationId
    && recovery.destroyOperationId !== recovery.failedDestroyOperationId;
}

/** Only the persisted linked STOP can run or be inspected under a retained tombstone. */
export function permitsLinkedCleanupStop(binding: Binding, recovery: SandboxCleanupRecovery | undefined,
  failed: Journal | undefined, stop: Journal | undefined, providerResourceId: string): boolean {
  return Boolean(recovery && failed && stop && binding.tombstonedAt !== null && binding.desiredState === "ABSENT" && recovery.state === "STOP_REQUIRED"
    && Number.isSafeInteger(recovery.providerGeneration) && recovery.providerGeneration >= 1
    && matchesCleanupRecoveryBinding(binding, recovery, providerResourceId)
    && matchesFailedCleanupDestroy(binding, recovery, failed) && matchesLinkedStop(binding, recovery, stop));
}

/** Inspect the exact retained failed cleanup without granting any mutation. */
export function permitsFailedCleanupInspection(binding: Binding, current: Journal | undefined): boolean {
  return Boolean(current && binding.tombstonedAt !== null && binding.desiredState === "ABSENT"
    && binding.currentOperationId === current.id && current.bindingId === binding.id && current.generation === binding.generation
    && failedCleanupExpectation(current));
}
