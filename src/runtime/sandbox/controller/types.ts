import type { ProviderReceipt, SandboxCreateInput, SandboxCreateResult, SandboxResource, SandboxResourceLimits } from "@ezcorp/extension-contract";

export type SandboxAction = "create" | "start" | "stop" | "destroy";
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
}

/** Future generic dispatch stays project-scoped and never accepts driver data. */
export interface SandboxMethodAuthority {
  executeSandboxMethod(userId: string, projectId: string, group: "sandbox.lifecycle.v1", operation: SandboxAction, payload: Record<string, unknown>): Promise<unknown>;
}

export interface SandboxProviderInvoker {
  create(input: SandboxCreateInput): Promise<SandboxCreateResult>;
}

export interface LocalSandboxDriver extends SandboxProviderInvoker {
  inspect(input: { call: SandboxCreateInput["call"]; resourceId: string }): Promise<{ receipt: ProviderReceipt; resource?: SandboxResource }>;
  start(input: { call: SandboxCreateInput["call"]; resourceId: string }): Promise<{ receipt: ProviderReceipt; resource?: SandboxResource }>;
  stop(input: { call: SandboxCreateInput["call"]; resourceId: string }): Promise<{ receipt: ProviderReceipt; resource?: SandboxResource }>;
  destroy(input: { call: SandboxCreateInput["call"]; resourceId: string }): Promise<{ receipt: ProviderReceipt; resource?: SandboxResource }>;
}
