import type { ExtensionManifestV2, ToolDefinition } from "./legacy";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface EncodedWorkspaceFile { encoding: "base64"; data: string; executable: boolean }
export type WorkspaceFile = string | EncodedWorkspaceFile;
export type WorkspaceFiles = Record<string, WorkspaceFile>;
export type ValueSchema = Record<string, unknown>;
export interface HostApiPermission {
  routes: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string }[];
  events: boolean;
}
export type ProviderRequiredPermission = "hostApi" | "network" | "networkTcp" | "storage";
export interface ProviderHostContract { major: 4; minor: number }
export interface SandboxLifecycleMethodGroup { name: "sandbox.lifecycle.v1"; methods: { create: string; inspect: string; start: string; stop: string; destroy: string } }
export interface SandboxProcessMethodGroup { name: "sandbox.process.v1"; methods: { start: string; inspect: string; readOutput: string; cancel: string } }
export interface SandboxFilesMethodGroup { name: "sandbox.files.v1"; methods: { stat: string; list: string; read: string; write: string; mkdir: string; remove: string; chmod: string } }
export type SandboxProviderMethodGroup =
  | SandboxLifecycleMethodGroup
  | SandboxProcessMethodGroup
  | SandboxFilesMethodGroup;
export interface StaticSecretMethodGroup { name: "secret.static.v1"; methods: { resolve: string } }
export type SecretProviderMethodGroup = StaticSecretMethodGroup;
export interface SandboxProviderContribution {
  id: string;
  kind: "sandbox";
  protocolMajor: 1;
  minimumHostContract: ProviderHostContract;
  profiles: ("linux-exec.v1")[];
  capabilities: [];
  configSchema: ValueSchema;
  requiredPermissions: ProviderRequiredPermission[];
  methodGroups: SandboxProviderMethodGroup[];
}
export interface StaticSecretProviderContribution {
  id: string;
  kind: "static-secret";
  protocolMajor: 1;
  minimumHostContract: ProviderHostContract;
  profiles: ["static-secret.v1"];
  capabilities: [];
  configSchema: ValueSchema;
  requiredPermissions: ProviderRequiredPermission[];
  methodGroups: SecretProviderMethodGroup[];
}
export type ProviderContribution = SandboxProviderContribution | StaticSecretProviderContribution;
export interface ProviderScope { projectId: string; bindingId: string; generation: number }
export interface ProviderCall { scope: ProviderScope; operationId: string; idempotencyKey: string; requestDigest: string }
export interface ProviderError { code: string; message: string; retryable: boolean }
export interface ProviderReceipt { operationId: string; idempotencyKey: string; requestDigest: string; outcome: "succeeded" | "failed" | "unknown"; providerOperationId?: string; error?: ProviderError }
export interface SandboxResourceLimits { memoryBytes: number; milliCpu: number; pids: number; diskBytes: number }
export type SandboxResourceState = "creating" | "stopped" | "running" | "destroying" | "destroyed" | "failed" | "unknown";
export interface SandboxResource { resourceId: string; desiredState: "stopped" | "running" | "destroyed"; observedState: SandboxResourceState; limits: SandboxResourceLimits }
export interface SandboxCreateInput { call: ProviderCall; profile: "linux-exec.v1"; limits: SandboxResourceLimits }
export interface SandboxCreateResult { receipt: ProviderReceipt; resource?: SandboxResource }
export interface SandboxInspectInput { call: ProviderCall; resourceId: string }
export interface SandboxInspectResult { receipt: ProviderReceipt; resource?: SandboxResource }
export interface SandboxStartInput { call: ProviderCall; resourceId: string }
export interface SandboxStartResult { receipt: ProviderReceipt; resource?: SandboxResource }
export interface SandboxStopInput { call: ProviderCall; resourceId: string }
export interface SandboxStopResult { receipt: ProviderReceipt; resource?: SandboxResource }
export interface SandboxDestroyInput { call: ProviderCall; resourceId: string }
export interface SandboxDestroyResult { receipt: ProviderReceipt; resource?: SandboxResource }
export interface SandboxProcessIdentity { bootId: string; processId: string }
export type SandboxProcessState = "starting" | "running" | "exited" | "cancelled" | "failed" | "unknown";
export interface SandboxProcess { identity: SandboxProcessIdentity; state: SandboxProcessState; exitCode?: number; outputCursor: number }
export interface SandboxProcessStartInput { call: ProviderCall; resourceId: string; argv: string[]; env: Record<string, string>; cwd: string; user: "workspace"; deadlineMs: number }
export interface SandboxProcessStartResult { receipt: ProviderReceipt; process?: SandboxProcess }
export interface SandboxProcessInspectInput { call: ProviderCall; resourceId: string; identity: SandboxProcessIdentity }
export interface SandboxProcessInspectResult { receipt: ProviderReceipt; process?: SandboxProcess }
export interface SandboxProcessReadOutputInput { call: ProviderCall; resourceId: string; identity: SandboxProcessIdentity; cursor: number; maxBytes: number }
export interface SandboxProcessOutputChunk { stream: "stdout" | "stderr"; encoding: "utf8" | "base64"; data: string }
export interface SandboxProcessReadOutputResult { receipt: ProviderReceipt; cursor: number; chunks: SandboxProcessOutputChunk[]; eof: boolean; gap: boolean }
export interface SandboxProcessCancelInput { call: ProviderCall; resourceId: string; identity: SandboxProcessIdentity }
export interface SandboxProcessCancelResult { receipt: ProviderReceipt; process?: SandboxProcess }
export interface SandboxFileStat { path: string; kind: "file" | "directory"; revision: string; sizeBytes: number; mode: number }
export interface SandboxFileStatInput { call: ProviderCall; resourceId: string; path: string }
export interface SandboxFileStatResult { receipt: ProviderReceipt; entry?: SandboxFileStat }
export interface SandboxFileListInput { call: ProviderCall; resourceId: string; path: string; cursor?: string; limit: number }
export interface SandboxFileListResult { receipt: ProviderReceipt; entries: SandboxFileStat[]; nextCursor?: string }
export interface SandboxFileReadInput { call: ProviderCall; resourceId: string; path: string; revision?: string; offsetBytes: number; lengthBytes: number }
export interface SandboxFileReadResult { receipt: ProviderReceipt; path: string; revision: string; offsetBytes: number; nextOffsetBytes: number; eof: boolean; encoding: "utf8" | "base64"; data: string }
export interface SandboxFileWriteInput { call: ProviderCall; resourceId: string; path: string; expectedRevision?: string; encoding: "utf8" | "base64"; data: string }
export interface SandboxFileWriteResult { receipt: ProviderReceipt; entry?: SandboxFileStat }
export interface SandboxFileMkdirInput { call: ProviderCall; resourceId: string; path: string; recursive: boolean }
export interface SandboxFileMkdirResult { receipt: ProviderReceipt; entry?: SandboxFileStat }
export interface SandboxFileRemoveInput { call: ProviderCall; resourceId: string; path: string; expectedRevision?: string; recursive: boolean }
export interface SandboxFileRemoveResult { receipt: ProviderReceipt; removedRevision?: string }
export interface SandboxFileChmodInput { call: ProviderCall; resourceId: string; path: string; expectedRevision?: string; mode: number }
export interface SandboxFileChmodResult { receipt: ProviderReceipt; entry?: SandboxFileStat }
export type ProviderMethodWire =
  | { group: "sandbox.lifecycle.v1"; operation: "create"; input: SandboxCreateInput; result: SandboxCreateResult }
  | { group: "sandbox.lifecycle.v1"; operation: "inspect"; input: SandboxInspectInput; result: SandboxInspectResult }
  | { group: "sandbox.lifecycle.v1"; operation: "start"; input: SandboxStartInput; result: SandboxStartResult }
  | { group: "sandbox.lifecycle.v1"; operation: "stop"; input: SandboxStopInput; result: SandboxStopResult }
  | { group: "sandbox.lifecycle.v1"; operation: "destroy"; input: SandboxDestroyInput; result: SandboxDestroyResult }
  | { group: "sandbox.process.v1"; operation: "start"; input: SandboxProcessStartInput; result: SandboxProcessStartResult }
  | { group: "sandbox.process.v1"; operation: "inspect"; input: SandboxProcessInspectInput; result: SandboxProcessInspectResult }
  | { group: "sandbox.process.v1"; operation: "readOutput"; input: SandboxProcessReadOutputInput; result: SandboxProcessReadOutputResult }
  | { group: "sandbox.process.v1"; operation: "cancel"; input: SandboxProcessCancelInput; result: SandboxProcessCancelResult }
  | { group: "sandbox.files.v1"; operation: "stat"; input: SandboxFileStatInput; result: SandboxFileStatResult }
  | { group: "sandbox.files.v1"; operation: "list"; input: SandboxFileListInput; result: SandboxFileListResult }
  | { group: "sandbox.files.v1"; operation: "read"; input: SandboxFileReadInput; result: SandboxFileReadResult }
  | { group: "sandbox.files.v1"; operation: "write"; input: SandboxFileWriteInput; result: SandboxFileWriteResult }
  | { group: "sandbox.files.v1"; operation: "mkdir"; input: SandboxFileMkdirInput; result: SandboxFileMkdirResult }
  | { group: "sandbox.files.v1"; operation: "remove"; input: SandboxFileRemoveInput; result: SandboxFileRemoveResult }
  | { group: "sandbox.files.v1"; operation: "chmod"; input: SandboxFileChmodInput; result: SandboxFileChmodResult };
