import type { ProviderReceipt, SandboxCreateInput, SandboxCreateResult, SandboxFileChmodInput, SandboxFileChmodResult, SandboxFileListInput, SandboxFileListResult, SandboxFileMkdirInput, SandboxFileMkdirResult, SandboxFileReadInput, SandboxFileReadResult, SandboxFileRemoveInput, SandboxFileRemoveResult, SandboxFileStatInput, SandboxFileStatResult, SandboxFileWriteInput, SandboxFileWriteResult, SandboxProcessCancelInput, SandboxProcessCancelResult, SandboxProcessInspectInput, SandboxProcessInspectResult, SandboxProcessReadOutputInput, SandboxProcessReadOutputResult, SandboxProcessStartInput, SandboxProcessStartResult, SandboxResource, SandboxResourceLimits } from "@ezcorp/extension-contract";

export type SandboxAction = "create" | "start" | "stop" | "destroy";
export type SandboxMethodGroup = "sandbox.lifecycle.v1" | "sandbox.process.v1" | "sandbox.files.v1";
export type SandboxOperationState = "admitted" | "running" | "succeeded" | "failed" | "unknown";

export interface LocalSandboxProvider {
  installationId: string;
  providerId: string;
  releaseId: string;
  releaseBinding: string;
  generation: number;
}

export interface SandboxProjectStatus {
  projectId: string;
  bindingId: string;
  provider: LocalSandboxProvider;
  resource: SandboxResource | null;
  operation: { id: string; action: SandboxAction; state: SandboxOperationState; receipt?: ProviderReceipt } | null;
}

export interface CreateSandboxProjectInput {
  name: string;
  idempotencyKey: string;
  providerInstallationId: string;
  providerId: string;
  config: Record<string, unknown>;
  limits: SandboxResourceLimits;
  sourceProjectId?: string;
}

export interface RequestSandboxActionInput {
  action: Exclude<SandboxAction, "create">;
  idempotencyKey: string;
}

export interface AdmittedSandboxOperation {
  id: string;
  action: SandboxAction;
  state: SandboxOperationState;
  input: SandboxCreateInput | { resourceId: string };
  provider: LocalSandboxProvider;
}

export class SandboxControllerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SandboxControllerError";
  }
}

export interface SandboxController {
  listLocalSandboxProviders(userId: string): Promise<LocalSandboxProvider[]>;
  createSandboxProject(userId: string, input: CreateSandboxProjectInput): Promise<SandboxProjectStatus>;
  getProjectSandboxStatus(userId: string, projectId: string): Promise<SandboxProjectStatus>;
  requestSandboxAction(userId: string, projectId: string, input: RequestSandboxActionInput): Promise<AdmittedSandboxOperation>;
  executeAdmittedLocalSandboxOperation(userId: string, operationId: string): Promise<SandboxProjectStatus>;
  /** Broker-only callback. It dispatches a durable operation to the host driver. */
  executeAdmittedLocalSandboxOperationRaw(userId: string, operationId: string, signal?: AbortSignal): Promise<SandboxProjectStatus | SandboxOperationResult>;
  admitSandboxMethod(userId: string, projectId: string, input: SandboxMethodInput): Promise<AdmittedSandboxMethod>;
  executeAdmittedSandboxMethod(userId: string, operationId: string, signal?: AbortSignal): Promise<SandboxOperationResult>;
  getSandboxOperationResult(userId: string, operationId: string): Promise<SandboxOperationResult>;
  reconcileSandboxProcess(userId: string, projectId: string, signal?: AbortSignal): Promise<SandboxOperationResult | null>;
  runNativeWorkspaceProcess(target: SandboxWorkspaceTarget, command: NativeWorkspaceCommand, signal: AbortSignal | undefined, principal: WorkspacePrincipal): Promise<NativeWorkspaceResult>;
}

/** Future generic dispatch stays project-scoped and never accepts driver data. */
export interface SandboxMethodAuthority {
  executeSandboxMethod(userId: string, projectId: string, group: SandboxMethodGroup, operation: string, payload: Record<string, unknown>): Promise<unknown>;
}

export interface SandboxMethodInput { group: SandboxMethodGroup; operation: string; payload: Record<string, unknown>; idempotencyKey: string; conversationId?: string }
export interface AdmittedSandboxMethod { id: string; group: SandboxMethodGroup; operation: string; state: SandboxOperationState; provider: LocalSandboxProvider }
export interface SandboxOperationResult extends AdmittedSandboxMethod { result?: unknown; receipt?: ProviderReceipt }
export interface SandboxWorkspaceTarget { projectId: string; bindingId: string; revision: number }
export interface NativeWorkspaceCommand { argv: string[]; timeoutMs: number }
export interface NativeWorkspaceResult { stdout: string; exitCode: number }
export interface WorkspacePrincipal { userId: string; conversationId: string }
export type SandboxProviderInvocation = (userId: string, projectId: string, provider: LocalSandboxProvider, group: SandboxMethodGroup, operation: string, input: unknown, signal?: AbortSignal) => Promise<unknown>;

export interface SandboxProviderInvoker {
  create(input: SandboxCreateInput): Promise<SandboxCreateResult>;
}

export interface LocalSandboxDriver extends SandboxProviderInvoker {
  inspect(input: { call: SandboxCreateInput["call"]; resourceId: string }): Promise<{ receipt: ProviderReceipt; resource?: SandboxResource }>;
  start(input: { call: SandboxCreateInput["call"]; resourceId: string }): Promise<{ receipt: ProviderReceipt; resource?: SandboxResource }>;
  stop(input: { call: SandboxCreateInput["call"]; resourceId: string }): Promise<{ receipt: ProviderReceipt; resource?: SandboxResource }>;
  destroy(input: { call: SandboxCreateInput["call"]; resourceId: string }): Promise<{ receipt: ProviderReceipt; resource?: SandboxResource }>;
  processStart(input: SandboxProcessStartInput): Promise<SandboxProcessStartResult>;
  processInspect(input: SandboxProcessInspectInput): Promise<SandboxProcessInspectResult>;
  processReadOutput(input: SandboxProcessReadOutputInput): Promise<SandboxProcessReadOutputResult>;
  processCancel(input: SandboxProcessCancelInput): Promise<SandboxProcessCancelResult>;
  fileStat(input: SandboxFileStatInput): Promise<SandboxFileStatResult>;
  fileList(input: SandboxFileListInput): Promise<SandboxFileListResult>;
  fileRead(input: SandboxFileReadInput): Promise<SandboxFileReadResult>;
  fileWrite(input: SandboxFileWriteInput): Promise<SandboxFileWriteResult>;
  fileMkdir(input: SandboxFileMkdirInput): Promise<SandboxFileMkdirResult>;
  fileRemove(input: SandboxFileRemoveInput): Promise<SandboxFileRemoveResult>;
  fileChmod(input: SandboxFileChmodInput): Promise<SandboxFileChmodResult>;
}
