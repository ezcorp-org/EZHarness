import type { CompiledFactory, JsonValue } from "@ezcorp/factory-sdk";
import type { KernelCommand, KernelEvent, KernelState } from "@ezcorp/factory-sdk/kernel-types";

export const FACTORY_WORKFLOW_TYPE = "factoryWorkflow";
export const FACTORY_INBOX_SIGNAL = "factoryInbox";
export const FACTORY_STATE_QUERY = "factoryState";
export const FACTORY_TASK_QUEUE = "factory-orchestrator";
export const MAX_INBOX_EVENTS = 128;
export const CONTINUE_AFTER_EVENTS = 64;

export interface FactoryWorkflowInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalRunId: string;
  readonly interpreterId: string;
  readonly startedAtMs: number;
  readonly factory: CompiledFactory;
  readonly input: JsonValue;
  readonly continuation?: FactoryContinuation;
}

export interface FactoryContinuation {
  readonly state: KernelState;
  readonly inbox: readonly KernelEvent[];
  readonly sourceSequence: number;
  readonly handledSinceContinuation: number;
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
  loadFactory(reference: Extract<KernelCommand, { readonly kind: "run-child" }>["factory"]): Promise<CompiledFactory>;
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
  readonly body: JsonValue;
}

export interface ClaimedFactoryCommand {
  readonly claimToken: string;
  readonly command: FactoryTransportCommand;
}

export interface FactoryCommandQueue {
  claim(): Promise<ClaimedFactoryCommand | null>;
  settle(claim: ClaimedFactoryCommand, outcome: "delivered" | "retry" | "outcome_unknown", errorCode?: string): Promise<void>;
}
