export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const FACTORY_SCHEMA_VERSION = "factory.v1" as const;
export const FACTORY_IR_SCHEMA_VERSION = "factory.ir.v1" as const;
export const FACTORY_RUNNER_REQUEST_SCHEMA_VERSION = "factory.runner.request.v1" as const;
export const FACTORY_RUNNER_RESULT_SCHEMA_VERSION = "factory.runner.result.v1" as const;
export const FACTORY_PARTITION_SCHEMA_VERSION = "factory.partition.v1" as const;
export const FACTORY_EXECUTION_MANIFEST_SCHEMA_VERSION = "factory.execution-manifest.v1" as const;
export const FACTORY_API_REQUEST_SCHEMA_VERSION = "factory.api.request.v1" as const;
export const FACTORY_API_RESPONSE_SCHEMA_VERSION = "factory.api.response.v1" as const;
export const FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION = "factory.validator-claims.v1" as const;
export const FACTORY_VALIDATOR_REPORT_SCHEMA_VERSION = "factory.validator-report.v1" as const;
export const FACTORY_LAZY_INPUT_SCHEMA_VERSION = "factory.lazy-input.v1" as const;
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
  maxCandidateGenerations: 3,
  maxWireBytes: 64 * 1024,
  maxApiIdentifierLength: 512,
  maxApiIdempotencyKeyLength: 200,
  defaultApiListLimit: 50,
  maximumApiListLimit: 200,
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
  /** Literal-bound input ports that an authorized repair may replace. */
  readonly repairableInputs?: readonly string[];
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
  /** Literal-bound input ports that an authorized repair or replan may replace. */
  readonly repairableInputs?: readonly string[];
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
  /**
   * Repairs this contract authorizes after a protected rejection.
   *
   * The first candidate is not a repair, so the node runs at most `maxRepairs + 1` candidate
   * generations. An absent bound authorizes no remediation at all: a rejection is terminal.
   * `FACTORY_LIMITS.maxCandidateGenerations` caps every domain at three generations.
   *
   * @minimum 0
   * @maximum 2
   */
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

/** Durable artifact descriptors stay out of kernel JSON state until a bounded host read. */
export interface FactoryDurableInput {
  readonly schemaVersion: "factory.lazy-input.v1";
  readonly parameters: Readonly<Record<string, FactoryTransportValue>>;
}

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

/** Durable attempt identity. The signed transport token is intentionally absent. */
export type FactoryRunnerRequestIdentity = Omit<FactoryRunnerRequest, "broker"> & {
  readonly broker: Omit<FactoryBrokerTransport, "attemptToken">;
};

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

/** A process exit alone is never a verdict. Only this union decides a protected claim. */
export type FactoryValidatorVerdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "VALIDATOR_ERROR";

export interface FactoryValidatorClaimOutcome {
  /** @minLength 1 @maxLength 512 */
  readonly id: string;
  readonly verdict: FactoryValidatorVerdict;
  /** A decisive claim can close its group alone. */
  readonly decisive: boolean;
  /** @maxLength 2048 */
  readonly summary: string;
  /** Machine-readable reason. @minLength 1 @maxLength 128 */
  readonly reasonCode: string;
  /** @maxItems 100 */
  readonly evidence: readonly FactoryArtifactReference[];
  /** @minimum 0 @maximum 9007199254740991 */
  readonly measuredAtMs: number;
}

export interface FactoryValidatorError {
  /** @minLength 1 @maxLength 128 */
  readonly code: string;
  /** @minLength 1 @maxLength 4096 */
  readonly message: string;
}

/** What the isolated guest writes. It carries no provenance and mints no trust. */
export interface FactoryValidatorClaimReport {
  readonly schemaVersion: "factory.validator-claims.v1";
  /** @minItems 1 @maxItems 1000 */
  readonly claims: readonly FactoryValidatorClaimOutcome[];
  /** Present only when every claim is VALIDATOR_ERROR. */
  readonly error?: FactoryValidatorError;
}

