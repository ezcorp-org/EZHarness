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
  transact<Result>(installationId: string, change: (state: InstallationState) => Result | Promise<Result>, actor?: LifecycleActor): Promise<Result>;
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
  // biome-ignore lint/suspicious/noConfusingVoidType: Lifecycle implementations use Promise<void> for a successful no-report verification.
  verifyCandidate(release: LifecycleRelease, artifacts: WorkspaceFiles): Promise<CandidateVerificationReport | void>;
  prepareActivation?(installation: InstallationRecord, previous: LifecycleRelease | null, release: LifecycleRelease, operation: LifecycleOperation): Promise<void>;
  abortActivation?(installationId: string, operation: LifecycleOperation): Promise<void>;
  publish(installation: InstallationRecord, release: LifecycleRelease | null): Promise<void>;
  onBuildSettled?(deferredByRunner: boolean): void;
  now?: () => number;
  leaseMs?: number;
  /**
   * Present only when the host runs `TrustedLocalRunner`
   * (`runner-mode.ts` → `trusted-local`). That runner refuses every build
   * and every worker start without a live approval for the exact
   * (phase, digest); these hooks are how the lifecycle's two human
   * acknowledgement points — Build, and "Approve exact release" — write and
   * withdraw it. Absent in isolated mode, where no acknowledgement is asked
   * for and none is recorded.
   */
  trustedLocal?: {
    recordApproval(input: { phase: "build" | "execute"; digest: string; installationId: string; approvedBy: string }): Promise<void>;
    /**
     * Extend the build acknowledgement for `sourceDigest` to a SHORT window of
     * execution for the artifact it produced, so candidate verification —
     * which starts a worker — can run. Derived, never asked for separately.
     */
    recordVerificationApproval(input: { installationId: string; sourceDigest: string; artifactDigest: string }): Promise<void>;
    revokeApprovals(installationId: string, digest?: string): Promise<void>;
  };
}

export class LifecycleError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}
