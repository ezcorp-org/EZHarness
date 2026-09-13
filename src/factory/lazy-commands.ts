import { canonicalizeJson, type FactoryArtifactReference, type JsonValue } from "@ezcorp/factory-sdk";
import type { KernelCommand, KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { MAX_ACTIVITY_PAYLOAD_BYTES } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import type { FactoryCommandAuthority, FactoryAuthorizedInputCommand } from "./command-authority";
import { FACTORY_LAZY_INPUT_PAGE_BYTES, type FactoryLazyInputReader } from "./lazy-input";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

type InputCommand = Extract<KernelCommand, { readonly kind: "read-input-value" | "read-input-page" }>;
type InputValueCommand = Extract<InputCommand, { readonly kind: "read-input-value" }>;
type InputPageCommand = Extract<InputCommand, { readonly kind: "read-input-page" }>;

export class FactoryLazyCommandsError extends Error {
  constructor(readonly code: "factory_lazy_command_invalid" | "factory_lazy_command_oversized") {
    super(code);
    this.name = "FactoryLazyCommandsError";
  }
}

function sameArtifact(left: FactoryArtifactReference, right: FactoryArtifactReference): boolean {
  return left.artifactId === right.artifactId && left.digest === right.digest && left.encodedBytes === right.encodedBytes;
}

function snapshotArtifact(value: FactoryArtifactReference): FactoryArtifactReference {
  return Object.freeze({ artifactId: value.artifactId, digest: value.digest, encodedBytes: value.encodedBytes });
}

function eventId(command: InputCommand): string {
  return `${command.id}:${command.kind === "read-input-value" ? "value" : "page"}`;
}

function bytes(value: JsonValue): number {
  return new TextEncoder().encode(canonicalizeJson(value)).byteLength;
}

function boundedEvent(event: KernelEvent): KernelEvent {
  if (bytes(event as unknown as JsonValue) > FACTORY_LAZY_INPUT_PAGE_BYTES || new TextEncoder().encode(JSON.stringify(event)).byteLength > MAX_ACTIVITY_PAYLOAD_BYTES) {
    throw new FactoryLazyCommandsError("factory_lazy_command_oversized");
  }
  return Object.freeze(event);
}

/**
 * Makes a bounded kernel event from a command already committed in the current
 * transition. The private gateway supplies only the opaque command reference.
 */
export class FactoryLazyCommands {
  constructor(private readonly authority: FactoryCommandAuthority, private readonly reader: FactoryLazyInputReader) {
    if (authority.tenantId !== reader.tenantId) throw new FactoryLazyCommandsError("factory_lazy_command_invalid");
  }

  execute(service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference): Promise<KernelEvent> {
    return this.authority.withCurrentInput(service, reference, async (transaction, context) => this.read(transaction, context));
  }

  private async read(transaction: Parameters<FactoryLazyInputReader["readValueInTransaction"]>[0], context: FactoryAuthorizedInputCommand): Promise<KernelEvent> {
    const command = context.command;
    const input = this.input(context, command);
    if (command.kind === "read-input-value") {
      const maxBytes = this.valueBudget(context, command, input.artifact);
      const result = await this.reader.readValueInTransaction(transaction, { ...input, maxBytes });
      if (!sameArtifact(result.artifact, input.artifact) || result.mediaType !== "application/json" || (command.expectedStorageVersion !== undefined && result.storageVersion !== command.expectedStorageVersion)) throw new FactoryLazyCommandsError("factory_lazy_command_invalid");
      return boundedEvent({ kind: "input-value-read", id: eventId(command), atMs: context.state.nowMs, commandId: command.id, nodeId: command.nodeId, candidateGeneration: command.candidateGeneration, cancellationEpoch: command.cancellationEpoch, name: command.name, artifact: input.artifact, path: input.path, storageVersion: result.storageVersion, mediaType: "application/json", value: result.value });
    }
    const maxBytes = this.pageBudget(context, command, input.artifact);
    const result = await this.reader.readPageInTransaction(transaction, { ...input, maxBytes, cursor: command.cursor, maxItems: command.maxItems });
    if (!sameArtifact(result.artifact, input.artifact) || result.mediaType !== "application/json" || (command.expectedStorageVersion !== undefined && result.storageVersion !== command.expectedStorageVersion)) throw new FactoryLazyCommandsError("factory_lazy_command_invalid");
    return boundedEvent({ kind: "input-page-read", id: eventId(command), atMs: context.state.nowMs, commandId: command.id, nodeId: command.nodeId, candidateGeneration: command.candidateGeneration, cancellationEpoch: command.cancellationEpoch, name: command.name, artifact: input.artifact, path: input.path, storageVersion: result.storageVersion, mediaType: "application/json", cursor: command.cursor, maxItems: command.maxItems, items: result.items, ...(result.nextCursor === null ? {} : { nextCursor: result.nextCursor }) });
  }

  private input(context: FactoryAuthorizedInputCommand, command: InputCommand): { readonly projectId: string; readonly runId: string; readonly name: string; readonly artifact: FactoryArtifactReference; readonly path: readonly (string | number)[] } {
    return Object.freeze({ projectId: context.fence.projectId, runId: context.fence.runId, name: command.name, artifact: snapshotArtifact(command.artifact), path: Object.freeze([...command.path]) });
  }

  private valueBudget(context: FactoryAuthorizedInputCommand, command: InputValueCommand, artifact: FactoryArtifactReference): number {
    const skeleton: KernelEvent = { kind: "input-value-read", id: eventId(command), atMs: context.state.nowMs, commandId: command.id, nodeId: command.nodeId, candidateGeneration: command.candidateGeneration, cancellationEpoch: command.cancellationEpoch, name: command.name, artifact, path: command.path, storageVersion: "storage-version", mediaType: "application/json", value: null };
    return this.payloadBudget(command.maxBytes, skeleton);
  }

  private pageBudget(context: FactoryAuthorizedInputCommand, command: InputPageCommand, artifact: FactoryArtifactReference): number {
    const skeleton: KernelEvent = { kind: "input-page-read", id: eventId(command), atMs: context.state.nowMs, commandId: command.id, nodeId: command.nodeId, candidateGeneration: command.candidateGeneration, cancellationEpoch: command.cancellationEpoch, name: command.name, artifact, path: command.path, storageVersion: "storage-version", mediaType: "application/json", cursor: command.cursor, maxItems: command.maxItems, items: [], nextCursor: Number.MAX_SAFE_INTEGER };
    return this.payloadBudget(command.maxBytes, skeleton);
  }

  private payloadBudget(requested: number, skeleton: KernelEvent): number {
    // The selected JSON replaces `null` or `[]`; its two delimiters are already
    // represented in the skeleton, so the remaining canonical event bytes are safe.
    const available = FACTORY_LAZY_INPUT_PAGE_BYTES - bytes(skeleton as unknown as JsonValue) + 2;
    const bounded = Math.min(requested, available);
    if (!Number.isSafeInteger(bounded) || bounded < 1) throw new FactoryLazyCommandsError("factory_lazy_command_oversized");
    return bounded;
  }
}