/** Gateway-sealed provenance. Every field is read from the durable assignment row. */
export interface FactoryValidatorProvenance {
  /** @minLength 1 @maxLength 512 */
  readonly attemptId: string;
  /** @minLength 1 @maxLength 512 */
  readonly tenantId: string;
  /** @minLength 1 @maxLength 512 */
  readonly projectId: string;
  /** @minLength 1 @maxLength 512 */
  readonly runId: string;
  /** @minLength 1 @maxLength 512 */
  readonly candidateNodeInstanceId: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly candidateGeneration: number;
  /** @minLength 71 @maxLength 71 */
  readonly candidateDigest: string;
  /** @minLength 71 @maxLength 71 */
  readonly validatorLockDigest: string;
  /** @minLength 71 @maxLength 71 */
  readonly runnerDigest: string;
  /** @minLength 71 @maxLength 71 */
  readonly environmentDigest: string;
  /** @minLength 71 @maxLength 71 */
  readonly configurationDigest: string;
  readonly model?: FactoryModelPin;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly trustRevision: number;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly issuerGrantRevision: number;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly issuedAtMs: number;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly expiresAtMs: number;
}

/** The sealed report. Only the gateway validator path constructs one. */
export interface FactoryValidatorReport {
  readonly schemaVersion: "factory.validator-report.v1";
  readonly provenance: FactoryValidatorProvenance;
  /** @minItems 1 @maxItems 1000 */
  readonly claims: readonly FactoryValidatorClaimOutcome[];
  readonly error?: FactoryValidatorError;
}

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

/** Exact product permissions. Runtime authority remains a separate product fact. */
export type FactoryAction =
  | "factory.author"
  | "factory.publish"
  | "factory.run"
  | "factory.operate"
  | "factory.approve"
  | "factory.release"
  | "factory.trust";

export type FactoryAvailability = "available" | "unavailable";
export type FactoryPrincipalKind = "user" | "service";
export type FactoryRunStatus = "queued" | "running" | "waiting" | "cancelling" | "succeeded" | "failed" | "cancelled" | "uncertain";

export interface FactoryProjectPath {
  /** @minLength 1 @maxLength 512 */
  readonly projectId: string;
}

export interface FactoryDraftPath extends FactoryProjectPath {
  /** @minLength 1 @maxLength 512 */
  readonly factoryId: string;
}

export interface FactoryVersionPath extends FactoryDraftPath {
  /** @minLength 1 @maxLength 512 */
  readonly version: string;
}

export interface FactoryRunPath extends FactoryProjectPath {
  /** @minLength 1 @maxLength 512 */
  readonly runId: string;
}

export interface FactoryCommandPath extends FactoryRunPath {
  /** @minLength 1 @maxLength 512 */
  readonly commandId: string;
}

export interface FactoryApprovalPath extends FactoryRunPath {
  /** @minLength 1 @maxLength 512 */
  readonly approvalId: string;
}

export interface FactoryGrantPath extends FactoryProjectPath {
  readonly principalKind: FactoryPrincipalKind;
  /** @minLength 1 @maxLength 512 */
  readonly principalId: string;
  readonly action: FactoryAction;
}

export interface FactoryServiceAccountPath extends FactoryProjectPath {
  /** @minLength 1 @maxLength 512 */
  readonly serviceAccountId: string;
}

export interface FactoryServiceCredentialPath extends FactoryServiceAccountPath {
  /** @minLength 1 @maxLength 512 */
  readonly credentialId: string;
}

export interface FactoryReleaseOperationPath extends FactoryProjectPath {
  /** @minLength 1 @maxLength 512 */
  readonly operationId: string;
}

export interface FactoryReleaseContractPath extends FactoryProjectPath {
  /** @minLength 1 @maxLength 512 */
  readonly contractId: string;
}

export interface FactoryReleaseApprovalPath extends FactoryProjectPath {
  /** @minLength 1 @maxLength 512 */
  readonly approvalId: string;
}

export interface FactoryReleasePolicyPath extends FactoryProjectPath {
  /** @minLength 1 @maxLength 512 */
  readonly policyId: string;
}

/** Values sourced from Idempotency-Key and If-Match, outside the JSON body. */
export interface FactoryMutationPreconditions {
  /** @minLength 1 @maxLength 200 */
  readonly idempotencyKey: string;
  /** Canonical path/query/body digest computed by the shared route wrapper. @minLength 64 @maxLength 64 */
  readonly payloadDigest: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly expectedRevision: number;
}

