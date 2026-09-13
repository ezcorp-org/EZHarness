import { FACTORY_LIMITS, type CompiledFactory, type JsonValue } from "@ezcorp/factory-sdk/types";
import { firstValidationIssue, validateCompiledFactory } from "@ezcorp/factory-sdk/validation";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { MAX_ACTIVITY_PAYLOAD_BYTES, MAX_COMMAND_BATCH_BYTES, MAX_DEFINITION_PAGES, MAX_PAGE_BYTES } from "./contracts.ts";
import type {
  FactoryContinuation,
  FactoryDefinitionPage,
  FactoryDefinitionPageReference,
  FactoryDefinitionSource,
  FactoryInboxEnvelope,
  FactoryManifestPage,
  FactoryPartitionSource,
  FactoryPlanSource,
  FactoryWorkflowInput,
  ImmutableObjectReference,
} from "./contracts.ts";

export const MAX_CONTINUATION_BYTES = 64 * 1024;

function requiredIdentity(value: string, label: string): void {
  if (value.length === 0 || value.length > 512) throw new Error(`${label} must contain 1 to 512 characters`);
}

function boundedInteger(value: unknown, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new Error(`${label} must be between 1 and ${maximum}`);
}

function digest(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function assertActivityPayloadSize(value: unknown, label: string): void {
  if (encodedBytes(value) > MAX_ACTIVITY_PAYLOAD_BYTES) throw new Error(`${label} exceeds ${MAX_ACTIVITY_PAYLOAD_BYTES} bytes`);
}

export function assertCommandBatchSize(value: unknown): void {
  if (encodedBytes(value) > MAX_COMMAND_BATCH_BYTES) throw new Error(`factory command batch exceeds ${MAX_COMMAND_BATCH_BYTES} bytes`);
}

export function validateObjectReference(reference: ImmutableObjectReference, label: string): void {
  if (typeof reference !== "object" || reference === null) throw new Error(`${label} must be an immutable object reference`);
  requiredIdentity(reference.objectId, `${label} object ID`);
  digest(reference.digest, `${label} digest`);
  boundedInteger(reference.encodedBytes, MAX_PAGE_BYTES, `${label} byte count`);
}

export function validateDefinitionSource(source: FactoryDefinitionSource): void {
  if (typeof source !== "object" || source === null) throw new Error("factory definition source is required");
  digest(source.definitionDigest, "factory definition digest");
  boundedInteger(source.definitionEncodedBytes, FACTORY_LIMITS.maxDefinitionBytes, "factory definition byte count");
  validateObjectReference(source.manifest, "factory manifest");
}

export function isPartitionSource(source: FactoryPlanSource): source is FactoryPartitionSource {
  return typeof source === "object" && source !== null && ("executionManifest" in source || "partition" in source);
}

export function validatePartitionSource(source: FactoryPartitionSource): void {
  if (typeof source !== "object" || source === null) throw new Error("factory partition source is required");
  digest(source.definitionDigest, "factory definition digest");
  validateObjectReference(source.executionManifest, "factory execution manifest");
  validateObjectReference(source.partition, "factory partition artifact");
  requiredIdentity(source.partition.partitionId, "factory partition ID");
}

export function validateManifestPage(page: FactoryManifestPage): void {
  if (typeof page !== "object" || page === null || page.schemaVersion !== "factory.manifest-page.v1" || !Array.isArray(page.pages)) throw new Error("factory manifest page is invalid");
  digest(page.definitionDigest, "manifest definition digest");
  boundedInteger(page.definitionEncodedBytes, FACTORY_LIMITS.maxDefinitionBytes, "manifest definition byte count");
  validateObjectReference(page.self, "manifest self reference");
  if (page.pages.length > MAX_DEFINITION_PAGES) throw new Error(`factory manifest page exceeds ${MAX_DEFINITION_PAGES} entries`);
  for (const reference of page.pages) {
    validateObjectReference(reference, "factory definition page");
    if (!Number.isSafeInteger(reference.index) || reference.index < 0) throw new Error("factory definition page index must be a non-negative safe integer");
  }
  if (page.next) validateObjectReference(page.next, "next manifest page");
}

export function validateLoadedDefinitionPage(page: FactoryDefinitionPage, reference: FactoryDefinitionPageReference): void {
  if (typeof page !== "object" || page === null || typeof page.content !== "string") throw new Error("loaded factory definition page is invalid");
  if (page.index !== reference.index || page.objectId !== reference.objectId || page.digest !== reference.digest) throw new Error("loaded factory definition page identity does not match its immutable reference");
  if (new TextEncoder().encode(page.content).byteLength !== reference.encodedBytes) throw new Error("loaded factory definition page byte count does not match its immutable reference");
}

export function validateWorkflowInput(input: FactoryWorkflowInput): void {
  requiredIdentity(input.tenantId, "tenant ID");
  requiredIdentity(input.projectId, "project ID");
  requiredIdentity(input.logicalRunId, "logical run ID");
  requiredIdentity(input.interpreterId, "interpreter ID");
  if (!Number.isSafeInteger(input.startedAtMs) || input.startedAtMs < 0) throw new Error("start timestamp must be a non-negative safe integer");
  if (input.deadlineAtMs !== undefined && (!Number.isSafeInteger(input.deadlineAtMs) || input.deadlineAtMs < input.startedAtMs)) throw new Error("workflow deadline must be a safe timestamp at or after start");
  assertActivityPayloadSize(input, "factory workflow input");
  if (isPartitionSource(input.definition)) validatePartitionSource(input.definition);
  else validateDefinitionSource(input.definition);
  if (input.continuation && input.continuation.state.definitionDigest !== input.definition.definitionDigest) throw new Error("continuation definition digest does not match input");
  if (input.continuation && isPartitionSource(input.definition) && input.continuation.state.partition?.id !== input.definition.partition.partitionId) throw new Error("continuation partition ID does not match input");
  if (input.continuation && (!Number.isSafeInteger(input.continuation.acknowledgedInboxSequence) || input.continuation.acknowledgedInboxSequence < 0)) throw new Error("continuation inbox sequence must be a non-negative safe integer");
}

export function validateCompiledFactoryShape(factory: CompiledFactory): void {
  const result = validateCompiledFactory(factory);
  if (!result.ok) {
    const issue = firstValidationIssue(result);
    throw new Error(`${issue?.code ?? "COMPILED_INVALID"}: ${issue?.message ?? "Compiled factory is invalid."}`);
  }
}

export function validateInboxEnvelope(value: FactoryInboxEnvelope): void {
  if (typeof value !== "object" || value === null) throw new Error("factory inbox envelope must be an object");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) throw new Error("factory inbox sequence must be a positive safe integer");
  requiredIdentity(value.eventId, "factory inbox event ID");
  digest(value.eventHash, "factory inbox event hash");
  validateInboxEvent(value.event as unknown as JsonValue);
  if (value.event.id !== value.eventId) throw new Error("factory inbox event ID does not match its envelope");
  assertActivityPayloadSize(value, "factory inbox signal");
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
