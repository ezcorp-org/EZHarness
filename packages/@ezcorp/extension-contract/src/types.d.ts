import type { ExtensionManifestV2, ToolDefinition } from "./legacy";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type WorkspaceFiles = Record<string, string>;
export type ValueSchema = Record<string, unknown>;
export interface HostApiPermission {
  routes: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string }[];
  events: boolean;
}
export interface ToolDefinitionV4 extends ToolDefinition {
  outputSchema: ValueSchema;
  mcpOutputSchema?: ValueSchema;
}
export interface ExtensionManifestV4 extends Omit<ExtensionManifestV2, "schemaVersion" | "tools" | "permissions"> {
  schemaVersion: 4;
  tools?: ToolDefinitionV4[];
  methods?: { name: string; inputSchema: ValueSchema; outputSchema: ValueSchema }[];
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
}