export interface FactoryListQuery {
  /** @minimum 1 @maximum 200 */
  readonly limit?: number;
  /** @minLength 1 @maxLength 2048 */
  readonly cursor?: string;
  /** @minLength 1 @maxLength 512 */
  readonly search?: string;
}

export interface FactoryDefinitionListQuery extends FactoryListQuery {
  readonly availability?: FactoryAvailability;
  readonly archived?: boolean;
}

export interface FactoryRunListQuery extends FactoryListQuery {
  readonly status?: FactoryRunStatus;
  /** @minLength 1 @maxLength 512 */
  readonly factoryId?: string;
}

export interface FactoryGrantListQuery extends FactoryListQuery {
  readonly principalKind?: FactoryPrincipalKind;
  readonly action?: FactoryAction;
}

export interface FactoryDefinitionBody {
  readonly source: FactoryDefinition;
}

export interface FactoryImportBody {
  readonly format: "json" | "yaml";
  /** @minLength 1 @maxLength 16777216 */
  readonly source: string;
}

export interface FactoryExportQuery {
  readonly format: "json" | "yaml";
}

export interface FactoryPublishBody {
  /** @minLength 1 @maxLength 512 */
  readonly version: string;
}

export interface FactoryReleaseTrustPublishBody {
  /** Immutable runner package and optional model configuration approved for release. */
  readonly packageLock: RunnerReference;
  /** Protected validator lock digest. @minLength 71 @maxLength 71 */
  readonly validatorTrustDigest: string;
}

export interface FactoryReleaseControlBody {
  readonly enabled: boolean;
}

export interface FactoryReleaseContractBody {
  /** @minLength 71 @maxLength 71 */
  readonly contractDigest: string;
  /** @minLength 71 @maxLength 71 */
  readonly validatorLockDigest: string;
  /** @maxItems 1000 */
  readonly mandatoryClaims: readonly { readonly id: string; readonly validatorId: string; readonly freshnessMs: number; /** Defaults to true for stored contracts created before optional claims. */ readonly required?: boolean }[];
  /** @maxItems 1000 */
  readonly claimGroups: readonly { readonly id: string; readonly claimIds: readonly string[]; readonly minimumPasses: number; readonly requireAllDecisive: boolean }[];
}

export interface FactoryReleaseDestinationBody {
  /** @minLength 1 @maxLength 512 */ readonly provider: string;
  /** @minLength 1 @maxLength 512 */ readonly account: string;
  /** @minLength 1 @maxLength 512 */ readonly object: string;
  /** @minLength 1 @maxLength 512 */ readonly expectedVersion?: string;
}

export interface FactoryReleasePrepareBody {
  /** @minLength 1 @maxLength 512 */ readonly runId: string;
  /** @minLength 1 @maxLength 512 */ readonly nodeInstanceId: string;
  /** @minimum 0 @maximum 9007199254740991 */ readonly candidateGeneration: number;
  /** @minLength 1 @maxLength 512 */ readonly decisionId: string;
  /** @minLength 71 @maxLength 71 */ readonly candidateDigest: string;
  /** @minLength 1 @maxLength 512 */ readonly action: string;
  readonly destination: FactoryReleaseDestinationBody;
  readonly request: JsonValue;
  /** @minimum 0 @maximum 9007199254740991 */ readonly estimatedSpendMicros: number;
  /** @minimum 1 @maximum 9007199254740991 */ readonly deadlineMs: number;
}

export interface FactoryReleaseApprovalRequestBody {
  /** @minimum 1 @maximum 9007199254740991 */
  readonly expiresAtMs: number;
}

export interface FactoryReleaseApprovalDecisionBody {
  /** @minLength 64 @maxLength 64 */ readonly contextDigest: string;
  readonly decision: "approved" | "denied";
}