export interface ToolDefinitionV4 extends ToolDefinition {
  outputSchema: ValueSchema;
  mcpOutputSchema?: ValueSchema;
}
export interface ExtensionManifestV4 extends Omit<ExtensionManifestV2, "schemaVersion" | "tools" | "permissions"> {
  schemaVersion: 4;
  tools?: ToolDefinitionV4[];
  methods?: { name: string; inputSchema: ValueSchema; outputSchema: ValueSchema; sensitivity?: "ordinary" | "sensitive" }[];
  providers?: ProviderContribution[];
  bootSpawn?: boolean;
  dataSchema?: { version: string; readableVersions: string[]; migrateMethod?: string };
  permissions: ExtensionManifestV2["permissions"] & {
    mcpInvoke?: boolean;
    networkTcp?: string[];
    secretRead?: string[];
    hostApi?: HostApiPermission;
    custom?: Record<string, JsonValue>;
  };
}
export interface Diagnostic {
  code: string;
  stage: string;
  message: string;
  retryable: boolean;
  file?: string;
  line?: number;
}
export interface ResourceLimits {
  memoryBytes: number;
  cpuMillis: number;
  pids: number;
  tmpBytes: number;
  outputBytes: number;
  timeoutMs: number;
}
export interface BuildEvidence {
  protocolVersion: 4;
  validatorVersion: string;
  tests: { name: string; passed: boolean }[];
  discoveryDigest: string;
}
export interface BuildResult {
  operationId: string;
  state: "succeeded" | "failed";
  sourceDigest: string;
  artifactDigest?: string;
  imageDigest: string;
  manifest?: ExtensionManifestV4;
  diagnostics: Diagnostic[];
  evidence: BuildEvidence;
}
export interface CandidateVerificationReport {
  catalog: "verified";
  smoke: "passed" | "not_declared";
  capabilities: Array<{ capability: string; state: "tested" | "denied" | "unexercised"; calls: number }>;
}
export interface PublishedExtensionRelease {
  schemaVersion: 4;
  build: BuildResult;
  sourceFiles: WorkspaceFiles;
  packageChecksums: Record<string, string>;
  releaseDigest: string;
}
export interface ReleaseRecord {
  verification?: CandidateVerificationReport;
  id: string;
  installationId: string;
  workspaceId: string;
  workspaceRevision: number;
  sourceDigest: string;
  artifactDigest: string;
  imageDigest: string;
  manifest: ExtensionManifestV4;
  evidence: BuildEvidence;
  runnerProfile: string;
  releaseDigest: string;
  policyDigest: string;
  createdAt: string;
}
export interface OperationRecord {
  id: string;
  kind: "build" | "activate";
  state: "queued" | "building" | "verifying" | "verified" | "awaiting_approval" | "activating" | "active" | "failed" | "cancelled" | "reconciling";
  idempotencyKey: string;
  inputDigest: string;
  workspaceId?: string;
  workspaceRevision?: number;
  sourceDigest?: string;
  entrypoint?: string;
  approvalId?: string;
  rollback?: boolean;
  diagnostics: Diagnostic[];
  releaseId?: string;
  events: { sequence: number; state: OperationRecord["state"]; at: string }[];
  lease?: { holder: string; until: number; fence: number };
  createdAt: string;
  updatedAt: string;
}
export interface ApprovalRecord {
  id: string;
  installationId: string;
  releaseId: string;
  releaseDigest: string;
  principalId: string;
  scope: string;
  grants: string[];
  runnerProfile: string;
  expectedActiveReleaseId: string | null;
  expectedGeneration: number;
  status: "pending" | "approved" | "rejected" | "consumed" | "revoked";
  approvedBy?: string;
  createdAt: string;
}
export interface WorkspaceRecord {
  id: string;
  installationId: string;
  revision: number;
  sourceDigest: string;
  createdAt: string;
}
export interface InstallationRecord {
  id: string;
  ownerId: string;
  scope: string;
  activeReleaseId: string | null;
  generation: number;
  enabled: boolean;
  uninstalled: boolean;
  status: "disabled" | "active" | "reconciling";
  grants: string[];
  acknowledgedGeneration: number;
}
export interface InvocationContext {
  invocationId: string;
  workerId: string;
  releaseId: string;
  principalId: string;
  scopeId: string;
  token: string;
  deadline: number;
  metadata?: Record<string, JsonValue>;
}
export interface BuildRequest {
  operationId: string;
  sourceDigest: string;
  files: WorkspaceFiles;
  entrypoint: string;
  limits: ResourceLimits;
}
export interface StartRequest {
  workerId: string;
  artifactDigest: string;
  context: InvocationContext;
  limits: ResourceLimits;
}
export interface RunnerInspection {
  id: string;
  state: "building" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  diagnostics: Diagnostic[];
}
export type ReverseRpc = (method: string, params: unknown) => Promise<unknown>;
export interface RunnerExecution {
  workerId: string;
  request(method: string, params: unknown): Promise<unknown>;
  close(): Promise<void>;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
}
export interface Runner {
  build(input: BuildRequest): Promise<BuildResult>;
  start(input: StartRequest, reverseRpc: ReverseRpc): Promise<RunnerExecution>;
  cancel(id: string): Promise<void>;
  inspect(id: string): Promise<RunnerInspection>;
  collectArtifacts(artifactDigest: string): Promise<WorkspaceFiles>;
}
export interface WireData {
  publishedRelease: PublishedExtensionRelease;
  manifest: ExtensionManifestV4;
  buildRequest: BuildRequest;
  startRequest: StartRequest;
  buildResult: BuildResult;
  invocationContext: InvocationContext;
  limits: ResourceLimits;
  release: ReleaseRecord;
  operation: OperationRecord;
  approval: ApprovalRecord;
  inspection: RunnerInspection;
  workspace: WorkspaceRecord;
  installation: InstallationRecord;
  providerMethod: ProviderMethodWire;
}
