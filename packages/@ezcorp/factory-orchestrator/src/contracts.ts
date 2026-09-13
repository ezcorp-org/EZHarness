import type { CompiledExecutionManifest, CompiledPartitionArtifact, JsonValue } from "@ezcorp/factory-sdk";
import type { KernelCommand, KernelEvent, KernelState } from "@ezcorp/factory-sdk/kernel-types";
export type { ClaimedFactoryCommand, FactoryCommandQueue, FactoryTransportCommand } from "@ezcorp/factory-sdk/transport-types";

export const FACTORY_WORKFLOW_TYPE = "factoryWorkflow";
export const FACTORY_INBOX_SIGNAL = "factoryInbox";
export const FACTORY_STATE_QUERY = "factoryState";
export const FACTORY_INBOX_RECEIPT_QUERY = "factoryInboxReceipt";
export const FACTORY_TASK_QUEUE = "factory-orchestrator";
export const MAX_INBOX_EVENTS = 128;
export const CONTINUE_AFTER_EVENTS = 64;
export const MAX_ACTIVITY_PAYLOAD_BYTES = 64 * 1024;
export const MAX_DEFINITION_BYTES = 16 * 1024 * 1024;
export const MAX_PAGE_BYTES = 32 * 1024;
export const MAX_DEFINITION_PAGES = MAX_DEFINITION_BYTES / MAX_PAGE_BYTES;
export const MAX_COMMAND_BATCH_BYTES = 512 * 1024;
export const MAX_INFLIGHT_COMMANDS = 32;

export interface ImmutableObjectReference {
  readonly objectId: string;
  readonly digest: string;
  readonly encodedBytes: number;
}

export interface FactoryDefinitionSource {
  readonly definitionDigest: string;
  readonly definitionEncodedBytes: number;
  readonly manifest: ImmutableObjectReference;
}

export interface FactoryPartitionReference extends ImmutableObjectReference {
  readonly partitionId: string;
}

/** Bounded immutable inputs for one partition-local interpreter. */
export interface FactoryPartitionSource {
  readonly definitionDigest: string;
  readonly executionManifest: ImmutableObjectReference;
  readonly partition: FactoryPartitionReference;
}

export type FactoryPlanSource = FactoryDefinitionSource | FactoryPartitionSource;

export interface FactoryDefinitionPageReference extends ImmutableObjectReference {
  readonly index: number;
}

export interface FactoryManifestPage {
  readonly schemaVersion: "factory.manifest-page.v1";
  readonly definitionDigest: string;
  readonly definitionEncodedBytes: number;
  readonly self: ImmutableObjectReference;
  readonly pages: readonly FactoryDefinitionPageReference[];
  readonly next?: ImmutableObjectReference;
}

export interface FactoryDefinitionPage {
  readonly index: number;
  readonly objectId: string;
  readonly digest: string;
  readonly content: string;
}

export interface FactoryIdentity {
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalRunId: string;
  readonly interpreterId: string;
}

export interface FactoryWorkflowInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalRunId: string;
  readonly interpreterId: string;
  readonly startedAtMs: number;
  readonly deadlineAtMs?: number;
  readonly definition: FactoryPlanSource;
  readonly input: JsonValue;
  readonly continuation?: FactoryContinuation;
}

export interface FactoryContinuation {
  readonly state: KernelState;
  readonly inbox: readonly KernelEvent[];
  readonly pendingInbox: readonly FactoryInboxEnvelope[];
  readonly sourceSequence: number;
  readonly handledSinceContinuation: number;
  readonly acknowledgedInboxSequence: number;
}

export interface FactoryInboxEnvelope {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventHash: string;
  readonly event: KernelEvent;
}

export interface FactoryInboxReceipt {
  readonly acknowledgedSequence: number;
  readonly pending: readonly Pick<FactoryInboxEnvelope, "sequence" | "eventId" | "eventHash">[];
}

export interface FactoryWorkflowResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly output?: JsonValue;
  readonly error?: string;
  readonly state: KernelState;
}

export interface TransitionPageRequest extends FactoryIdentity {
  readonly sourceSequence: number;
  readonly index: number;
  readonly content: string;
  readonly encodedBytes: number;
}

export interface TransitionPageReference extends ImmutableObjectReference {
  readonly index: number;
}

export interface TransitionArtifactRequest extends FactoryIdentity {
  readonly sourceSequence: number;
  readonly encodedBytes: number;
  readonly eventId: string;
  readonly expectedEventHash?: string;
  readonly pages: readonly TransitionPageReference[];
}

export interface FinalizedTransitionArtifact {
  readonly manifest: ImmutableObjectReference;
  readonly eventHash: string;
}

/** Compact product audit fact committed only after immutable transition pages finalize. */
export interface TransitionRecord extends FactoryIdentity {
  readonly sourceSequence: number;
  readonly eventId: string;
  readonly eventHash: string;
  readonly inboxSequence?: number;
  readonly artifactManifest: ImmutableObjectReference;
}

export interface TransitionArtifact extends FactoryIdentity {
  readonly schemaVersion: "factory.transition.v1";
  readonly sourceSequence: number;
  readonly event: KernelEvent;
  readonly nextState: KernelState;
  readonly commands: readonly KernelCommand[];
}

export interface CommandExecution {
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalRunId: string;
  readonly interpreterId: string;
  readonly command: Exclude<KernelCommand, { readonly kind: "run-child" | "start-timer" | "complete-run" | "complete-partition" | "fail-run" | "cancel-run" }>;
}

export interface FactoryActivities {
  stageTransitionPage(request: TransitionPageRequest): Promise<TransitionPageReference>;
  finalizeTransitionArtifact(request: TransitionArtifactRequest): Promise<FinalizedTransitionArtifact>;
  recordTransition(record: TransitionRecord): Promise<void>;
  executeCommand(execution: CommandExecution): Promise<KernelEvent | null>;
  resolveFactory(request: FactoryIdentity & { readonly factory: Extract<KernelCommand, { readonly kind: "run-child" }>["factory"] }): Promise<FactoryDefinitionSource>;
  loadManifestPage(request: FactoryIdentity & { readonly definition: FactoryDefinitionSource; readonly page: ImmutableObjectReference }): Promise<FactoryManifestPage>;
  loadDefinitionPage(request: FactoryIdentity & { readonly definitionDigest: string; readonly page: FactoryDefinitionPageReference }): Promise<FactoryDefinitionPage>;
  loadExecutionManifest(request: FactoryIdentity & { readonly definitionDigest: string; readonly manifest: ImmutableObjectReference }): Promise<CompiledExecutionManifest>;
  loadPartitionArtifact(request: FactoryIdentity & { readonly definitionDigest: string; readonly partition: FactoryPartitionReference }): Promise<CompiledPartitionArtifact>;
}