export interface FactoryReleasePolicyBody {
  readonly principalKind: FactoryPrincipalKind;
  /** @minLength 1 @maxLength 512 */ readonly principalId: string;
  /** @minLength 1 @maxLength 512 */ readonly action: string;
  /** @minLength 1 @maxLength 512 */ readonly destinationProvider: string;
  /** @minLength 1 @maxLength 512 */ readonly destinationAccount: string;
  /** @minLength 1 @maxLength 512 */ readonly destinationPrefix: string;
  /** @minLength 71 @maxLength 71 */ readonly contractDigest: string;
  /** @minimum 1 @maximum 9007199254740991 */ readonly maxOperations: number;
  /** @minimum 0 @maximum 9007199254740991 */ readonly maxSpendMicros: number;
  /** @minimum 1 @maximum 9007199254740991 */ readonly expiresAtMs: number;
}

export interface FactoryProviderReceiptBody {
  /** @minLength 1 @maxLength 512 */ readonly provider: string;
  /** @minLength 1 @maxLength 512 */ readonly account: string;
  /** @minLength 1 @maxLength 512 */ readonly object: string;
  /** @minLength 71 @maxLength 71 */ readonly requestDigest: string;
  /** @minLength 1 @maxLength 512 */ readonly operationId: string;
  /** @minimum 1 @maximum 9007199254740991 */ readonly dispatchGeneration: number;
  /** @minLength 1 @maxLength 512 */ readonly providerReceiptId: string;
  /** @minLength 1 @maxLength 512 */ readonly version: string;
  /** @minLength 71 @maxLength 71 */ readonly effectDigest: string;
}

export interface FactoryReleaseReconciliationBody {
  readonly action: "attach_receipt" | "confirm_no_effect" | "keep_uncertain";
  /** @minLength 1 @maxLength 4096 */ readonly reason: string;
  readonly providerEvidence: JsonValue;
  readonly receipt?: FactoryProviderReceiptBody;
}

/** Parameters are named factory input ports. Large values use artifact handles. */
export interface FactoryRunStartBody {
  /** @minLength 1 @maxLength 512 */
  readonly factoryVersion: string;
  /** @minLength 71 @maxLength 71 */
  readonly definitionDigest: string;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly grantRevision: number;
  readonly parameters: Readonly<Record<string, FactoryTransportValue>>;
}

export interface FactoryRunCancelBody {
  readonly action: "cancel";
  /** @minLength 1 @maxLength 2048 */
  readonly reason?: string;
}

export interface FactoryRunRepairBody {
  readonly action: "repair";
  /** Root of the bounded node subtree to replace. @minLength 1 @maxLength 512 */
  readonly nodeId: string;
  /** @minLength 1 @maxLength 2048 */
  readonly reason?: string;
  readonly parameters: Readonly<Record<string, FactoryTransportValue>>;
}

export interface FactoryRunReplanBody {
  readonly action: "replan";
  /** Current subfactory node instance to replace. @minLength 1 @maxLength 512 */
  readonly nodeId: string;
  /** Exact published child revision. */
  readonly replacement: FactoryReference;
  /** @minLength 1 @maxLength 2048 */
  readonly reason?: string;
  readonly parameters: Readonly<Record<string, FactoryTransportValue>>;
}

export type FactoryRunRevisionBody = FactoryRunRepairBody | FactoryRunReplanBody;
export type FactoryRunControlBody = FactoryRunCancelBody | FactoryRunRevisionBody;

export interface FactoryApprovalDecisionBody {
  /** Must equal one of the exact choices in the protected approval request. @minLength 1 @maxLength 512 */
  readonly choice: string;
  /** @minLength 64 @maxLength 64 */
  readonly contextDigest: string;
  /** @minLength 1 @maxLength 2048 */
  readonly reason?: string;
}

export interface FactoryGrantSetBody {
  /** @minimum 1 @maximum 9007199254740991 */
  readonly expiresAtMs: number | null;
}

export type FactoryServiceScope = "read" | "write" | "chat";

export interface FactoryServiceCredentialIssueBody {
  /** Canonical order is read, write, chat. @minItems 1 @maxItems 3 */
  readonly scopes: readonly FactoryServiceScope[];
  /** Whole-second expiry, no more than one hour after issuance. @minimum 1 @maximum 9007199254740991 */
  readonly expiresAtMs: number;
}

/**
 * Canonical C09 route input. `path` is populated from trusted routing state.
 * Tenant identity is intentionally absent, and resource identity never appears
 * in a request body.
 */
