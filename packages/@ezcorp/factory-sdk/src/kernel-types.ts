import type { CompiledPartition, FactoryBounds, FactoryGraph, FactoryReference, JsonValue, PortSchema } from "./types.js";

/** Minimum immutable plan surface used by the deterministic execution kernel. */
export interface KernelFactoryPlan {
  readonly digest: string;
  readonly definition: {
    readonly inputPorts: Readonly<Record<string, PortSchema>>;
    readonly outputPorts: Readonly<Record<string, PortSchema>>;
    readonly bounds: FactoryBounds;
    readonly graph: FactoryGraph;
  };
  readonly indexes: {
    readonly successors: Readonly<Record<string, readonly string[]>>;
  };
  readonly partitions: readonly CompiledPartition[];
}

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
  readonly terminalSequence?: number;
  readonly discarded?: boolean;
  /** Failure belongs to an explicit collecting map or qualifying join. */
  readonly failureHandled?: boolean;
  /** Exact node input sealed for this repaired candidate. */
  readonly inputOverride?: JsonValue;
  /** Exact published child revision sealed for this replanned candidate. */
  readonly factoryOverride?: FactoryReference;
  readonly priorCandidates?: readonly {
    readonly candidateGeneration: number;
    readonly status: KernelNodeStatus;
    readonly output?: JsonValue;
    readonly error?: string;
    readonly inputOverride?: JsonValue;
    readonly factoryOverride?: FactoryReference;
  }[];
  readonly attempts: readonly KernelAttempt[];
  readonly selected?: "then" | "else";
  readonly waitingReason?: "approval" | "admission" | "remediation" | "external_reconciliation";
  readonly waitingDeadlineAtMs?: number;
  readonly timer?: { readonly id: string; readonly deadlineAtMs: number; readonly purpose: "deadline" | "retry" };
  /** Persistent control facts; never reset by task retry or continuation. */
  readonly map?: {
    /** Current bounded artifact page or the complete inline collection. */
    readonly snapshot: readonly JsonValue[];
    readonly itemCount: number;
    readonly pageOffset?: number;
    readonly nextCursor?: number;
    readonly lazy?: { readonly name: string; readonly artifact: import("./types.js").FactoryArtifactReference; readonly path: readonly import("./types.js").ReferencePathSegment[]; readonly storageVersion?: string };
    readonly completedIndexes: readonly number[];
    readonly failedIndexes: readonly number[];
    readonly outcomes: Readonly<Record<string, JsonValue>>;
    /** A release attempt in an evicted item makes the containing map non-repairable. */
    readonly protectedEffectStarted?: boolean;
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
  /** Explicit transport descriptor; it is never merged into input. */
  readonly durableInput?: import("./types.js").FactoryDurableInput;
  readonly lazyInput?: {
    readonly versions: Readonly<Record<string, string>>;
    readonly values: Readonly<Record<string, JsonValue>>;
    readonly pending: Readonly<Record<string, { readonly kind: "value" | "page"; readonly nodeId: string; readonly candidateGeneration: number; readonly cancellationEpoch: number; readonly name: string; readonly artifact: import("./types.js").FactoryArtifactReference; readonly path: readonly import("./types.js").ReferencePathSegment[]; readonly cursor?: number; readonly maxItems?: number; readonly maxBytes: number; readonly expectedStorageVersion?: string }>>;
  };
  readonly status: KernelRunStatus;
  readonly runDeadlineAtMs: number;
  readonly runTimerId?: string;
  readonly stopReason?: string;
  readonly stopKind?: "failed" | "cancelled" | "completed";
  readonly nowMs: number;
  readonly cancellationEpoch: number;
  readonly commandCounter: number;
  readonly eventSequence: number;
  readonly spentCostMicros: string;
  readonly unknownCostMicros: string;
  readonly usageSettlements: Readonly<Record<string, { readonly nodeId: string; readonly revision: number; readonly knownCostMicros: string; readonly unknownCostMicros: string }>>;
  readonly nodes: Readonly<Record<string, KernelNodeState>>;
  readonly scopes: Readonly<Record<string, KernelScopeState>>;
  readonly appliedEventIds: readonly string[];
  readonly unresolvedUncertainNodeIds: readonly string[];
  readonly pendingRepair?: {
    readonly rootNodeId: string;
    readonly nodeIds: readonly string[];
    readonly aggregateIds: readonly string[];
    readonly reason: string;
    readonly priorInput?: JsonValue;
    readonly inputOverride?: JsonValue;
    readonly priorFactory?: FactoryReference;
    readonly factoryOverride?: FactoryReference;
    readonly awaitDependencies?: boolean;
  };
  readonly partition?: {
    readonly id: string;
    readonly completedEdges: Readonly<Record<string, string>>;
    readonly invalidatedEdges: Readonly<Record<string, { readonly candidateGeneration: number; readonly eventId: string }>>;
    readonly externalOutputs: Readonly<Record<string, {
      readonly status: "succeeded" | "failed" | "skipped" | "cancelled";
      readonly output?: JsonValue;
      readonly error?: string;
      readonly candidateGeneration: number;
      readonly terminalSequence: number;
    }>>;
  };
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
      readonly commandId: string;
      readonly candidateGeneration: number;
      readonly attempt: number;
      readonly revision: number;
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
      readonly kind: "input-value-read";
      readonly commandId: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly cancellationEpoch: number;
      readonly name: string;
      readonly artifact: import("./types.js").FactoryArtifactReference;
      readonly path: readonly import("./types.js").ReferencePathSegment[];
      readonly storageVersion: string;
      readonly mediaType: "application/json";
      readonly value: JsonValue;
    })
  | (KernelEventBase & {
      readonly kind: "input-page-read";
      readonly commandId: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly cancellationEpoch: number;
      readonly name: string;
      readonly artifact: import("./types.js").FactoryArtifactReference;
      readonly path: readonly import("./types.js").ReferencePathSegment[];
      readonly storageVersion: string;
      readonly mediaType: "application/json";
      readonly cursor: number;
      readonly maxItems: number;
      readonly items: readonly JsonValue[];
      readonly nextCursor?: number;
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
      readonly inputOverride?: JsonValue;
    })
  | (KernelEventBase & {
      readonly kind: "replan";
      readonly nodeId: string;
      readonly reason: string;
      readonly replacement: FactoryReference;
      readonly inputOverride?: JsonValue;
    })
  | (KernelEventBase & {
      readonly kind: "partition-source-invalidated";
      readonly sourcePartitionId: string;
      readonly targetPartitionId: string;
      readonly sourceNodeId: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
    })
  | (KernelEventBase & {
      readonly kind: "partition-node-completed";
      readonly sourcePartitionId: string;
      readonly targetPartitionId: string;
      readonly sourceNodeId: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly terminalSequence: number;
      readonly outcome: "succeeded" | "failed" | "skipped" | "cancelled";
      readonly output?: JsonValue;
      readonly error?: string;
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
      /** Child readers re-authorize against the child lifecycle, never the parent. */
      readonly durableInput?: import("./types.js").FactoryDurableInput;
      readonly deadlineAtMs: number;
    }
  | {
      readonly kind: "read-input-value";
      readonly id: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly cancellationEpoch: number;
      readonly name: string;
      readonly artifact: import("./types.js").FactoryArtifactReference;
      readonly path: readonly import("./types.js").ReferencePathSegment[];
      readonly maxBytes: number;
      readonly expectedStorageVersion?: string;
    }
  | {
      readonly kind: "read-input-page";
      readonly id: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly cancellationEpoch: number;
      readonly name: string;
      readonly artifact: import("./types.js").FactoryArtifactReference;
      readonly path: readonly import("./types.js").ReferencePathSegment[];
      readonly cursor: number;
      readonly maxItems: number;
      readonly maxBytes: number;
      readonly expectedStorageVersion?: string;
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
      readonly kind: "invalidate-partition";
      readonly id: string;
      readonly sourcePartitionId: string;
      readonly targetPartitionId: string;
      readonly sourceNodeId: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
    }
  | {
      readonly kind: "notify-partition";
      readonly id: string;
      readonly sourcePartitionId: string;
      readonly targetPartitionId: string;
      readonly sourceNodeId: string;
      readonly nodeId: string;
      readonly candidateGeneration: number;
      readonly terminalSequence: number;
      readonly outcome: "succeeded" | "failed" | "skipped" | "cancelled";
      readonly output?: JsonValue;
      readonly error?: string;
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
  | { readonly kind: "complete-partition"; readonly id: string; readonly partitionId: string }
  | { readonly kind: "fail-run"; readonly id: string; readonly error: string }
  | { readonly kind: "cancel-run"; readonly id: string; readonly reason: string };

export interface AdvanceResult {
  readonly nextState: KernelState;
  readonly commands: readonly KernelCommand[];
}
