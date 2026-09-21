import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { validateProviderMethodValue, type ProviderCall, type ProviderError, type ProviderFailedReceipt, type ProviderReceipt, type ProviderSucceededReceipt, type ProviderUnknownReceipt, type SandboxCreateInput, type SandboxCreateResult, type SandboxDestroyInput, type SandboxDestroyResult, type SandboxFileChmodInput, type SandboxFileChmodResult, type SandboxFileListInput, type SandboxFileListResult, type SandboxFileMkdirInput, type SandboxFileMkdirResult, type SandboxFileReadInput, type SandboxFileReadResult, type SandboxFileRemoveInput, type SandboxFileRemoveResult, type SandboxFileStat, type SandboxFileStatInput, type SandboxFileStatResult, type SandboxFileWriteInput, type SandboxFileWriteResult, type SandboxInspectInput, type SandboxInspectResult, type SandboxProcessCancelInput, type SandboxProcessCancelResult, type SandboxProcessInspectInput, type SandboxProcessInspectResult, type SandboxProcessReadOutputInput, type SandboxProcessReadOutputResult, type SandboxProcessStartInput, type SandboxProcessStartResult, type SandboxStartInput, type SandboxStartResult, type SandboxStopInput, type SandboxStopResult } from "@ezcorp/extension-contract";
import { CONFIG_LABEL, RESOURCE_LABEL, configurationDigest, containerIdFromCreateOutput, createContainerArgv, expectedContainerIdentity, resourcePaths, runBoundedCommand, validateHostConfig, validateProcessConfinement, type BoundedCommandResult, type LocalPodmanHostConfig } from "./commands";
import { ResourceRoot } from "./resource-root";
import { WorkspaceImage } from "./workspace-image";
import { DurableOperationJournal, type RecoverableMutationBegin } from "./journal";
import { LocalProcessSupervisor, type OwnedProcessResource } from "./supervisor";
import { LocalWorkspaceFileError, LocalWorkspaceFiles } from "./files";

type Metadata = { resourceId: string; containerId: string; containerName: string; configDigest: string; scope: ProviderCall["scope"]; bootId?: string; state: "stopped" | "running" | "destroying" | "unknown"; limits: SandboxCreateInput["limits"] };
type CreateReservation = { version: 1; state: "creating"; phase: "reserved" | "workspace" | "container"; resourceId: string; containerName: string; configDigest: string; scope: ProviderCall["scope"]; call: ProviderCall; limits: SandboxCreateInput["limits"] };
type InspectMount = { Type?: string; Source?: string; Destination?: string; RW?: boolean };
type InspectContainer = { Id?: string; Name?: string; Image?: string; State?: { Running?: boolean; Pid?: number }; Config?: { Image?: string; User?: string; Labels?: Record<string, string> }; HostConfig?: { NetworkMode?: string; UsernsMode?: string; PidMode?: string; IpcMode?: string; UtsMode?: string | null; Privileged?: boolean; CapDrop?: string[]; SecurityOpt?: string[]; ReadonlyRootfs?: boolean; Memory?: number; MemorySwap?: number; NanoCpus?: number; PidsLimit?: number }; Mounts?: InspectMount[] };
type FileMutationRecovery = { version: 1; prior: SandboxFileStat | null };
const PODMAN_OUTPUT_LIMIT = 64 * 1024;
const PODMAN_TIMEOUT_MS = 30_000;
const PODMAN_CREATE_TIMEOUT_MS = 120_000;

class ContainerConfinementError extends Error {
  constructor(readonly stopped: boolean) { super("container process confinement is unavailable"); }
}

function receipt(call: ProviderCall, outcome: "succeeded"): ProviderSucceededReceipt;
function receipt(call: ProviderCall, outcome: "failed", error: ProviderError): ProviderFailedReceipt;
function receipt(call: ProviderCall, outcome: "unknown", error: ProviderError): ProviderUnknownReceipt;
function receipt(call: ProviderCall, outcome: "succeeded" | "failed" | "unknown", error?: ProviderError): ProviderReceipt {
  const identity = { operationId: call.operationId, idempotencyKey: call.idempotencyKey, requestDigest: call.requestDigest };
  if (outcome === "succeeded") return { ...identity, outcome };
  if (outcome === "failed") return { ...identity, outcome, error: error! };
  return { ...identity, outcome, error };
}

async function serialized<T>(locks: Map<string, Promise<void>>, key: string, effect: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const lock = Promise.withResolvers<void>();
  const queued = previous.then(() => lock.promise);
  locks.set(key, queued);
  await previous;
  try { return await effect(); }
  finally { lock.resolve(); if (locks.get(key) === queued) locks.delete(key); }
}