export type FactoryApiRequest =
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "draft.create"; readonly path: FactoryProjectPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryDefinitionBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "draft.update"; readonly path: FactoryDraftPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryDefinitionBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "draft.delete"; readonly path: FactoryDraftPath; readonly preconditions: FactoryMutationPreconditions }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "draft.get"; readonly path: FactoryDraftPath }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "draft.list"; readonly path: FactoryProjectPath; readonly query: FactoryDefinitionListQuery }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "draft.import"; readonly path: FactoryProjectPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryImportBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "draft.export"; readonly path: FactoryDraftPath; readonly query: FactoryExportQuery }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "draft.validate"; readonly path: FactoryDraftPath; readonly body: FactoryDefinitionBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "version.publish"; readonly path: FactoryDraftPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryPublishBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "version.get"; readonly path: FactoryVersionPath }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "version.list"; readonly path: FactoryDraftPath; readonly query: FactoryListQuery }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "run.start"; readonly path: FactoryDraftPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryRunStartBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "run.get"; readonly path: FactoryRunPath }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "run.list"; readonly path: FactoryProjectPath; readonly query: FactoryRunListQuery }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "run.control"; readonly path: FactoryRunPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryRunControlBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "command.get"; readonly path: FactoryCommandPath }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "approval.get"; readonly path: FactoryApprovalPath }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "approval.list"; readonly path: FactoryProjectPath; readonly query: FactoryListQuery }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "approval.decide"; readonly path: FactoryApprovalPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryApprovalDecisionBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "grant.list"; readonly path: FactoryProjectPath; readonly query: FactoryGrantListQuery }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "grant.set"; readonly path: FactoryGrantPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryGrantSetBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "grant.revoke"; readonly path: FactoryGrantPath; readonly preconditions: FactoryMutationPreconditions }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "service-credential.issue"; readonly path: FactoryServiceAccountPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryServiceCredentialIssueBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "service-credential.revoke"; readonly path: FactoryServiceCredentialPath; readonly preconditions: FactoryMutationPreconditions }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "release.trust.publish"; readonly path: FactoryProjectPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryReleaseTrustPublishBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "release.trust.revoke"; readonly path: FactoryProjectPath; readonly preconditions: FactoryMutationPreconditions }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "release.control.set"; readonly path: FactoryProjectPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryReleaseControlBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "release.contract.put"; readonly path: FactoryReleaseContractPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryReleaseContractBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "release.prepare"; readonly path: FactoryProjectPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryReleasePrepareBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "release.get"; readonly path: FactoryReleaseOperationPath }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "release.approval.request"; readonly path: FactoryReleaseOperationPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryReleaseApprovalRequestBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "release.approval.decide"; readonly path: FactoryReleaseApprovalPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryReleaseApprovalDecisionBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "release.notification.list"; readonly path: FactoryProjectPath; readonly query: FactoryListQuery }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "release.policy.put"; readonly path: FactoryReleasePolicyPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryReleasePolicyBody }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "release.policy.delete"; readonly path: FactoryReleasePolicyPath; readonly preconditions: FactoryMutationPreconditions }
  | { readonly schemaVersion: "factory.api.request.v1"; readonly kind: "release.reconcile"; readonly path: FactoryReleaseOperationPath; readonly preconditions: FactoryMutationPreconditions; readonly body: FactoryReleaseReconciliationBody };

export interface FactoryDraftSummary {
  /** @minLength 1 @maxLength 512 */
  readonly factoryId: string;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly revision: number;
  readonly archived: boolean;
  readonly availability: FactoryAvailability;
  /** @minLength 1 @maxLength 2048 */
  readonly availabilityReason?: string;
  /** @minLength 64 @maxLength 64 */
  readonly sourceDigest: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly updatedAtMs: number;
}

export interface FactoryDraftDetails extends FactoryDraftSummary {
  readonly source: FactoryDefinition;
}

export interface FactoryVersionSummary {
  /** @minLength 1 @maxLength 512 */
  readonly factoryId: string;
  /** @minLength 1 @maxLength 512 */
  readonly version: string;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly draftRevision: number;
  /** @minLength 71 @maxLength 71 */
  readonly definitionDigest: string;
  /** @minLength 64 @maxLength 64 */
  readonly compiledBlobDigest: string;
  /** @minimum 1 @maximum 16777216 */
  readonly compiledBytes: number;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly publishedAtMs: number;
}

