import { FACTORY_LIMITS, type JsonValue } from "@ezcorp/factory-sdk/types";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import type { FactoryContinuation, FactoryWorkflowInput } from "./contracts.ts";

export const MAX_CONTINUATION_BYTES = 64 * 1024;

function requiredIdentity(value: string, label: string): void {
  if (value.length === 0 || value.length > 512) throw new Error(`${label} must contain 1 to 512 characters`);
}

export function validateWorkflowInput(input: FactoryWorkflowInput): void {
  requiredIdentity(input.tenantId, "tenant ID");
  requiredIdentity(input.projectId, "project ID");
  requiredIdentity(input.logicalRunId, "logical run ID");
  requiredIdentity(input.interpreterId, "interpreter ID");
  if (!Number.isSafeInteger(input.startedAtMs) || input.startedAtMs < 0) throw new Error("start timestamp must be a non-negative safe integer");
  if (input.factory.partitions.some((partition) => partition.nodeIds.length > FACTORY_LIMITS.maxPartitionNodes)) {
    throw new Error(`compiled partition exceeds ${FACTORY_LIMITS.maxPartitionNodes} nodes`);
  }
  if (input.continuation && input.continuation.state.definitionDigest !== input.factory.digest) {
    throw new Error("continuation definition digest does not match compiled factory");
  }
}

export function validateInboxEvent(value: JsonValue): asserts value is JsonValue & KernelEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("inbox event must be an object");
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 512) throw new Error("inbox event requires a stable ID");
  if (!Number.isSafeInteger(value.atMs) || (value.atMs as number) < 0) throw new Error(`inbox event ${String(value.id)} requires a recorded timestamp`);
  if (typeof value.kind !== "string") throw new Error("inbox event requires a kind");
}

export function assertContinuationSize(continuation: FactoryContinuation): void {
  const bytes = new TextEncoder().encode(JSON.stringify(continuation)).byteLength;
  if (bytes > MAX_CONTINUATION_BYTES) throw new Error(`continuation snapshot exceeds ${MAX_CONTINUATION_BYTES} bytes`);
}
