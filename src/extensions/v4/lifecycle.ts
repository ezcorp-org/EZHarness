import { randomUUID } from "node:crypto";
import { ContractError, validateManifest, validateWire, type WorkspaceFiles } from "@ezcorp/extension-contract";
import { digestObject, getFiles, putFiles, validateFiles, validatePath } from "./blobs";
import { LifecycleError, type InstallationRecord, type InstallationState, type LifecycleActor, type LifecycleApproval, type LifecycleDependencies, type LifecycleOperation, type LifecycleRelease, type WorkspaceRecord } from "./types";

export class ExtensionLifecycle {
  private readonly now: () => number;
  private readonly leaseMs: number;

  constructor(private readonly dependencies: LifecycleDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.leaseMs = dependencies.leaseMs ?? dependencies.buildLimits.timeoutMs + 60_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) throw new LifecycleError("invalid_policy", "Lease duration must be positive.");
  }

  private timestamp(): string { return new Date(this.now()).toISOString(); }

  private policyDigest(): string { return digestObject({ profile: this.dependencies.runnerProfile, image: this.dependencies.runnerImageDigest, validator: this.dependencies.validatorVersion, limits: this.dependencies.buildLimits }); }

  private buildInput(workspaceId: string, revision: number, entrypoint: string) { return { workspaceId, revision, entrypoint, policyDigest: this.policyDigest() }; }

  private async checkOwner(actor: LifecycleActor, state: InstallationState): Promise<void> {
    if (this.dependencies.authorizeAccess) return this.dependencies.authorizeAccess(actor, state.installation);
    if (actor.principalId && actor.principalId === state.installation.ownerId && actor.scope === state.installation.scope) return;
    throw new LifecycleError("not_found", "Installation not found.");
  }

  private async transaction<Result>(actor: LifecycleActor, installationId: string, change: (state: InstallationState) => Result | Promise<Result>): Promise<Result> {
    await this.inspect(actor, installationId);
    return this.dependencies.repository.transact(installationId, change);
  }

  private workspace(state: InstallationState, workspaceId: string): WorkspaceRecord {
    const workspace = Object.hasOwn(state.workspaces, workspaceId) ? state.workspaces[workspaceId] : undefined;
    if (!workspace) throw new LifecycleError("not_found", "Workspace not found.");
    return workspace;
  }

  private release(state: InstallationState, releaseId: string): LifecycleRelease {
    const release = Object.hasOwn(state.releases, releaseId) ? state.releases[releaseId] : undefined;
    if (!release) throw new LifecycleError("not_found", "Release not found.");
    return release;
  }

  private operation(state: InstallationState, operationId: string): LifecycleOperation {
    const operation = Object.hasOwn(state.operations, operationId) ? state.operations[operationId] : undefined;
    if (!operation) throw new LifecycleError("not_found", "Operation not found.");
    return operation;
  }

  private transition(operation: LifecycleOperation, state: LifecycleOperation["state"]): void {
    operation.state = state;
    operation.updatedAt = this.timestamp();
    operation.events.push({ sequence: operation.events.length + 1, state, at: operation.updatedAt });
  }

  private newOperation(kind: LifecycleOperation["kind"], key: string, input: unknown): LifecycleOperation {
    if (!key || key.length > 200 || [...key].some((character) => character.charCodeAt(0) < 32)) throw new LifecycleError("invalid_idempotency_key", "Provide a bounded idempotency key.");
    const operation: LifecycleOperation = { id: randomUUID(), kind, state: "queued", idempotencyKey: key, inputDigest: digestObject(input), diagnostics: [], events: [], createdAt: this.timestamp(), updatedAt: this.timestamp() };
    this.transition(operation, kind === "build" ? "queued" : "awaiting_approval");
    return operation;
  }

  private previousOperation(state: InstallationState, candidate: LifecycleOperation): LifecycleOperation | undefined {
    const previous = Object.values(state.operations).find((operation) => operation.idempotencyKey === candidate.idempotencyKey);
    if (previous && (previous.kind !== candidate.kind || previous.inputDigest !== candidate.inputDigest)) throw new LifecycleError("idempotency_conflict", "This key already identifies a different operation.");
    return previous;
  }

  async list(actor: LifecycleActor): Promise<InstallationRecord[]> {
    await this.dependencies.authorize(actor, "workspace");
    return this.dependencies.repository.list(actor.principalId, actor.scope);
  }

  async inspect(actor: LifecycleActor, installationId: string): Promise<InstallationState> {
    const state = await this.dependencies.repository.read(installationId);
    if (!state) throw new LifecycleError("not_found", "Installation not found.");
    await this.checkOwner(actor, state);
    return state;
  }

  async createWorkspace(actor: LifecycleActor, input: { files?: WorkspaceFiles; installationId?: string; releaseId?: string }): Promise<{ installation: InstallationRecord; workspace: WorkspaceRecord }> {
    await this.dependencies.authorize(actor, "workspace");
    if (!actor.principalId || !actor.scope) throw new LifecycleError("invalid_actor", "An owner and scope are required.");
    let files = input.files ?? {};
    if (input.releaseId) {
      if (!input.installationId || input.files) throw new LifecycleError("invalid_fork", "Fork a release from its installation without replacement files.");
      const state = await this.inspect(actor, input.installationId);
      files = await getFiles(this.dependencies.blobs, this.release(state, input.releaseId).sourceDigest);
    }
    const sourceDigest = await putFiles(this.dependencies.blobs, files);
    const installationId = input.installationId ?? randomUUID();
    const workspace: WorkspaceRecord = { id: randomUUID(), installationId, revision: 1, sourceDigest, createdAt: this.timestamp() };
    if (input.installationId) return this.transaction(actor, installationId, (state) => {
      if (state.installation.uninstalled) throw new LifecycleError("uninstalled", "This installation has been uninstalled.");
      state.workspaces[workspace.id] = workspace;
      state.revisions[`${workspace.id}:${workspace.revision}`] = structuredClone(workspace);
      return { installation: state.installation, workspace };
    });
    const installation: InstallationRecord = { id: installationId, ownerId: actor.principalId, scope: actor.scope, activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 0 };
    await this.dependencies.repository.create({ installation, workspaces: { [workspace.id]: workspace }, revisions: { [`${workspace.id}:${workspace.revision}`]: structuredClone(workspace) }, operations: {}, releases: {}, approvals: {} });
    return { installation, workspace };
  }

  async readWorkspace(actor: LifecycleActor, installationId: string, workspaceId: string): Promise<{ workspace: WorkspaceRecord; files: WorkspaceFiles }> {
    const workspace = this.workspace(await this.inspect(actor, installationId), workspaceId);
    return { workspace, files: await getFiles(this.dependencies.blobs, workspace.sourceDigest) };
  }

  async editWorkspace(actor: LifecycleActor, input: { installationId: string; workspaceId: string; expectedRevision: number; writes?: WorkspaceFiles; deletes?: string[] }): Promise<WorkspaceRecord> {
    await this.dependencies.authorize(actor, "workspace");
    const { workspace, files } = await this.readWorkspace(actor, input.installationId, input.workspaceId);
    if (workspace.revision !== input.expectedRevision) throw new LifecycleError("revision_conflict", "Workspace changed. Read its current revision.");
    const next: WorkspaceFiles = Object.assign(Object.create(null), files);
    for (const path of input.deletes ?? []) { validatePath(path); delete next[path]; }
    for (const [path, content] of Object.entries(input.writes ?? {})) { validatePath(path); next[path] = content; }
    const sourceDigest = await putFiles(this.dependencies.blobs, next);
    return this.transaction(actor, input.installationId, (state) => {
      if (state.installation.uninstalled) throw new LifecycleError("uninstalled", "This installation has been uninstalled.");
      const current = this.workspace(state, input.workspaceId);
      if (current.revision !== input.expectedRevision) throw new LifecycleError("revision_conflict", "Workspace changed. Read its current revision.");
      current.revision += 1;
      current.sourceDigest = sourceDigest;
      state.revisions[`${current.id}:${current.revision}`] = structuredClone(current);
      return current;
    });
  }

  async resolveWorkspaceDependencies(actor: LifecycleActor, input: { installationId: string; workspaceId: string; expectedRevision: number }): Promise<WorkspaceRecord> {
    await this.dependencies.authorize(actor, "workspace");
    const { workspace, files } = await this.readWorkspace(actor, input.installationId, input.workspaceId);
    if (workspace.revision !== input.expectedRevision) throw new LifecycleError("revision_conflict", "Workspace changed. Read its current revision.");
    if (!this.dependencies.resolveDependencies) throw new LifecycleError("resolver_unconfigured", "Dependency resolution is not configured.");
    const resolved = await this.dependencies.resolveDependencies(files);
    const lock = resolved["package-lock.json"];
    return this.editWorkspace(actor, { ...input, writes: lock === undefined ? {} : { "package-lock.json": lock }, deletes: lock === undefined ? ["package-lock.json"] : [] });
  }

  async build(actor: LifecycleActor, input: { installationId: string; workspaceId: string; expectedRevision: number; idempotencyKey: string; entrypoint?: string }): Promise<LifecycleOperation> {
    await this.dependencies.authorize(actor, "build");
    const entrypoint = input.entrypoint ?? "extension.ts";
    validatePath(entrypoint);
    const operation = this.newOperation("build", input.idempotencyKey, this.buildInput(input.workspaceId, input.expectedRevision, entrypoint));
    return this.transaction(actor, input.installationId, (state) => {
      const previous = this.previousOperation(state, operation);
      if (previous) return previous;
      if (state.installation.uninstalled) throw new LifecycleError("uninstalled", "This installation has been uninstalled.");
      const workspace = this.workspace(state, input.workspaceId);
      if (workspace.revision !== input.expectedRevision) throw new LifecycleError("revision_conflict", "Build must identify the current workspace revision.");
      Object.assign(operation, { workspaceId: workspace.id, workspaceRevision: workspace.revision, sourceDigest: workspace.sourceDigest, entrypoint });
      state.operations[operation.id] = operation;
      return operation;
    });
  }

  private async claim(actor: LifecycleActor, installationId: string, operationId: string, kind: LifecycleOperation["kind"]): Promise<{ operation: LifecycleOperation; holder: string; fence: number } | null> {
    return this.transaction(actor, installationId, (state) => {
      const operation = this.operation(state, operationId);
      if (operation.kind !== kind) throw new LifecycleError("operation_kind", "Operation kind does not match.");
      if (["verified", "active", "failed", "cancelled", "reconciling"].includes(operation.state)) return null;
      if (operation.lease && operation.lease.until > this.now()) return null;
      if (state.installation.uninstalled) throw new LifecycleError("uninstalled", "This installation has been uninstalled.");
      if (kind === "activate" && Object.values(state.operations).some((other) => other.id !== operation.id && other.kind === "activate" && other.state === "activating" && other.lease && other.lease.until > this.now())) throw new LifecycleError("activation_busy", "Another activation holds the installation lease.");
      const holder = randomUUID();
      const fence = (operation.lease?.fence ?? 0) + 1;
      operation.lease = { holder, fence, until: this.now() + this.leaseMs };
      this.transition(operation, kind === "build" ? "building" : "activating");
      return { operation, holder, fence };
    });
  }

  private assertLease(operation: LifecycleOperation, holder: string, fence: number): void {
    if (operation.lease?.holder !== holder || operation.lease.fence !== fence || operation.lease.until <= this.now() || operation.state === "cancelled") throw new LifecycleError("lease_lost", "The operation lease has expired or was replaced.");
  }

  private async failure(actor: LifecycleActor, installationId: string, operationId: string, holder: string, fence: number, error: unknown): Promise<void> {
    await this.transaction(actor, installationId, (state) => {
      const operation = this.operation(state, operationId);
      if (operation.lease?.holder !== holder || operation.lease.fence !== fence || ["cancelled", "reconciling", "active", "verified"].includes(operation.state)) return;
      const known = error instanceof LifecycleError || error instanceof ContractError;
      operation.diagnostics.push({ code: known ? error.code : "operation_failed", stage: operation.kind, message: known ? error.message : "Operation failed. See host diagnostics.", retryable: false });
      this.transition(operation, "failed");
    });
  }

  async runBuild(actor: LifecycleActor, installationId: string, operationId: string): Promise<LifecycleOperation> {
    await this.dependencies.authorize(actor, "build");
    const claimed = await this.claim(actor, installationId, operationId, "build");
    if (!claimed) return this.operation(await this.inspect(actor, installationId), operationId);
    const { operation, holder, fence } = claimed;
    try {
      if (operation.inputDigest !== digestObject(this.buildInput(operation.workspaceId!, operation.workspaceRevision!, operation.entrypoint!))) throw new LifecycleError("build_policy_changed", "The frozen build policy changed. Queue a new build.");
      const files = await getFiles(this.dependencies.blobs, operation.sourceDigest!);
      if (!Object.hasOwn(files, operation.entrypoint!)) throw new LifecycleError("missing_entrypoint", "The selected entrypoint is absent from this source snapshot.");
      const result = validateWire("buildResult", await this.dependencies.runner.build({ operationId: holder, sourceDigest: operation.sourceDigest!, files, entrypoint: operation.entrypoint!, limits: this.dependencies.buildLimits }));
      await this.transaction(actor, installationId, (state) => { const current = this.operation(state, operationId); this.assertLease(current, holder, fence); current.diagnostics = result.diagnostics; });
      if (result.state !== "succeeded" || result.operationId !== holder || result.sourceDigest !== operation.sourceDigest || !result.artifactDigest || !result.manifest || !/^[a-f0-9]{64}$/.test(result.artifactDigest)) throw new LifecycleError("build_failed", "The isolated build did not produce a valid release.");
      validateManifest(result.manifest);
      if (digestObject(result.manifest) !== result.evidence.discoveryDigest) throw new LifecycleError("discovery_mismatch", "Discovered metadata does not match its evidence digest.");
      if (result.imageDigest !== this.dependencies.runnerImageDigest || result.evidence.protocolVersion !== 4 || result.evidence.validatorVersion !== this.dependencies.validatorVersion || !result.evidence.tests.length || result.evidence.tests.some((test) => test.passed !== true)) throw new LifecycleError("verification_failed", "Required build evidence is missing, stale, or failed.");
      const artifacts = await this.dependencies.runner.collectArtifacts(result.artifactDigest);
      validateFiles(artifacts);
      const artifactDigest = await putFiles(this.dependencies.blobs, artifacts);
      if (artifactDigest !== result.artifactDigest) throw new LifecycleError("artifact_mismatch", "Collected artifact bytes do not match the build digest.");
      const releaseInput = { installationId, workspaceId: operation.workspaceId!, workspaceRevision: operation.workspaceRevision!, sourceDigest: operation.sourceDigest!, artifactDigest, imageDigest: result.imageDigest, manifest: result.manifest, evidence: result.evidence, runnerProfile: this.dependencies.runnerProfile, policyDigest: this.policyDigest() };
      const release: LifecycleRelease = { ...releaseInput, id: randomUUID(), releaseDigest: digestObject(releaseInput), createdAt: this.timestamp() };
      await this.transaction(actor, installationId, (state) => { const current = this.operation(state, operationId); this.assertLease(current, holder, fence); this.transition(current, "verifying"); });
      const verification = await this.dependencies.verifyCandidate(release, artifacts);
      if (verification) { release.verification = verification; release.releaseDigest = digestObject({ ...releaseInput, verification }); }
      await this.transaction(actor, installationId, (state) => {
        const current = this.operation(state, operationId);
        this.assertLease(current, holder, fence);
        if (state.installation.uninstalled) throw new LifecycleError("uninstalled", "This installation has been uninstalled.");
        state.releases[release.id] = release;
        current.releaseId = release.id;
        current.diagnostics = result.diagnostics;
        this.transition(current, "verified");
      });
    } catch (error) { await this.failure(actor, installationId, operationId, holder, fence, error); }
    return this.operation(await this.inspect(actor, installationId), operationId);
  }

  async requestApproval(actor: LifecycleActor, input: { installationId: string; releaseId: string; grants: string[]; expectedActiveReleaseId: string | null }): Promise<LifecycleApproval> {
    const snapshot = await this.inspect(actor, input.installationId);
    const release = this.release(snapshot, input.releaseId);
    if (!Array.isArray(input.grants) || input.grants.length > 1000 || input.grants.some((grant) => typeof grant !== "string" || !grant || grant.length > 1000)) throw new LifecycleError("invalid_grants", "Grants must be a bounded capability list.");
    const grants = [...new Set(input.grants)].sort();
    await this.dependencies.authorize(actor, "activate", release, grants);
    return this.transaction(actor, input.installationId, (state) => {
      if (state.installation.uninstalled) throw new LifecycleError("uninstalled", "This installation has been uninstalled.");
      if (state.installation.activeReleaseId !== input.expectedActiveReleaseId) throw new LifecycleError("stale_approval", "The active release changed.");
      const approval: LifecycleApproval = { id: randomUUID(), installationId: input.installationId, releaseId: release.id, releaseDigest: release.releaseDigest, principalId: state.installation.ownerId, scope: state.installation.scope, grants, runnerProfile: release.runnerProfile, expectedActiveReleaseId: input.expectedActiveReleaseId, expectedGeneration: state.installation.generation, status: "pending", createdAt: this.timestamp() };
      state.approvals[approval.id] = approval;
      return approval;
    });
  }

  private approval(state: InstallationState, approvalId: string): LifecycleApproval {
    const approval = Object.hasOwn(state.approvals, approvalId) ? state.approvals[approvalId] : undefined;
    if (!approval) throw new LifecycleError("not_found", "Approval not found.");
    return approval;
  }

  private checkApproval(state: InstallationState, approval: LifecycleApproval, requireApproved: boolean): LifecycleRelease {
    const release = this.release(state, approval.releaseId);
    if ((requireApproved && approval.status !== "approved") || approval.principalId !== state.installation.ownerId || approval.scope !== state.installation.scope || approval.releaseDigest !== release.releaseDigest || release.policyDigest !== this.policyDigest() || approval.runnerProfile !== this.dependencies.runnerProfile || release.evidence.validatorVersion !== this.dependencies.validatorVersion || approval.expectedActiveReleaseId !== state.installation.activeReleaseId || approval.expectedGeneration !== state.installation.generation || state.installation.uninstalled) throw new LifecycleError("stale_approval", "Approval is missing, revoked, or no longer matches this activation.");
    return release;
  }

  async approve(actor: LifecycleActor, installationId: string, approvalId: string, decision: boolean): Promise<LifecycleApproval> {
    if (actor.kind !== "human") throw new LifecycleError("human_approval_required", "Only an authenticated human can decide release approval.");
    const snapshot = await this.inspect(actor, installationId);
    const requested = this.approval(snapshot, approvalId);
    await this.dependencies.authorize(actor, "approve", this.release(snapshot, requested.releaseId), requested.grants);
    return this.transaction(actor, installationId, (state) => {
      const approval = this.approval(state, approvalId);
      this.checkApproval(state, approval, false);
      if (approval.status !== "pending") throw new LifecycleError("approval_decided", "This approval already has a decision.");
      approval.status = decision ? "approved" : "rejected";
      approval.approvedBy = actor.principalId;
      return approval;
    });
  }

  async activate(actor: LifecycleActor, input: { installationId: string; approvalId: string; idempotencyKey: string; rollback?: boolean }): Promise<LifecycleOperation> {
    const candidate = this.newOperation("activate", input.idempotencyKey, { approvalId: input.approvalId, rollback: input.rollback === true });
    candidate.rollback = input.rollback === true;
    const operation = await this.transaction(actor, input.installationId, (state) => {
      const previous = this.previousOperation(state, candidate);
      if (previous) return previous;
      const approval = this.approval(state, input.approvalId);
      this.checkApproval(state, approval, true);
      candidate.approvalId = approval.id;
      candidate.releaseId = approval.releaseId;
      state.operations[candidate.id] = candidate;
      return candidate;
    });
    if (operation.state === "reconciling") { await this.reconcile(actor, input.installationId); return this.operation(await this.inspect(actor, input.installationId), operation.id); }
    const claimed = await this.claim(actor, input.installationId, operation.id, "activate");
    if (!claimed) return this.operation(await this.inspect(actor, input.installationId), operation.id);
    const { holder, fence } = claimed;
    try {
      const snapshot = await this.inspect(actor, input.installationId);
      const approval = this.approval(snapshot, input.approvalId);
      const release = this.checkApproval(snapshot, approval, true);
      await this.dependencies.authorize(actor, "activate", release, approval.grants);
      const artifacts = await getFiles(this.dependencies.blobs, release.artifactDigest);
      await this.dependencies.verifyCandidate(release, artifacts);
      await this.dependencies.authorize(actor, "activate", release, approval.grants);
      await this.dependencies.prepareActivation?.(snapshot.installation, snapshot.installation.activeReleaseId ? this.release(snapshot, snapshot.installation.activeReleaseId) : null, release, claimed.operation);
      await this.dependencies.authorize(actor, "activate", release, approval.grants);
      await this.transaction(actor, input.installationId, (state) => {
        const current = this.operation(state, operation.id);
        this.assertLease(current, holder, fence);
        const exactApproval = this.approval(state, input.approvalId);
        this.checkApproval(state, exactApproval, true);
        exactApproval.status = "consumed";
        state.installation.activeReleaseId = release.id;
        state.installation.generation += 1;
        state.installation.enabled = true;
        state.installation.status = "reconciling";
        state.installation.grants = exactApproval.grants;
        this.transition(current, "reconciling");
      });
      await this.reconcile(actor, input.installationId);
    } catch (error) {
      const current = this.operation(await this.inspect(actor, input.installationId), operation.id);
      if (!["reconciling", "active"].includes(current.state)) await this.dependencies.abortActivation?.(input.installationId, claimed.operation);
      await this.failure(actor, input.installationId, operation.id, holder, fence, error);
    }
    return this.operation(await this.inspect(actor, input.installationId), operation.id);
  }

  async reconcile(actor: LifecycleActor, installationId: string): Promise<void> {
    const state = await this.inspect(actor, installationId);
    const installation = state.installation;
    if (installation.acknowledgedGeneration === installation.generation) return;
    const release = installation.enabled && installation.activeReleaseId ? this.release(state, installation.activeReleaseId) : null;
    await this.dependencies.publish(installation, release);
    await this.transaction(actor, installationId, (current) => {
      if (current.installation.generation !== installation.generation) return;
      current.installation.acknowledgedGeneration = installation.generation;
      current.installation.status = installation.enabled ? "active" : "disabled";
      for (const operation of Object.values(current.operations)) if (operation.kind === "activate" && operation.state === "reconciling" && operation.releaseId === installation.activeReleaseId) this.transition(operation, installation.enabled ? "active" : "cancelled");
    });
  }

  async cancel(actor: LifecycleActor, installationId: string, operationId: string): Promise<LifecycleOperation> {
    const operation = await this.transaction(actor, installationId, (state) => {
      const current = this.operation(state, operationId);
      if (["active", "verified", "reconciling"].includes(current.state)) throw new LifecycleError("operation_committed", "A committed operation cannot be cancelled.");
      this.transition(current, "cancelled");
      return current;
    });
    if (operation.kind === "build" && operation.lease) await this.dependencies.runner.cancel(operation.lease.holder);
    return operation;
  }

  async revokeApproval(actor: LifecycleActor, installationId: string, approvalId: string): Promise<LifecycleApproval> {
    if (actor.kind !== "human") throw new LifecycleError("human_approval_required", "Only an authenticated human can revoke approval.");
    await this.dependencies.authorize(actor, "approve");
    return this.transaction(actor, installationId, (state) => {
      const approval = this.approval(state, approvalId);
      if (approval.status === "consumed") throw new LifecycleError("operation_committed", "Disable the installation to revoke an active release.");
      approval.status = "revoked";
      return approval;
    });
  }

  private async stop(actor: LifecycleActor, installationId: string, uninstall: boolean): Promise<InstallationRecord> {
    await this.dependencies.authorize(actor, uninstall ? "uninstall" : "disable");
    await this.transaction(actor, installationId, (state) => {
      state.installation.enabled = false;
      state.installation.generation += 1;
      state.installation.status = "reconciling";
      state.installation.uninstalled ||= uninstall;
      state.installation.grants = [];
      for (const approval of Object.values(state.approvals)) if (approval.status === "pending" || approval.status === "approved") approval.status = "revoked";
      for (const operation of Object.values(state.operations)) if (operation.kind === "activate" && !["active", "failed", "cancelled"].includes(operation.state)) this.transition(operation, "cancelled");
    });
    await this.reconcile(actor, installationId);
    return (await this.inspect(actor, installationId)).installation;
  }

  async disable(actor: LifecycleActor, installationId: string): Promise<InstallationRecord> { return this.stop(actor, installationId, false); }
  async uninstall(actor: LifecycleActor, installationId: string): Promise<InstallationRecord> { return this.stop(actor, installationId, true); }
  async rollback(actor: LifecycleActor, input: { installationId: string; approvalId: string; idempotencyKey: string }): Promise<LifecycleOperation> { return this.activate(actor, { ...input, rollback: true }); }

  async recover(actor: LifecycleActor, installationId: string): Promise<void> {
    await this.reconcile(actor, installationId);
    const state = await this.inspect(actor, installationId);
    if (state.installation.uninstalled) return;
    for (const operation of Object.values(state.operations)) {
      if (operation.lease && operation.lease.until > this.now()) continue;
      if (operation.kind === "build" && ["queued", "building", "verifying"].includes(operation.state)) await this.runBuild(actor, installationId, operation.id);
      if (operation.kind === "activate" && ["awaiting_approval", "activating"].includes(operation.state)) await this.activate(actor, { installationId, approvalId: operation.approvalId!, idempotencyKey: operation.idempotencyKey, rollback: operation.rollback });
    }
  }
}