export interface FactoryVersionDetails extends FactoryVersionSummary {
  /** Immutable definition embedded in the verified compiled artifact. */
  readonly source: FactoryDefinition;
}

export interface FactoryRunSummary {
  /** @minLength 1 @maxLength 512 */
  readonly runId: string;
  /** @minLength 1 @maxLength 512 */
  readonly factoryId: string;
  /** @minLength 1 @maxLength 512 */
  readonly factoryVersion: string;
  /** @minLength 71 @maxLength 71 */
  readonly definitionDigest: string;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly grantRevision: number;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly revision: number;
  readonly status: FactoryRunStatus;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly createdAtMs: number;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly updatedAtMs: number;
}

export interface FactoryRunDetails extends FactoryRunSummary {
  readonly parameters: Readonly<Record<string, FactoryTransportValue>>;
  readonly output?: FactoryTransportValue;
  readonly error?: FactoryRunError;
}

export interface FactoryRunError {
  /** @minLength 1 @maxLength 512 */
  readonly code: string;
  /** @minLength 1 @maxLength 4096 */
  readonly message: string;
}

export interface FactoryApprovalResource {
  /** @minLength 1 @maxLength 512 */
  readonly approvalId: string;
  /** @minLength 1 @maxLength 512 */
  readonly runId: string;
  /** @minLength 1 @maxLength 512 */
  readonly commandId: string;
  /** @minLength 1 @maxLength 512 */
  readonly nodeInstanceId: string;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly revision: number;
  /** @minLength 64 @maxLength 64 */
  readonly contextDigest: string;
  readonly status: "pending" | "answered" | "expired";
  /** @minItems 1 @maxItems 100 */
  readonly choices: readonly string[];
  readonly context: JsonValue;
  readonly actorScope: "owner" | "operator" | "tenant-contract-admin";
  /** @minimum 0 @maximum 9007199254740991 */
  readonly expiresAtMs: number;
  /** @minLength 1 @maxLength 512 */
  readonly decidedBy?: string;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly decidedAtMs?: number;
  /** @minLength 1 @maxLength 512 */
  readonly choice?: string;
}

export interface FactoryGrantResource {
  readonly principalKind: FactoryPrincipalKind;
  /** @minLength 1 @maxLength 512 */
  readonly principalId: string;
  readonly action: FactoryAction;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly revision: number;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly expiresAtMs: number | null;
  readonly revoked: boolean;
}

export interface FactoryServiceCredentialResource {
  /** @minLength 1 @maxLength 512 */
  readonly serviceAccountId: string;
  /** @minLength 1 @maxLength 512 */
  readonly credentialId: string;
  /** @minItems 1 @maxItems 3 */
  readonly scopes: readonly FactoryServiceScope[];
  /** @minimum 1 @maximum 9007199254740991 */
  readonly revision: number;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly issuedAtMs: number;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly expiresAtMs: number;
  readonly revoked: boolean;
}

export interface FactoryReleaseTrustResource {
  /** @minimum 1 @maximum 9007199254740991 */
  readonly revision: number;
  readonly state: "active" | "revoked";
  readonly packageLock: RunnerReference;
  /** @minLength 71 @maxLength 71 */
  readonly packageTrustDigest: string;
  /** @minLength 71 @maxLength 71 */
  readonly validatorTrustDigest: string;
  /** @minLength 1 @maxLength 512 */
  readonly approvedBy: string;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly approvalGrantRevision: number;
}

export interface FactoryReleaseControlResource {
  readonly enabled: boolean;
  /** @minimum 1 @maximum 9007199254740991 */
  readonly enableEpoch: number;
}

export interface FactoryReleaseContractResource extends FactoryReleaseContractBody {
  /** @minLength 1 @maxLength 512 */ readonly contractId: string;
  /** @minimum 1 @maximum 9007199254740991 */ readonly revision: number;
}

