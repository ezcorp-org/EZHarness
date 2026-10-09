import type { SandboxBinding, SandboxOperation } from "../db/schema";

/** Read-only exception for the original CREATE while its cleanup remains queued. */
export function permitsCreateReadbackDuringQueuedCleanup(
  binding: SandboxBinding, create: SandboxOperation, cleanup: SandboxOperation | undefined,
): boolean {
  return cleanup?.bindingId === binding.id && cleanup.kind === "DESTROY"
    && cleanup.generation === create.generation && cleanup.state === "JOURNALED"
    && cleanup.providerOperationId === null && cleanup.requestPayload.expectedGeneration === create.generation
    && Object.keys(cleanup.requestPayload).length === 1 && binding.tombstonedAt !== null && binding.desiredState === "ABSENT";
}
