export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

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
  readonly maxCostMicros?: number;
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

export interface AcceptanceContract {
  readonly id: string;
  readonly version: string;
  readonly claims: readonly AcceptanceClaim[];
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
}

export interface CompiledFactory {
  readonly schemaVersion: "factory.ir.v1";
  readonly digest: string;
  readonly presentationDigest?: string;
  readonly definition: FactoryDefinition;
  readonly lock: DependencyLock;
  readonly indexes: CompiledIndexes;
  readonly partitions: readonly CompiledPartition[];
}

export type RunState =
  | "created"
  | "running"
  | "waiting"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled";

export type NodeState =
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

export interface NodeRuntimeState {
  readonly state: NodeState;
  readonly candidateGeneration: number;
  readonly attempt: number;
  readonly output?: JsonValue;
  readonly error?: string;
}

export interface KernelState {
  readonly logicalRunId: string;
  readonly state: RunState;
  readonly nodes: Readonly<Record<string, NodeRuntimeState>>;
  readonly cancellationEpoch: number;
  readonly commandCounter: number;
  readonly appliedEventIds: readonly string[];
}

export type KernelEvent =
  | { readonly kind: "start"; readonly id: string }
  | { readonly kind: "node-result"; readonly id: string; readonly nodeId: string; readonly attempt: number; readonly output: JsonValue }
  | { readonly kind: "node-failed"; readonly id: string; readonly nodeId: string; readonly attempt: number; readonly error: string }
  | { readonly kind: "approval-decided"; readonly id: string; readonly nodeId: string; readonly choice: string }
  | { readonly kind: "timer-expired"; readonly id: string; readonly nodeId: string }
  | { readonly kind: "admission-result"; readonly id: string; readonly nodeId: string; readonly granted: boolean }
  | { readonly kind: "cancel"; readonly id: string; readonly reason: string };

export type KernelCommand =
  | { readonly kind: "dispatch-node"; readonly id: string; readonly nodeId: string; readonly attempt: number; readonly input: JsonValue }
  | { readonly kind: "request-admission"; readonly id: string; readonly nodeId: string }
  | { readonly kind: "start-timer"; readonly id: string; readonly nodeId: string; readonly deadlineMs: number }
  | { readonly kind: "run-child"; readonly id: string; readonly nodeId: string; readonly factory: FactoryReference; readonly input: JsonValue }
  | { readonly kind: "cancel-node"; readonly id: string; readonly nodeId: string }
  | { readonly kind: "complete-run"; readonly id: string; readonly output: JsonValue }
  | { readonly kind: "fail-run"; readonly id: string; readonly error: string };

export interface AdvanceResult {
  readonly nextState: KernelState;
  readonly commands: readonly KernelCommand[];
}

export interface CompilerDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly nodeId?: string;
}

export type CompileResult =
  | { readonly ok: true; readonly factory: CompiledFactory }
  | { readonly ok: false; readonly diagnostics: readonly CompilerDiagnostic[] };