export interface FactoryReleaseOperationResource {
  /** @minLength 1 @maxLength 512 */ readonly operationId: string;
  /** @minLength 1 @maxLength 512 */ readonly runId: string;
  /** @minLength 1 @maxLength 512 */ readonly nodeInstanceId: string;
  /** @minimum 0 @maximum 9007199254740991 */ readonly candidateGeneration: number;
  /** @minLength 1 @maxLength 512 */ readonly decisionId: string;
  /** @minLength 71 @maxLength 71 */ readonly candidateDigest: string;
  /** @minLength 71 @maxLength 71 */ readonly contractDigest: string;
  /** @minimum 1 @maximum 9007199254740991 */ readonly executionEpoch: number;
  /** @minimum 0 @maximum 9007199254740991 */ readonly cancellationEpoch: number;
  /** @minimum 1 @maximum 9007199254740991 */ readonly releaseEnableEpoch: number;
  /** @minLength 1 @maxLength 512 */ readonly action: string;
  readonly destination: FactoryReleaseDestinationBody;
  /** @minLength 71 @maxLength 71 */ readonly destinationDigest: string;
  /** @minLength 71 @maxLength 71 */ readonly requestDigest: string;
  /** @minimum 0 @maximum 9007199254740991 */ readonly estimatedSpendMicros: number;
  /** @minimum 1 @maximum 9007199254740991 */ readonly deadlineMs: number;
  readonly state: "pending" | "executing" | "succeeded" | "failed" | "uncertain";
  /** @minimum 0 @maximum 9007199254740991 */ readonly dispatchGeneration: number;
  readonly dispatchStarted: boolean;
  readonly archiveReady: boolean;
  /** @minLength 1 @maxLength 512 */ readonly outcomeCode?: string;
  readonly receipt?: FactoryProviderReceiptBody;
}

export interface FactoryReleaseApprovalResource {
  /** @minLength 1 @maxLength 512 */ readonly approvalId: string;
  /** @minLength 1 @maxLength 512 */ readonly operationId?: string;
  /** @minLength 64 @maxLength 64 */ readonly contextDigest: string;
  readonly status: "pending" | "approved" | "denied";
  /** @minimum 1 @maximum 9007199254740991 */ readonly expiresAtMs?: number;
}

interface FactoryReleaseNotificationBase {
  /** @minLength 1 @maxLength 512 */ readonly notificationId: string;
  /** @minimum 0 @maximum 9007199254740991 */ readonly createdAtMs: number;
}

export type FactoryReleaseNotificationResource =
  | (FactoryReleaseNotificationBase & {
    readonly kind: "approval_requested";
    /** @minLength 1 @maxLength 512 */ readonly operationId: string;
    /** @minLength 1 @maxLength 512 */ readonly approvalId: string;
    /** @minLength 64 @maxLength 64 */ readonly contextDigest: string;
    /** @minimum 1 @maximum 9007199254740991 */ readonly expiresAtMs: number;
  })
  | (FactoryReleaseNotificationBase & {
    readonly kind: "release_uncertain" | "release_settled";
    /** @minLength 1 @maxLength 512 */ readonly operationId: string;
    /** @minimum 1 @maximum 9007199254740991 */ readonly dispatchGeneration: number;
    /** @minLength 1 @maxLength 512 */ readonly outcomeCode: string;
  })
  | (FactoryReleaseNotificationBase & {
    readonly kind: "command_approval_requested";
    /** @minLength 1 @maxLength 512 */ readonly approvalId: string;
    /** @minLength 1 @maxLength 512 */ readonly runId: string;
    /** @minLength 1 @maxLength 512 */ readonly commandId: string;
    /** @minLength 1 @maxLength 512 */ readonly nodeInstanceId: string;
    /** @minLength 64 @maxLength 64 */ readonly contextDigest: string;
    readonly context: JsonValue;
    /** @minItems 1 @maxItems 100 */ readonly choices: readonly string[];
    readonly actorScope: "owner" | "operator" | "tenant-contract-admin";
    /** @minimum 1 @maximum 9007199254740991 */ readonly expiresAtMs: number;
  });

export type FactoryReleasePolicyResource =
  | (FactoryReleasePolicyBody & { /** @minLength 1 @maxLength 512 */ readonly policyId: string; readonly revision: 1; readonly revoked: false })
  | { /** @minLength 1 @maxLength 512 */ readonly policyId: string; /** @minimum 2 @maximum 9007199254740991 */ readonly revision: number; readonly revoked: true };

