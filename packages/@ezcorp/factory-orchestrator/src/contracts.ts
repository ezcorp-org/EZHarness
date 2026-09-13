import type { JsonValue } from "@ezcorp/factory-sdk";
import type { KernelCommand, KernelEvent, KernelState } from "@ezcorp/factory-sdk/kernel-types";

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
  readonly definition: FactoryDefinitionSource;
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

export interface TransitionRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalRunId: string;
  readonly interpreterId: string;
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
  readonly command: Exclude<KernelCommand, { readonly kind: "run-child" | "start-timer" | "complete-run" | "fail-run" | "cancel-run" }>;
}

export interface FactoryActivities {
  recordTransition(record: TransitionRecord): Promise<void>;
  executeCommand(execution: CommandExecution): Promise<KernelEvent | null>;
  resolveFactory(request: FactoryIdentity & { readonly factory: Extract<KernelCommand, { readonly kind: "run-child" }>["factory"] }): Promise<FactoryDefinitionSource>;
  loadManifestPage(request: FactoryIdentity & { readonly definition: FactoryDefinitionSource; readonly page: ImmutableObjectReference }): Promise<FactoryManifestPage>;
  loadDefinitionPage(request: FactoryIdentity & { readonly definitionDigest: string; readonly page: FactoryDefinitionPageReference }): Promise<FactoryDefinitionPage>;
}

export interface FactoryTransportCommand {
  readonly commandId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalRunId: string;
  readonly workflowId: string;
  readonly kind: "start_run" | "decision" | "partition_notification";
  readonly interpreterId?: string;
  readonly eventId?: string;
  readonly eventSequence?: number;
  readonly eventHash?: string;
  readonly body: JsonValue;
}

export interface ClaimedFactoryCommand {
  readonly claimToken: string;
  readonly command: FactoryTransportCommand;
}

export interface FactoryCommandQueue {
  claim(): Promise<ClaimedFactoryCommand | null>;
  settle(claim: ClaimedFactoryCommand, outcome: "delivered" | "retry" | "outcome_unknown", errorCode?: string): Promise<void>;
  /** Exact immutable product-inbox tombstone lookup for an already applied decision. */
  confirmInboxIdentity?(command: FactoryTransportCommand): Promise<boolean>;
}
