export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const FACTORY_SCHEMA_VERSION = "factory.v1" as const;
export const FACTORY_IR_SCHEMA_VERSION = "factory.ir.v1" as const;
export const FACTORY_RUNNER_REQUEST_SCHEMA_VERSION = "factory.runner.request.v1" as const;
export const FACTORY_RUNNER_RESULT_SCHEMA_VERSION = "factory.runner.result.v1" as const;
export const FACTORY_PARTITION_SCHEMA_VERSION = "factory.partition.v1" as const;
export const FACTORY_EXECUTION_MANIFEST_SCHEMA_VERSION = "factory.execution-manifest.v1" as const;
export const FACTORY_LIMITS = Object.freeze({
  maxDefinitionBytes: 16 * 1024 * 1024,
  maxInlineValueBytes: 64 * 1024,
  maxExpandedNodes: 10_000,
  maxScopeDepth: 16,
  maxPartitionNodes: 128,
  maxRecordedPageBytes: 32 * 1024,
  maxConcurrentActivities: 32,
  maxExpressionNodes: 256,
  maxExpressionDepth: 16,
  maxExpressionSteps: 1_024,
  maxJsonDepth: 64,
  defaultRunDeadlineMs: 7 * 24 * 60 * 60 * 1_000,
  maximumRunDeadlineMs: 30 * 24 * 60 * 60 * 1_000,
  defaultNodeDeadlineMs: 30 * 60 * 1_000,
  maximumNodeDeadlineMs: 24 * 60 * 60 * 1_000,
  maximumApprovalWaitMs: 24 * 60 * 60 * 1_000,
  maxWireBytes: 64 * 1024,
});

export type PortSchemaType =
  | "array"
  | "boolean"
  | "integer"
  | "null"
  | "number"
  | "object"
  | "string";

export interface PortSchema {
  readonly type?: PortSchemaType | readonly [Exclude<PortSchemaType, "null">, "null"];
  readonly properties?: Readonly<Record<string, PortSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: PortSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly enum?: readonly JsonValue[];
  readonly const?: JsonValue;
  readonly $defs?: Readonly<Record<string, PortSchema>>;
  readonly $ref?: string;
  readonly title?: string;
  readonly description?: string;
}

export type ReferenceRoot = "input" | "node" | "map" | "loop";
export type ReferencePathSegment = string | number;

export interface ValueReference {
  readonly kind: "ref";
  readonly root: ReferenceRoot;
  readonly name: string;
  readonly path?: readonly ReferencePathSegment[];
}

export interface LiteralValue {
  readonly kind: "literal";
  readonly value: JsonValue;
}

export type ValueSource = ValueReference | LiteralValue;

export type Expression =
  | LiteralExpression
  | ValueReference
  | ExistsExpression
  | BinaryExpression
  | NotExpression
  | BooleanExpression
  | InExpression
  | LengthExpression;

export interface LiteralExpression extends LiteralValue {}
export interface ExistsExpression {
  readonly kind: "exists";
  readonly value: ValueReference;
}
export interface BinaryExpression {
  readonly kind: "eq" | "lt" | "lte" | "gt" | "gte";
  readonly left: Expression;
  readonly right: Expression;
}
export interface NotExpression {
  readonly kind: "not";
  readonly value: Expression;
}
export interface BooleanExpression {
  readonly kind: "and" | "or";
  readonly values: readonly Expression[];
}
export interface InExpression {
  readonly kind: "in";
  readonly value: Expression;
  readonly collection: Expression;
}
export interface LengthExpression {
  readonly kind: "length";
  readonly value: Expression;
}

export type Effect = "none" | "read" | "write" | "publish";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
}

export interface BudgetBounds {
  readonly maxCostMicros?: string;
  readonly maxTokens?: number;
  readonly maxComputeMs?: number;
}

export interface ResourceBounds extends BudgetBounds {
  readonly resourceClass?: string;
  readonly memoryBytes?: number;
}

export interface RunnerReference {
  readonly package: string;
  readonly version: string;
  readonly digest: string;
  readonly export: string;
  readonly model?: string;
  readonly configurationDigest?: string;
}

