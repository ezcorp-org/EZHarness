import type { ApprovalRecord, CandidateVerificationReport, InstallationRecord, OperationRecord, ReleaseRecord, ResourceLimits, Runner, WorkspaceFiles, WorkspaceRecord } from "@ezcorp/extension-contract";

export type { InstallationRecord, WorkspaceRecord } from "@ezcorp/extension-contract";
export type LifecycleRelease = ReleaseRecord;
export type LifecycleOperation = OperationRecord;
export type LifecycleApproval = ApprovalRecord;

export interface LifecycleActor {
  principalId: string;
  scope: string;
  kind: "human" | "agent" | "service";
}

export interface InstallationState {
  installation: InstallationRecord;
  workspaces: Record<string, WorkspaceRecord>;
  revisions: Record<string, WorkspaceRecord>;
  operations: Record<string, LifecycleOperation>;
  releases: Record<string, LifecycleRelease>;
  approvals: Record<string, LifecycleApproval>;
}

export interface LifecycleRepository {
  create(state: InstallationState): Promise<void>;
  read(installationId: string): Promise<InstallationState | null>;
  list(ownerId: string, scope: string): Promise<InstallationRecord[]>;
  transact<Result>(installationId: string, change: (state: InstallationState) => Result | Promise<Result>): Promise<Result>;
}

export interface BlobStore {
  put(bytes: Uint8Array): Promise<string>;
  get(digest: string): Promise<Uint8Array>;
}

export type LifecycleRunner = Pick<Runner, "build" | "cancel" | "collectArtifacts">;

export interface LifecycleDependencies {
  repository: LifecycleRepository;
  blobs: BlobStore;
  runner: LifecycleRunner;
  resolveDependencies?(files: WorkspaceFiles): Promise<WorkspaceFiles>;
  runnerProfile: string;
  runnerImageDigest: string;
  validatorVersion: string;
  buildLimits: ResourceLimits;
  authorize(actor: LifecycleActor, action: "workspace" | "build" | "approve" | "activate" | "disable" | "uninstall", release?: LifecycleRelease, grants?: string[]): Promise<void>;
  authorizeAccess?(actor: LifecycleActor, installation: InstallationRecord): Promise<void>;
  verifyCandidate(release: LifecycleRelease, artifacts: WorkspaceFiles): Promise<CandidateVerificationReport | void>;
  prepareActivation?(installation: InstallationRecord, previous: LifecycleRelease | null, release: LifecycleRelease, operation: LifecycleOperation): Promise<void>;
  abortActivation?(installationId: string, operation: LifecycleOperation): Promise<void>;
  publish(installation: InstallationRecord, release: LifecycleRelease | null): Promise<void>;
  now?: () => number;
  leaseMs?: number;
}

export class LifecycleError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}
