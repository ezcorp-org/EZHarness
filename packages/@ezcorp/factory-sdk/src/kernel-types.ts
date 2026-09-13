import type { FactoryReference, JsonValue } from "./types";

/** Runtime status for one expanded node instance. */
export type KernelNodeStatus =
  | "blocked"
  | "ready"
  | "reserved"
  | "running"
  | "waiting"
  | "retry_wait"
  | "stopping"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type KernelRunStatus =
  | "created"
  | "running"
  | "waiting"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled";

/** Backward-compatible public names for the C07 state vocabularies. */
export type NodeState = KernelNodeStatus;
export type RunState = KernelRunStatus;

export type FailureKind =
  | "execution"
  | "output_invalid"
  | "deadline"
  | "cancelled"
  | "admission_denied"
  | "approval_denied"
  | "approval_expired"
  | "acceptance_rejected"
  | "release_uncertain"
  | "bound_exhausted";

export interface KernelAttempt {
  readonly candidateGeneration: number;
  readonly attempt: number;
  readonly commandId: string;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly stopped: boolean;
  readonly uncertain: boolean;
}

export interface KernelNodeState {
  readonly status: KernelNodeStatus;
  readonly candidateGeneration: number;
  readonly nextAttempt: number;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly attempts: readonly KernelAttempt[];
  readonly selected?: "then" | "else";
  readonly waitingReason?: "approval" | "admission" | "remediation" | "external_reconciliation";
  readonly waitingDeadlineAtMs?: number;
  /** Persistent control facts; never reset by task retry or continuation. */
  readonly map?: {
    readonly snapshot: readonly JsonValue[];
    readonly itemCount: number;
    readonly completedIndexes: readonly number[];
    readonly failedIndexes: readonly number[];
    readonly outcomes: readonly (JsonValue | { readonly error: string } | undefined)[];
  };
  readonly loop?: { readonly iteration: number; readonly carried: JsonValue; readonly startedAtMs: number; readonly spentCostMicros: string; readonly unknownCostMicros: string };
}

export interface KernelScopeState {
  readonly id: string;
  readonly parentNodeId?: string;
  readonly depth: number;
  readonly selectedBranch?: "then" | "else";
  readonly expandedNodeCount: number;
  readonly spentCostMicros: string;
  readonly unknownCostMicros: string;
  readonly nodeIds: readonly string[];
  readonly roots: readonly string[];
}

export type NodeRuntimeState = KernelNodeState;

export interface KernelState {
  readonly logicalRunId: string;
  /** Immutable compiled-plan digest. The plan is passed to every kernel call. */
  readonly definitionDigest: string;
  readonly input: JsonValue;
  readonly status: KernelRunStatus;
  readonly runDeadlineAtMs: number;
  readonly nowMs: number;
  readonly cancellationEpoch: number;
  readonly commandCounter: number;
  readonly eventSequence: number;
  readonly spentCostMicros: string;
  readonly unknownCostMicros: string;
  readonly nodes: Readonly<Record<string, KernelNodeState>>;
  readonly scopes: Readonly<Record<string, KernelScopeState>>;
  readonly appliedEventIds: readonly string[];
  readonly unresolvedUncertainNodeIds: readonly string[];
}

export interface KernelEventBase {
  readonly id: string;
  readonly atMs: number;
}

export type KernelEvent =
  | (KernelEventBase & { readonly kind: "start" })
  | (KernelEventBase & {
      readonly kind: "admission-result";
      readonly nodeId: string;
      readonly commandId: string;
      readonly candidateGeneration: number;
      readonly granted: boolean;
    })
  | (KernelEventBase & {
      readonly kind: "node-result";
      readonly nodeId: string;
      readonly commandId: string;
      readonly candidateGeneration: number;
      readonly attempt: number;
      readonly output: JsonValue;
    })
  | (KernelEventBase & {
      readonly kind: "node-failed";
      readonly nodeId: string;
      readonly commandId: string;
      readonly candidateGeneration: number;
      readonly attempt: number;
      readonly error: string;
      readonly failureKind?: FailureKind;
    })
  | (KernelEventBase & {
      readonly kind: "attempt-stopped";
      readonly nodeId: string;
      readonly commandId: string;
      readonly candidateGeneration: number;
      readonly attempt: number;
      readonly uncertain?: boolean;
    })
  | (KernelEventBase & {
      readonly kind: "usage-settled";
      readonly nodeId: string;
      readonly knownCostMicros: string;
      readonly unknownCostMicros?: string;
    })
  | (KernelEventBase & {
      readonly kind: "approval-decided";
      readonly nodeId: string;
      readonly commandId: string;
      readonly choice: string;
    })
  | (KernelEventBase & {
      readonly kind: "timer-expired";
      readonly nodeId?: string;
      readonly commandId?: string;
    })
  | (KernelEventBase & {
      readonly kind: "repair";
      readonly nodeId: string;
      readonly reason: string;
    })
  | (KernelEventBase & { readonly kind: "cancel"; readonly reason: string });

export type KernelCommand =
  | {
      readonly kind: "request-admission";
      readonly id: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly deadlineAtMs: number;
    }
  | {
      readonly kind: "dispatch-node";
      readonly id: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly attempt: number;
      readonly input: JsonValue;
      readonly deadlineAtMs: number;
      readonly cancellationEpoch: number;
    }
  | {
      readonly kind: "run-child";
      readonly id: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly factory: FactoryReference;
      readonly input: JsonValue;
      readonly deadlineAtMs: number;
    }
  | {
      readonly kind: "request-approval";
      readonly id: string;
      readonly nodeId: string;
      readonly choices: readonly string[];
      readonly context: JsonValue;
      readonly actorScope: string;
      readonly deadlineAtMs: number;
    }
  | {
      readonly kind: "request-acceptance";
      readonly id: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly candidate: JsonValue;
      readonly evidence: JsonValue;
      readonly deadlineAtMs: number;
    }
  | {
      readonly kind: "request-release";
      readonly id: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly input: JsonValue;
      readonly deadlineAtMs: number;
    }
  | {
      readonly kind: "start-timer";
      readonly id: string;
      readonly nodeId?: string;
      readonly deadlineAtMs: number;
    }
  | {
      readonly kind: "cancel-node";
      readonly id: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly attempt: number;
      /** The original dispatch/child command fenced by this stop request. */
      readonly attemptCommandId: string;
      readonly cancellationEpoch: number;
    }
  | { readonly kind: "complete-run"; readonly id: string; readonly output: JsonValue }
  | { readonly kind: "fail-run"; readonly id: string; readonly error: string }
  | { readonly kind: "cancel-run"; readonly id: string; readonly reason: string };

export interface AdvanceResult {
  readonly nextState: KernelState;
  readonly commands: readonly KernelCommand[];
}