/** Durable transport state; delivery does not mean the run completed. */
export interface FactoryCommandResource {
  /** @minLength 1 @maxLength 512 */
  readonly commandId: string;
  /** @minLength 1 @maxLength 512 */
  readonly runId: string;
  readonly kind: "start_run" | "compute_admission" | "decision" | "partition_notification";
  readonly state: "queued" | "leased" | "delivered" | "cancelled" | "dead_letter" | "outcome_unknown";
  /** @minimum 0 @maximum 9007199254740991 */
  readonly attempts: number;
  /** @minimum 0 @maximum 9007199254740991 */
  readonly createdAtMs: number;
  /** @minLength 1 @maxLength 512 */
  readonly failureCode?: string;
}

export interface FactoryDurableReceipt {
  /** @minLength 1 @maxLength 512 */
  readonly resourceId: string;
  /** @minLength 1 @maxLength 512 */
  readonly commandId: string;
  /** @minLength 1 @maxLength 2048 */
  readonly statusUrl: string;
}

export interface FactoryApiError {
  /** @minLength 1 @maxLength 512 */
  readonly code: string;
  /** @minLength 1 @maxLength 4096 */
  readonly message: string;
  readonly retryable: boolean;
  /** Present on a failed If-Match without exposing another project. @minimum 0 @maximum 9007199254740991 */
  readonly currentRevision?: number;
  /** @maxItems 10000 */
  readonly issues?: readonly ValidationIssue[];
}

export interface FactoryApiPage<T> {
  /** @maxItems 200 */
  readonly items: readonly T[];
  /** @minLength 1 @maxLength 2048 */
  readonly nextCursor?: string;
}

export type FactoryApiResponse =
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "draft.summary"; readonly resource: FactoryDraftSummary }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "draft.details"; readonly resource: FactoryDraftDetails }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "draft.page"; readonly page: FactoryApiPage<FactoryDraftSummary> }
  | {
    readonly schemaVersion: "factory.api.response.v1";
    readonly kind: "draft.export";
    readonly format: "json" | "yaml";
    /** @maxLength 16777216 */
    readonly source: string;
  }
  | {
    readonly schemaVersion: "factory.api.response.v1";
    readonly kind: "draft.validation";
    readonly valid: boolean;
    /** @maxItems 10000 */
    readonly diagnostics: readonly CompilerDiagnostic[];
  }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "version.summary"; readonly resource: FactoryVersionSummary }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "version.details"; readonly resource: FactoryVersionDetails }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "version.page"; readonly page: FactoryApiPage<FactoryVersionSummary> }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "run.details"; readonly resource: FactoryRunDetails }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "run.page"; readonly page: FactoryApiPage<FactoryRunSummary> }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "approval.resource"; readonly resource: FactoryApprovalResource }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "approval.page"; readonly page: FactoryApiPage<FactoryApprovalResource> }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "grant.resource"; readonly resource: FactoryGrantResource }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "grant.page"; readonly page: FactoryApiPage<FactoryGrantResource> }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "service-credential.issued"; readonly resource: FactoryServiceCredentialResource; /** @minLength 32 @maxLength 4096 */ readonly token: string }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "service-credential.resource"; readonly resource: FactoryServiceCredentialResource }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "release.trust.resource"; readonly resource: FactoryReleaseTrustResource }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "release.control.resource"; readonly resource: FactoryReleaseControlResource }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "release.contract.resource"; readonly resource: FactoryReleaseContractResource }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "release.operation.resource"; readonly resource: FactoryReleaseOperationResource }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "release.approval.resource"; readonly resource: FactoryReleaseApprovalResource }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "release.notification.page"; readonly page: FactoryApiPage<FactoryReleaseNotificationResource> }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "release.policy.resource"; readonly resource: FactoryReleasePolicyResource }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "command.resource"; readonly resource: FactoryCommandResource }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "mutation.accepted"; readonly receipt: FactoryDurableReceipt }
  | { readonly schemaVersion: "factory.api.response.v1"; readonly kind: "error"; readonly error: FactoryApiError };