export interface FactoryReference {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface PackageReference {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
}

export interface FactoryGraph {
  readonly nodes: readonly FactoryNode[];
  readonly outputs: Readonly<Record<string, ValueSource>>;
}

export interface BaseNode {
  readonly id: string;
  readonly inputPorts?: Readonly<Record<string, PortSchema>>;
  readonly outputPorts?: Readonly<Record<string, PortSchema>>;
  readonly bindings?: Readonly<Record<string, ValueSource>>;
  readonly dependsOn?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly effects?: readonly Effect[];
  readonly deadlineMs?: number;
  readonly retry?: RetryPolicy;
  readonly resources?: ResourceBounds;
}

export interface TaskNode extends BaseNode {
  readonly kind: "task";
  readonly runner: RunnerReference;
  readonly maxIterations?: number;
}

export interface BranchNode extends BaseNode {
  readonly kind: "branch";
  readonly condition: Expression;
  readonly then: FactoryGraph;
  readonly else: FactoryGraph;
}

export type JoinOutcome = "succeeded" | "failed" | "skipped" | "cancelled";
export interface JoinNode extends BaseNode {
  readonly kind: "join";
  readonly mode: "all" | "any" | "quorum";
  readonly predecessors: readonly string[];
  readonly eligibleOutcomes?: readonly JoinOutcome[];
  readonly quorum?: number;
}

export interface MapNode extends BaseNode {
  readonly kind: "map";
  readonly collection: ValueSource;
  readonly itemSchema: PortSchema;
  readonly body: FactoryGraph;
  readonly mode: "all" | "collect";
  readonly maxItems: number;
  readonly maxConcurrency: number;
}

export interface LoopNode extends BaseNode {
  readonly kind: "loop";
  readonly initialInput: ValueSource;
  readonly carriedSchema: PortSchema;
  readonly resultSchema: PortSchema;
  readonly body: FactoryGraph;
  readonly until: Expression;
  readonly nextInput: Expression;
  readonly maxIterations: number;
  readonly maxElapsedMs: number;
  readonly budget?: BudgetBounds;
  readonly onExhausted: "fail" | "escalate";
}

export interface SubfactoryNode extends BaseNode {
  readonly kind: "subfactory";
  readonly factory: FactoryReference;
  readonly releaseMode: "none" | "authorized";
  readonly grants: readonly string[];
}

export interface ApprovalNode extends BaseNode {
  readonly kind: "approval";
  readonly choices: readonly string[];
  readonly context: ValueSource;
  readonly actorScope: string;
  readonly expiresInMs: number;
  readonly onDenied: "fail" | "escalate";
  readonly onExpired: "fail" | "escalate";
}

export interface AcceptanceNode extends BaseNode {
  readonly kind: "acceptance";
  readonly contract: string;
  readonly candidate: ValueSource;
  readonly evidence: ValueSource;
  readonly maxRepairs?: number;
}

export interface ReleaseNode extends BaseNode {
  readonly kind: "release";
  readonly adapter: RunnerReference;
  readonly acceptedCandidate: ValueSource;
  readonly destination: ValueSource;
}

export type FactoryNode =
  | TaskNode
  | BranchNode
  | JoinNode
  | MapNode
  | LoopNode
  | SubfactoryNode
  | ApprovalNode
  | AcceptanceNode
  | ReleaseNode;

export interface AcceptanceClaim {
  readonly id: string;
  readonly validator: RunnerReference;
  readonly required: boolean;
  readonly freshnessMs?: number;
  readonly protected: boolean;
}

export interface AcceptanceGroup {
  readonly id: string;
  readonly claimIds: readonly string[];
  readonly minimumPasses: number;
  readonly requireAllDecisive: boolean;
}

export interface AcceptanceContract {
  readonly id: string;
  readonly version: string;
  readonly claims: readonly AcceptanceClaim[];
  readonly groups?: readonly AcceptanceGroup[];
}

export interface FactoryBounds {
  readonly runDeadlineMs?: number;
  readonly maxExpandedNodes: number;
  readonly maxScopeDepth: number;
}

export interface FactoryDefinition {
  readonly schemaVersion: "factory.v1";
  readonly id: string;
  readonly version: string;
  readonly interpreterCompatibility: string;
  readonly inputPorts: Readonly<Record<string, PortSchema>>;
  readonly outputPorts: Readonly<Record<string, PortSchema>>;
  readonly graph: FactoryGraph;
  readonly acceptance: AcceptanceContract;
  readonly packages: readonly PackageReference[];
  readonly factories?: readonly FactoryReference[];
  readonly capabilities: readonly string[];
  readonly effects: readonly Effect[];
  readonly bounds: FactoryBounds;
  readonly presentation?: Readonly<Record<string, JsonValue>>;
}

export interface DependencyLock {
  readonly packages: readonly PackageReference[];
  readonly factories: readonly FactoryReference[];
  readonly interpreter: string;
}

export interface CompiledIndexes {
  readonly nodeById: Readonly<Record<string, FactoryNode>>;
  readonly successors: Readonly<Record<string, readonly string[]>>;
  readonly dependencyCounts: Readonly<Record<string, number>>;
}

export interface CompiledPartition {
  readonly id: string;
  readonly nodeIds: readonly string[];
  readonly dependsOn: readonly string[];
  readonly inbound: readonly CompiledPartitionInboundEdge[];
  readonly outbound: readonly CompiledPartitionOutboundEdge[];
  /** Canonical bytes of the partition manifest and its full node records. */
  readonly encodedBytes: number;
  readonly digest: string;
}

export interface CompiledPartitionInboundEdge {
  /** Node in this partition whose local dependency counter is released. */
  readonly nodeId: string;
  readonly fromNodeId: string;
  readonly fromPartitionId: string;
}

export interface CompiledPartitionOutboundEdge {
  /** Node in this partition whose fenced completion is sent immediately. */
  readonly nodeId: string;
  readonly toNodeId: string;
  readonly toPartitionId: string;
}

export interface CompiledPage {
  readonly id: string;
  readonly partitionId: string;
  readonly nodeIds: readonly string[];
  readonly encodedBytes: number;
  readonly digest: string;
}

/** Exact recorded payload loaded for one interpreter partition. */
export interface CompiledPartitionArtifact {
  readonly schemaVersion: "factory.partition.v1";
  readonly factoryDigest: string;
  readonly id: string;
  readonly nodeIds: readonly string[];
  readonly dependsOn: readonly string[];
  readonly inbound: readonly CompiledPartitionInboundEdge[];
  readonly outbound: readonly CompiledPartitionOutboundEdge[];
  readonly nodes: readonly FactoryNode[];
}

export interface CompiledExecutionBounds {
  readonly runDeadlineMs: number;
  readonly maxExpandedNodes: number;
  readonly maxScopeDepth: number;
}

/** Bounded root metadata loaded separately from a partition's node page. */
export interface CompiledExecutionManifest {
  readonly schemaVersion: "factory.execution-manifest.v1";
  readonly factoryDigest: string;
  readonly inputPorts: Readonly<Record<string, PortSchema>>;
  readonly outputPorts: Readonly<Record<string, PortSchema>>;
  readonly bounds: CompiledExecutionBounds;
  readonly outputs: Readonly<Record<string, ValueSource>>;
}

export interface CompiledArtifactDescriptor {
  readonly encodedBytes: number;
  readonly digest: string;
}

export interface CompiledFactory {
  readonly schemaVersion: "factory.ir.v1";
  readonly digest: string;
  readonly presentationDigest?: string;
  readonly definition: FactoryDefinition;
  readonly lock: DependencyLock;
  readonly indexes: CompiledIndexes;
  readonly executionManifest: CompiledArtifactDescriptor;
  readonly partitions: readonly CompiledPartition[];
  readonly pages: readonly CompiledPage[];
}

/** Opaque, immutable object reference. Ownership is resolved by the gateway. */
export interface FactoryArtifactReference {
  readonly artifactId: string;
  readonly digest: string;
  readonly encodedBytes: number;
}

export interface FactoryCheckpointReference extends FactoryArtifactReference {
  readonly journalCursor: number;
}

export type FactoryTransportValue =
  | { readonly kind: "inline"; readonly value: JsonValue }
  | { readonly kind: "artifact"; readonly artifact: FactoryArtifactReference };

/** Authority carried by the signed attempt token and checked on every effect. */
export interface FactoryRunnerAuthority {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly attemptNumber: number;
  readonly grantRevision: number;
  readonly reservationGeneration: number;
  readonly executionEpoch: number;
  readonly cancellationEpoch: number;
  readonly deadlineAtMs: number;
  readonly nextOperationIndex: number;
}

export interface FactoryModelPin {
  readonly provider: string;
  readonly model: string;
  readonly configurationDigest: string;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly policyDigest: string;
  readonly policy: Readonly<Record<string, JsonValue>>;
}

export interface FactoryToolDeclaration {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: PortSchema;
  readonly outputSchema?: PortSchema;
}

export interface FactoryBrokerTransport {
  readonly attemptToken: string;
  readonly audience: string;
}

export interface FactoryRunnerRequest {
  readonly schemaVersion: "factory.runner.request.v1";
  readonly authority: FactoryRunnerAuthority;
  readonly runner: RunnerReference;
  readonly input: FactoryTransportValue;
  readonly grants: readonly string[];
  readonly resources: ResourceBounds;
  readonly model?: FactoryModelPin;
  readonly tools: readonly FactoryToolDeclaration[];
  readonly broker: FactoryBrokerTransport;
  readonly checkpoint?: FactoryCheckpointReference;
}

export interface FactoryMeasuredUsage {
  readonly kind: "measured";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly computeMs: number;
  readonly costMicros: string;
}

export interface FactoryUnknownUsage {
  readonly kind: "unknown";
  readonly reason: string;
  readonly heldCostMicros: string;
}

export type FactoryUsage = FactoryMeasuredUsage | FactoryUnknownUsage;

export interface FactoryRunnerOperationBase {
  readonly operationId: string;
  readonly operationIndex: number;
  readonly kind: "model" | "tool";
  readonly requestDigest: string;
}

export type FactoryRunnerOperationResult =
  | (FactoryRunnerOperationBase & {
    readonly state: "completed";
    readonly resultDigest: string;
    readonly providerReceiptDigest?: string;
    readonly usage: FactoryMeasuredUsage;
    readonly workspaceCheckpoint: FactoryCheckpointReference;
  })
  | (FactoryRunnerOperationBase & {
    readonly state: "failed";
    readonly resultDigest: string;
    readonly providerReceiptDigest?: string;
    readonly usage?: FactoryUsage;
    readonly workspaceCheckpoint?: FactoryCheckpointReference;
  })
  | (FactoryRunnerOperationBase & {
    readonly state: "uncertain";
    readonly providerReceiptDigest: string;
    readonly resultDigest?: string;
    readonly usage: FactoryUnknownUsage;
    readonly workspaceCheckpoint?: FactoryCheckpointReference;
  });

interface FactoryRunnerResultBase {
  readonly schemaVersion: "factory.runner.result.v1";
  readonly journalCursor: number;
  readonly operations: readonly FactoryRunnerOperationResult[];
}

export type FactoryRunnerResult =
  | (FactoryRunnerResultBase & {
    readonly status: "completed";
    readonly resultDigest: string;
    readonly output: FactoryArtifactReference;
    readonly usage: FactoryMeasuredUsage;
    readonly workspaceCheckpoint: FactoryCheckpointReference;
  })
  | (FactoryRunnerResultBase & {
    readonly status: "failed";
    readonly resultDigest: string;
    readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
    readonly usage?: FactoryUsage;
    readonly workspaceCheckpoint?: FactoryCheckpointReference;
  })
  | (FactoryRunnerResultBase & {
    readonly status: "cancelled";
    readonly usage?: FactoryUsage;
    readonly workspaceCheckpoint?: FactoryCheckpointReference;
  })
  | (FactoryRunnerResultBase & {
    readonly status: "uncertain";
    readonly providerReceiptDigest: string;
    readonly resultDigest?: string;
    readonly usage: FactoryUnknownUsage;
    readonly workspaceCheckpoint?: FactoryCheckpointReference;
  });

export interface CompilerDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly nodeId?: string;
}

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: readonly (string | number)[];
}

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export interface ExpressionContext {
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly nodes: Readonly<Record<string, JsonValue>>;
  readonly map?: Readonly<Record<string, JsonValue>>;
  readonly loop?: Readonly<Record<string, JsonValue>>;
}

export type ExpressionResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type CompileResult =
  | { readonly ok: true; readonly factory: CompiledFactory }
  | { readonly ok: false; readonly diagnostics: readonly CompilerDiagnostic[] };