export class LocalPodmanDriver {
  private readonly config: LocalPodmanHostConfig; private readonly roots: ResourceRoot; private readonly images: WorkspaceImage; private readonly journal: DurableOperationJournal; private readonly supervisor: LocalProcessSupervisor; private readonly fileSystems = new Map<string, LocalWorkspaceFiles>(); private readonly destroyLocks = new Map<string, Promise<void>>(); private readonly transitionLocks = new Map<string, Promise<void>>(); private runtimeProof?: Promise<void>;
  private readonly readProcessStatus: (pid: number) => Promise<string>;
  constructor(config: LocalPodmanHostConfig, dependencies: { workspaceImage?: WorkspaceImage; readProcessStatus?: (pid: number) => Promise<string> } = {}) { this.config = validateHostConfig(config); this.roots = new ResourceRoot(this.config.stateRoot); this.images = dependencies.workspaceImage ?? new WorkspaceImage(this.config); this.readProcessStatus = dependencies.readProcessStatus ?? ((pid) => readFile(`/proc/${pid}/status`, "utf8")); this.journal = new DurableOperationJournal(`${this.config.stateRoot}/operations`); this.supervisor = new LocalProcessSupervisor({ stateRoot: this.config.stateRoot, podmanPath: this.config.podmanPath, supervisorPath: this.config.supervisorPath, maxOutputBytes: 1024 * 1024, workspaceUid: this.config.workspaceUid, workspaceGid: this.config.workspaceGid }, (resourceId) => this.resolveProcessResource(resourceId)); }
  private async mutate<T extends { receipt: unknown }>(call: SandboxCreateInput["call"], effect: () => Promise<T>): Promise<T> {
    const begun = await this.journal.begin<T>(call);
    if (begun.kind === "replay") return begun.result;
    if (begun.kind === "unknown") return { receipt: begun.receipt } as T;
    const result = await effect(); await this.journal.complete(call, result); return result;
  }
  private async recoverableTransition<T extends { receipt: ProviderReceipt }>(call: ProviderCall, effect: () => Promise<T>): Promise<T> {
    const key = `${call.scope.projectId}\0${call.scope.bindingId}\0${call.scope.generation}`;
    return serialized(this.transitionLocks, key, async () => {
      const begun = await this.journal.beginRecoverable<T>(call);
      if (begun.kind === "replay" && begun.result.receipt.outcome !== "unknown") return begun.result;
      const result = await effect();
      if (result.receipt.outcome !== "unknown") await this.journal.completeRecovered(call, result);
      return result;
    });
  }
  private interruptedFileMutation<T>(call: ProviderCall): T {
    return { receipt: receipt(call, "failed", { code: "interrupted_mutation_aborted", message: "The interrupted workspace mutation has no verified state transition.", retryable: false }) } as T;
  }
  private async mutateFile<T extends { receipt: ProviderReceipt }>(call: ProviderCall, prepare: () => Promise<FileMutationRecovery>, effect: () => Promise<T>, recover: (recovery: FileMutationRecovery) => Promise<T | undefined>): Promise<T> {
    let begun: RecoverableMutationBegin<T, FileMutationRecovery>;
    try { begun = await this.journal.beginRecoverableMutation<T, FileMutationRecovery>(call, prepare); }
    catch (error) { return this.mutate(call, async () => this.fileFailure(call, error) as T); }
    if (begun.kind === "replay") return begun.result;
    let result: T;
    if (begun.kind === "new") result = await effect();
    else {
      try { result = await recover(begun.recovery) ?? this.interruptedFileMutation<T>(call); }
      catch { result = this.interruptedFileMutation<T>(call); }
    }
    await this.journal.complete(call, result);
    return result;
  }
  private statInput(input: { call: ProviderCall; resourceId: string; path: string }): SandboxFileStatInput {
    return { call: input.call, resourceId: input.resourceId, path: input.path };
  }
  private async prepareFileMutation(files: LocalWorkspaceFiles, input: { call: ProviderCall; resourceId: string; path: string }): Promise<FileMutationRecovery> {
    try { return { version: 1, prior: (await files.stat(this.statInput(input))).entry }; }
    catch (error) {
      if (error instanceof LocalWorkspaceFileError && error.reason === "not_found") return { version: 1, prior: null };
      throw error;
    }
  }
  private expectedRevisionMatches(input: { expectedRevision?: string }, recovery: FileMutationRecovery): boolean {
    return recovery.version === 1 && (input.expectedRevision === undefined || input.expectedRevision === recovery.prior?.revision);
  }
  private stateTransitioned(recovery: FileMutationRecovery, observed: SandboxFileStat): boolean {
    return recovery.version === 1 && (recovery.prior === null || recovery.prior.revision !== observed.revision);
  }
  async create(input: SandboxCreateInput): Promise<SandboxCreateResult> {
    validateProviderMethodValue("sandbox.lifecycle.v1", "create", "input", input);
    await this.roots.verifyPrivateRoot(); await this.verifyRuntime();
    const begun = await this.journal.beginRecoverable<SandboxCreateResult>(input.call); if (begun.kind === "replay") return begun.result;
    const identity = createHash("sha256").update(JSON.stringify({ scope: input.call.scope, operationId: input.call.operationId, idempotencyKey: input.call.idempotencyKey, requestDigest: input.call.requestDigest })).digest("hex");
    const resourceId = `r-${identity.slice(0, 48)}`; const paths = this.roots.paths(resourceId); const containerName = `ez-local-${resourceId}`; const configDigest = configurationDigest(this.config, input.limits);
    let reservation: CreateReservation;
    const reserve = async () => { await this.roots.initialize(resourceId); const value: CreateReservation = { version: 1, state: "creating", phase: "reserved", resourceId, containerName, configDigest, scope: input.call.scope, call: input.call, limits: input.limits }; await this.roots.writeMetadata(resourceId, value); return value; };
    if (begun.kind === "new") reservation = await reserve();
    else { let stored: CreateReservation | Metadata; try { stored = await this.roots.readMetadata<CreateReservation | Metadata>(resourceId); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; stored = await reserve(); }
      if (stored.state === "stopped") { if (stored.resourceId !== resourceId || stored.containerName !== containerName || stored.configDigest !== configDigest || JSON.stringify(stored.scope) !== JSON.stringify(input.call.scope)) throw new Error("create final metadata mismatch"); try { if (await this.verify(stored)) throw new Error("created container unexpectedly running"); } catch (error) { if (error instanceof Error && error.message === "created container unexpectedly running") throw error; throw new Error("create final identity mismatch"); } const result = { receipt: receipt(input.call, "succeeded"), resource: { resourceId, desiredState: "stopped", observedState: "stopped", limits: input.limits } } as SandboxCreateResult; await this.journal.complete(input.call, result); return result; }
      if (stored.state !== "creating") throw new Error("create reservation mismatch"); reservation = stored; if (JSON.stringify(reservation.call) !== JSON.stringify(input.call) || reservation.configDigest !== configDigest) throw new Error("create reservation mismatch"); }
    if (reservation.phase === "reserved") { if (begun.kind === "recover") await this.images.recoverCreate(paths.image, paths.mount, input.limits.diskBytes); else await this.images.create(paths.image, paths.mount, input.limits.diskBytes); reservation.phase = "workspace"; await this.roots.writeMetadata(resourceId, reservation); }
    const adopt = async (): Promise<SandboxCreateResult | undefined> => {
      const inspected = await this.podman(["inspect", containerName]); if (inspected.code !== 0 || inspected.timedOut) return undefined;
      let values: InspectContainer[]; try { values = JSON.parse(inspected.stdout) as InspectContainer[]; } catch { return undefined; } if (!Array.isArray(values) || values.length !== 1 || typeof values[0]?.Id !== "string") return undefined;
      const metadata: Metadata = { resourceId, containerId: values[0].Id, containerName, configDigest, scope: input.call.scope, state: "stopped", limits: input.limits };
      try { if (await this.verify(metadata)) return undefined; } catch { return undefined; }
      await this.roots.writeMetadata(resourceId, metadata); const result = { receipt: receipt(input.call, "succeeded"), resource: { resourceId, desiredState: "stopped", observedState: "stopped", limits: input.limits } } as SandboxCreateResult; await this.journal.complete(input.call, result); return result;
    };
    if (reservation.phase === "container") { const recovered = await adopt(); if (recovered) return recovered; }
    reservation.phase = "container"; await this.roots.writeMetadata(resourceId, reservation);
    const argv = createContainerArgv(this.config, resourceId, containerName, paths.mount, input.limits);
    const { code, stdout, timedOut } = await runBoundedCommand(argv, { timeoutMs: PODMAN_CREATE_TIMEOUT_MS, maxOutputBytes: PODMAN_OUTPUT_LIMIT });
    if (code !== 0) {
      const recovered = await adopt(); if (recovered) return recovered;
      if (timedOut) return { receipt: receipt(input.call, "unknown", { code: "create_unknown", message: "Container creation outcome is unknown.", retryable: true }) };
      const absent = await this.podman(["container", "exists", containerName]); if (absent.timedOut || absent.code !== 1) return { receipt: receipt(input.call, "unknown", { code: "create_unknown", message: "Container creation outcome is unknown.", retryable: true }) };
      try { await this.images.destroy(paths.image, paths.mount); await this.roots.destroy(resourceId); }
      catch { return { receipt: receipt(input.call, "unknown", { code: "cleanup_unknown", message: "Workspace cleanup outcome is unknown.", retryable: true }) }; }
      const failed = { receipt: receipt(input.call, "failed", { code: "create_failed_clean", message: "Container creation failed and owned resources were removed.", retryable: false }) } as SandboxCreateResult; await this.journal.complete(input.call, failed); return failed;
    }
    const containerId = containerIdFromCreateOutput(stdout);
    if (containerId === null) { const recovered = await adopt(); if (recovered) return recovered; return { receipt: receipt(input.call, "unknown", { code: "create_identity_unknown", message: "Podman did not return an exact container ID.", retryable: true }) } as SandboxCreateResult; }
    const metadata: Metadata = { resourceId, containerId, containerName, configDigest, scope: input.call.scope, state: "stopped", limits: input.limits }; await this.roots.writeMetadata(resourceId, metadata);
    const result = { receipt: receipt(input.call, "succeeded"), resource: { resourceId, desiredState: "stopped", observedState: "stopped", limits: input.limits } } as SandboxCreateResult; await this.journal.complete(input.call, result); return result;
  }
  async inspect(input: SandboxInspectInput): Promise<SandboxInspectResult> {
    validateProviderMethodValue("sandbox.lifecycle.v1", "inspect", "input", input);
    const authorized = await this.authorize(input.resourceId, input.call); if (!("value" in authorized)) return authorized;
    const value = authorized.value;
    if (value.state !== "destroying") { try { const running = await this.verify(value); if (value.state !== "unknown" && (value.state === "running") !== running) { value.state = running ? "running" : "stopped"; await this.roots.writeMetadata(value.resourceId, value); } } catch (error) { return this.verificationFailure(input.call, error); } }
    return { receipt: receipt(input.call, "succeeded"), resource: { resourceId: value.resourceId, desiredState: value.state === "running" ? "running" : value.state === "destroying" ? "destroyed" : "stopped", observedState: value.state, limits: value.limits } as const };
  }
  private podman(args: string[]): Promise<BoundedCommandResult> { return runBoundedCommand([this.config.podmanPath, "--remote=false", ...args], { timeoutMs: PODMAN_TIMEOUT_MS, maxOutputBytes: PODMAN_OUTPUT_LIMIT }); }
  private verifyRuntime(): Promise<void> { return this.runtimeProof ??= (async () => { const result = await this.podman(["info", "--format", "{{.Host.Security.Rootless}} {{.Host.CgroupsVersion}} {{.Host.Security.SeccompEnabled}}"]); if (result.code !== 0 || result.timedOut || result.stdout.trim() !== "true v2 true") throw new Error("Local runtime requires rootless Podman with cgroup v2 and seccomp"); })(); }
  private async rejectUnconfinedContainer(value: Metadata): Promise<never> {
    const stopped = await this.podman(["stop", "--time", "1", value.containerId]);
    throw new ContainerConfinementError(stopped.code === 0 && !stopped.timedOut);
  }
  private matchesContainerIdentity(live: InspectContainer, value: Metadata, expected: ReturnType<typeof expectedContainerIdentity>): boolean {
    return live.Id === value.containerId && live.Name === expected.containerName && live.Image === expected.imageId && live.Config?.Image === expected.imageReference && live.Config?.User === expected.user && live.Config?.Labels?.[RESOURCE_LABEL] === expected.labels[RESOURCE_LABEL] && live.Config?.Labels?.[CONFIG_LABEL] === value.configDigest && value.configDigest === expected.labels[CONFIG_LABEL] && typeof live.State?.Running === "boolean";
  }
  private matchesHostProfile(live: InspectContainer, expected: ReturnType<typeof expectedContainerIdentity>, bindMounts: Array<{ source: string | undefined; destination: string | undefined; readWrite: boolean | undefined }>, expectedMounts: Array<{ source: string; destination: string; readWrite: boolean }>): boolean {
    return live.HostConfig?.NetworkMode === expected.networkMode && live.HostConfig?.UsernsMode === "" && live.HostConfig?.PidMode === expected.pidMode && live.HostConfig?.IpcMode === expected.ipcMode && (live.HostConfig?.UtsMode ?? null) === expected.utsMode && live.HostConfig?.Privileged === expected.privileged && JSON.stringify(live.HostConfig?.CapDrop) === JSON.stringify(expected.capDrop) && JSON.stringify(live.HostConfig?.SecurityOpt) === JSON.stringify(expected.securityOpt) && live.HostConfig?.ReadonlyRootfs === expected.readonlyRootfs && live.HostConfig?.Memory === expected.memoryBytes && live.HostConfig?.MemorySwap === expected.memorySwapBytes && live.HostConfig?.NanoCpus === expected.nanoCpus && live.HostConfig?.PidsLimit === expected.pids && JSON.stringify(bindMounts) === JSON.stringify(expectedMounts);
  }
  private async verifyProcessConfinement(value: Metadata, live: InspectContainer): Promise<void> {
    if (!live.State?.Running) return;
    if (!Number.isSafeInteger(live.State.Pid) || live.State.Pid! <= 0) return this.rejectUnconfinedContainer(value);
    try { validateProcessConfinement(await this.readProcessStatus(live.State.Pid!)); }
    catch { return this.rejectUnconfinedContainer(value); }
  }
  private async verify(value: Metadata): Promise<boolean> {
    const { code, stdout, timedOut } = await this.podman(["inspect", value.containerId]); if (code !== 0 || timedOut) throw new Error("owned container identity is unavailable");
    const parsed = JSON.parse(stdout) as unknown; if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("owned container identity mismatch");
    const live = parsed[0] as InspectContainer; const paths = resourcePaths(this.config.stateRoot, value.resourceId); const expected = expectedContainerIdentity(this.config, value.resourceId, value.containerName, paths.mount, value.limits);
    const bindMounts = (live.Mounts ?? []).filter((entry) => entry.Type === "bind").map((entry) => ({ source: entry.Source, destination: entry.Destination, readWrite: entry.RW })).sort((left, right) => String(left.destination).localeCompare(String(right.destination)));
    const expectedMounts = expected.bindMounts.map((entry) => ({ source: entry.source, destination: entry.destination, readWrite: entry.readWrite })).sort((left, right) => left.destination.localeCompare(right.destination));
    if (!this.matchesContainerIdentity(live, value, expected) || !this.matchesHostProfile(live, expected, bindMounts, expectedMounts)) throw new Error("owned container identity mismatch");
    await this.verifyProcessConfinement(value, live);
    return live.State?.Running === true;
  }
  private identityMismatch(call: SandboxCreateInput["call"]) { return { receipt: receipt(call, "failed", { code: "identity_mismatch", message: "Owned container identity mismatch.", retryable: false }) }; }
  private confinementFailure(call: ProviderCall, error: ContainerConfinementError) {
    if (error.stopped) return { receipt: receipt(call, "failed", { code: "confinement_unverified", message: "Container process confinement could not be verified.", retryable: false }) };
    return { receipt: receipt(call, "unknown", { code: "running_unknown", message: "Container confinement could not be verified and stop outcome is unknown.", retryable: true }) };
  }
  private verificationFailure(call: ProviderCall, error: unknown) { return error instanceof ContainerConfinementError ? this.confinementFailure(call, error) : this.identityMismatch(call); }
  private async authorize(resourceId: string, call: ProviderCall): Promise<{ value: Metadata } | { receipt: ProviderFailedReceipt }> {
    await this.roots.verifyPrivateRoot(); await this.verifyRuntime();
    let value: Metadata; try { value = await this.roots.readMetadata<Metadata>(resourceId); } catch { return { receipt: receipt(call, "failed", { code: "not_found", message: "Resource not found.", retryable: false }) }; }
    const scope = value.scope; if (!scope || scope.projectId !== call.scope.projectId || scope.bindingId !== call.scope.bindingId || scope.generation !== call.scope.generation) return { receipt: receipt(call, "failed", { code: "scope_mismatch", message: "Resource scope mismatch.", retryable: false }) };
    return { value };
  }
  private async transition(input: SandboxStartInput | SandboxStopInput, target: "running" | "stopped", value: Metadata): Promise<SandboxStartResult | SandboxStopResult> {
    if (value.state === "destroying") return { receipt: receipt(input.call, "failed", { code: "resource_destroying", message: "Resource destruction is in progress.", retryable: false }) };
    let running: boolean; try { running = await this.verify(value); } catch (error) {
      return this.verificationFailure(input.call, error);
    } if (running === (target === "running")) { const enteredRunning = target === "running" && value.state !== "running"; value.state = target; if (enteredRunning) value.bootId = crypto.randomUUID(); await this.roots.writeMetadata(value.resourceId, value); return { receipt: receipt(input.call, "succeeded"), resource: { resourceId: value.resourceId, desiredState: target, observedState: target, limits: value.limits } }; } const result = await this.podman([target === "running" ? "start" : "stop", value.containerId]);
    if (result.code !== 0 || result.timedOut) return { receipt: receipt(input.call, "unknown", { code: `${target}_unknown`, message: `Container ${target} outcome is unknown.`, retryable: true }) };
    if (target === "running") {
      try { if (!(await this.verify(value))) throw new Error("container did not start"); }
      catch (error) {
        if (error instanceof ContainerConfinementError) return this.confinementFailure(input.call, error);
        const stopped = await this.podman(["stop", "--time", "1", value.containerId]);
        if (stopped.code !== 0 || stopped.timedOut) return { receipt: receipt(input.call, "unknown", { code: "running_unknown", message: "Container confinement could not be verified and stop outcome is unknown.", retryable: true }) };
        return { receipt: receipt(input.call, "failed", { code: "confinement_unverified", message: "Container process confinement could not be verified.", retryable: false }) };
      }
    }
    value.state = target; if (target === "running") value.bootId = crypto.randomUUID(); await this.roots.writeMetadata(value.resourceId, value);
    return { receipt: receipt(input.call, "succeeded"), resource: { resourceId: value.resourceId, desiredState: target, observedState: target, limits: value.limits } };
  }
  async start(input: SandboxStartInput): Promise<SandboxStartResult> { validateProviderMethodValue("sandbox.lifecycle.v1", "start", "input", input); const authorized = await this.authorize(input.resourceId, input.call); if (!("value" in authorized)) return authorized; return this.recoverableTransition(input.call, () => this.transition(input, "running", authorized.value)); }
  async stop(input: SandboxStopInput): Promise<SandboxStopResult> { validateProviderMethodValue("sandbox.lifecycle.v1", "stop", "input", input); const authorized = await this.authorize(input.resourceId, input.call); if (!("value" in authorized)) return authorized; return this.recoverableTransition(input.call, () => this.transition(input, "stopped", authorized.value)); }
  private async finishDestroyed(input: SandboxDestroyInput, result: SandboxDestroyResult): Promise<SandboxDestroyResult> {
    if (!("resource" in result) || result.resource.resourceId !== input.resourceId) throw new Error("destroyed resource identity mismatch");
    try { await this.roots.destroy(result.resource.resourceId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { receipt: receipt(input.call, "unknown", { code: "cleanup_unknown", message: "Workspace cleanup outcome is unknown.", retryable: true }) }; }
    this.fileSystems.delete(result.resource.resourceId); return result;
  }
  async destroy(input: SandboxDestroyInput): Promise<SandboxDestroyResult> {
    validateProviderMethodValue("sandbox.lifecycle.v1", "destroy", "input", input);
    await this.roots.verifyPrivateRoot();
    return serialized(this.destroyLocks, input.resourceId, async () => {
      const replay = await this.journal.completed<SandboxDestroyResult>(input.call);
      if (replay) return replay.receipt.outcome === "succeeded" ? await this.finishDestroyed(input, replay) : replay;
      let tombstone: SandboxDestroyResult | undefined;
      try { tombstone = await this.journal.destroyed<SandboxDestroyResult>(input.resourceId, input.call.scope); }
      catch { return { receipt: receipt(input.call, "failed", { code: "scope_mismatch", message: "Resource scope mismatch.", retryable: false }) }; }
      if (tombstone) {
        if (!("resource" in tombstone) || tombstone.resource.resourceId !== input.resourceId) throw new Error("destroyed resource identity mismatch");
        const result = { ...tombstone, receipt: receipt(input.call, "succeeded") } as SandboxDestroyResult;
        const begun = await this.journal.beginRecoverable<SandboxDestroyResult>(input.call); if (begun.kind === "replay") return begun.result.receipt.outcome === "succeeded" ? await this.finishDestroyed(input, begun.result) : begun.result;
        await this.journal.complete(input.call, result);
        return await this.finishDestroyed(input, result);
      }
      const authorized = await this.authorize(input.resourceId, input.call); if (!("value" in authorized)) return authorized;
      const begun = await this.journal.beginRecoverable<SandboxDestroyResult>(input.call); if (begun.kind === "replay") return begun.result.receipt.outcome === "succeeded" ? await this.finishDestroyed(input, begun.result) : begun.result;
      const value = authorized.value;
      if (value.state !== "destroying") { try { await this.verify(value); } catch (error) { const failed = this.verificationFailure(input.call, error); await this.journal.complete(input.call, failed); return failed; } value.state = "destroying"; await this.roots.writeMetadata(value.resourceId, value); }
      const live = await this.podman(["inspect", value.containerId]);
      if (live.timedOut) return { receipt: receipt(input.call, "unknown", { code: "destroy_unknown", message: "Container destroy outcome is unknown.", retryable: true }) };
      if (live.code === 0) { try { await this.verify(value); } catch (error) { const failed = this.verificationFailure(input.call, error); await this.journal.complete(input.call, failed); return failed; } const removed = await this.podman(["rm", "--force", "--volumes", value.containerId]); if (removed.code !== 0 || removed.timedOut) return { receipt: receipt(input.call, "unknown", { code: "destroy_unknown", message: "Container destroy outcome is unknown.", retryable: true }) }; }
      else { const absent = await this.podman(["container", "exists", value.containerName]); if (absent.timedOut || absent.code !== 1) return { receipt: receipt(input.call, "unknown", { code: "destroy_unknown", message: "Container destroy outcome is unknown.", retryable: true }) }; }
      const paths = resourcePaths(this.config.stateRoot, value.resourceId); try { await this.images.destroy(paths.image, paths.mount); } catch { return { receipt: receipt(input.call, "unknown", { code: "cleanup_unknown", message: "Workspace cleanup outcome is unknown.", retryable: true }) }; }
      const result = { receipt: receipt(input.call, "succeeded"), resource: { resourceId: value.resourceId, desiredState: "destroyed", observedState: "destroyed", limits: value.limits } } as SandboxDestroyResult;
      await this.journal.recordDestroyed(value.resourceId, input.call, result);
      await this.journal.complete(input.call, result);
      return await this.finishDestroyed(input, result);
    });
  }
  private async resolveProcessResource(resourceId: string): Promise<OwnedProcessResource> {
    await this.roots.verifyPrivateRoot(); const value = await this.roots.readMetadata<Metadata>(resourceId); if (!value.bootId || value.state === "destroying") throw new Error("Resource has no process generation"); await this.verify(value); const paths = resourcePaths(this.config.stateRoot, resourceId);
    return { resourceId, containerId: value.containerId, containerName: value.containerName, scope: value.scope, processRoot: `${paths.output}/process`, bootId: value.bootId };
  }
  async processStart(input: SandboxProcessStartInput): Promise<SandboxProcessStartResult> { const authorized = await this.authorize(input.resourceId, input.call); if (!("value" in authorized)) return authorized; let running: boolean; try { running = await this.verify(authorized.value); } catch (error) { return this.verificationFailure(input.call, error); } if (authorized.value.state !== "running" || !running) return { receipt: receipt(input.call, "failed", { code: "resource_not_running", message: "Process start requires a running resource.", retryable: false }) }; return this.supervisor.start(input); }
  processInspect(input: SandboxProcessInspectInput): Promise<SandboxProcessInspectResult> { return this.supervisor.inspect(input); }
  processReadOutput(input: SandboxProcessReadOutputInput): Promise<SandboxProcessReadOutputResult> { return this.supervisor.readOutput(input); }
  processCancel(input: SandboxProcessCancelInput): Promise<SandboxProcessCancelResult> { return this.supervisor.cancel(input); }
  private fileFailure(call: ProviderCall, error: unknown) { const code = error instanceof LocalWorkspaceFileError ? error.code : "file_failed"; return { receipt: receipt(call, "failed", { code, message: "Workspace file operation failed.", retryable: false }) }; }
  private async fileContext(input: { resourceId: string; call: ProviderCall }): Promise<{ files: LocalWorkspaceFiles } | { receipt: ProviderFailedReceipt | ProviderUnknownReceipt }> {
    const authorized = await this.authorize(input.resourceId, input.call); if (!("value" in authorized)) return authorized; let running: boolean; try { running = await this.verify(authorized.value); } catch (error) { return this.verificationFailure(input.call, error); } if (!running && authorized.value.state === "running") { authorized.value.state = "stopped"; await this.roots.writeMetadata(input.resourceId, authorized.value); } if (running || authorized.value.state !== "stopped") return { receipt: receipt(input.call, "failed", { code: "resource_not_stopped", message: "Workspace files require a stopped resource.", retryable: false }) };
    const paths = resourcePaths(this.config.stateRoot, input.resourceId); const statusPath = `${paths.output}/process/status.json`; try { const file = await open(statusPath, "r"); try { const info = await file.stat(); if (info.size > 2 * 1024 * 1024) throw new Error("invalid process status"); const status = JSON.parse(await file.readFile("utf8")) as { state?: string }; if (status.state === "starting" || status.state === "running") return { receipt: receipt(input.call, "failed", { code: "process_active", message: "Workspace has an active process.", retryable: false }) }; } finally { await file.close(); } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { receipt: receipt(input.call, "failed", { code: "process_state_unknown", message: "Process state cannot be verified.", retryable: false }) }; }
    let files = this.fileSystems.get(input.resourceId); if (!files) { files = new LocalWorkspaceFiles(paths.mount, { maxReadBytes: 256 * 1024, maxWriteBytes: 256 * 1024, maxListEntries: 256 }); this.fileSystems.set(input.resourceId, files); } return { files };
  }
  async fileStat(input: SandboxFileStatInput): Promise<SandboxFileStatResult> { validateProviderMethodValue("sandbox.files.v1", "stat", "input", input); const context = await this.fileContext(input); if (!("files" in context)) return context; try { return { receipt: receipt(input.call, "succeeded"), ...(await context.files.stat(input)) }; } catch (error) { return this.fileFailure(input.call, error); } }
  async fileList(input: SandboxFileListInput): Promise<SandboxFileListResult> { validateProviderMethodValue("sandbox.files.v1", "list", "input", input); const context = await this.fileContext(input); if (!("files" in context)) return context; try { return { receipt: receipt(input.call, "succeeded"), ...(await context.files.list(input)) }; } catch (error) { return this.fileFailure(input.call, error); } }
  async fileRead(input: SandboxFileReadInput): Promise<SandboxFileReadResult> { validateProviderMethodValue("sandbox.files.v1", "read", "input", input); const context = await this.fileContext(input); if (!("files" in context)) return context; try { return { receipt: receipt(input.call, "succeeded"), ...(await context.files.read(input)) }; } catch (error) { return this.fileFailure(input.call, error); } }
  async fileWrite(input: SandboxFileWriteInput): Promise<SandboxFileWriteResult> {
    validateProviderMethodValue("sandbox.files.v1", "write", "input", input); const context = await this.fileContext(input); if (!("files" in context)) return context;
    return this.mutateFile(input.call, () => this.prepareFileMutation(context.files, input), async () => { try { return { receipt: receipt(input.call, "succeeded"), ...(await context.files.write(input)) }; } catch (error) { return this.fileFailure(input.call, error); } }, async (recovery) => {
      if (!this.expectedRevisionMatches(input, recovery)) return undefined;
      const expected = Buffer.from(input.data, input.encoding === "utf8" ? "utf8" : "base64");
      const observed = await context.files.stat(this.statInput(input));
      if (!this.stateTransitioned(recovery, observed.entry) || observed.entry.kind !== "file" || observed.entry.sizeBytes !== expected.byteLength) return undefined;
      if (expected.byteLength > 0) {
        const value = await context.files.read({ call: input.call, resourceId: input.resourceId, path: input.path, revision: observed.entry.revision, offsetBytes: 0, lengthBytes: expected.byteLength });
        const bytes = Buffer.from(value.data, value.encoding === "utf8" ? "utf8" : "base64");
        if (!bytes.equals(expected)) return undefined;
      }
      return { receipt: receipt(input.call, "succeeded"), entry: observed.entry };
    });
  }
  async fileMkdir(input: SandboxFileMkdirInput): Promise<SandboxFileMkdirResult> {
    validateProviderMethodValue("sandbox.files.v1", "mkdir", "input", input); const context = await this.fileContext(input); if (!("files" in context)) return context;
    return this.mutateFile(input.call, () => this.prepareFileMutation(context.files, input), async () => { try { return { receipt: receipt(input.call, "succeeded"), ...(await context.files.mkdir(input)) }; } catch (error) { return this.fileFailure(input.call, error); } }, async (recovery) => {
      if (recovery.version !== 1 || recovery.prior !== null) return undefined;
      const observed = await context.files.stat(this.statInput(input));
      return observed.entry.kind === "directory" ? { receipt: receipt(input.call, "succeeded"), entry: observed.entry } : undefined;
    });
  }
  async fileRemove(input: SandboxFileRemoveInput): Promise<SandboxFileRemoveResult> {
    validateProviderMethodValue("sandbox.files.v1", "remove", "input", input); const context = await this.fileContext(input); if (!("files" in context)) return context;
    return this.mutateFile(input.call, () => this.prepareFileMutation(context.files, input), async () => { try { return { receipt: receipt(input.call, "succeeded"), ...(await context.files.remove(input)) }; } catch (error) { return this.fileFailure(input.call, error); } }, async (recovery) => {
      if (!this.expectedRevisionMatches(input, recovery)) return undefined;
      try { await context.files.stat(this.statInput(input)); return undefined; }
      catch (error) {
        if (error instanceof LocalWorkspaceFileError && error.reason === "not_found" && recovery.prior !== null) return { receipt: receipt(input.call, "succeeded"), removedRevision: recovery.prior.revision };
        return undefined;
      }
    });
  }
  async fileChmod(input: SandboxFileChmodInput): Promise<SandboxFileChmodResult> {
    validateProviderMethodValue("sandbox.files.v1", "chmod", "input", input); const context = await this.fileContext(input); if (!("files" in context)) return context;
    return this.mutateFile(input.call, () => this.prepareFileMutation(context.files, input), async () => { try { return { receipt: receipt(input.call, "succeeded"), ...(await context.files.chmod(input)) }; } catch (error) { return this.fileFailure(input.call, error); } }, async (recovery) => {
      if (!this.expectedRevisionMatches(input, recovery)) return undefined;
      const observed = await context.files.stat(this.statInput(input));
      return this.stateTransitioned(recovery, observed.entry) && observed.entry.mode === input.mode ? { receipt: receipt(input.call, "succeeded"), entry: observed.entry } : undefined;
    });
  }
}
