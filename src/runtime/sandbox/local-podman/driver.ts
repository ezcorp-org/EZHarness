import { validateProviderMethodValue, type ProviderCall, type ProviderError, type ProviderFailedReceipt, type ProviderReceipt, type ProviderSucceededReceipt, type ProviderUnknownReceipt, type SandboxCreateInput, type SandboxCreateResult, type SandboxDestroyInput, type SandboxDestroyResult, type SandboxInspectInput, type SandboxInspectResult, type SandboxStartInput, type SandboxStartResult, type SandboxStopInput, type SandboxStopResult } from "@ezcorp/extension-contract";
import { CONFIG_LABEL, RESOURCE_LABEL, configurationDigest, containerIdFromCreateOutput, createContainerArgv, expectedContainerIdentity, resourcePaths, runBoundedCommand, validateHostConfig, type BoundedCommandResult, type LocalPodmanHostConfig } from "./commands";
import { ResourceRoot } from "./resource-root";
import { WorkspaceImage } from "./workspace-image";
import { DurableOperationJournal } from "./journal";

type Metadata = { resourceId: string; containerId: string; containerName: string; configDigest: string; state: "stopped" | "running" | "unknown"; limits: SandboxCreateInput["limits"] };
type InspectMount = { Type?: string; Source?: string; Destination?: string; RW?: boolean };
type InspectContainer = { Id?: string; Name?: string; Image?: string; Config?: { Image?: string; User?: string; Labels?: Record<string, string> }; HostConfig?: { NetworkMode?: string; ReadonlyRootfs?: boolean; Memory?: number; MemorySwap?: number; NanoCpus?: number; PidsLimit?: number }; Mounts?: InspectMount[] };
const PODMAN_OUTPUT_LIMIT = 64 * 1024;
const PODMAN_TIMEOUT_MS = 30_000;

function receipt(call: ProviderCall, outcome: "succeeded"): ProviderSucceededReceipt;
function receipt(call: ProviderCall, outcome: "failed", error: ProviderError): ProviderFailedReceipt;
function receipt(call: ProviderCall, outcome: "unknown", error: ProviderError): ProviderUnknownReceipt;
function receipt(call: ProviderCall, outcome: "succeeded" | "failed" | "unknown", error?: ProviderError): ProviderReceipt {
  const identity = { operationId: call.operationId, idempotencyKey: call.idempotencyKey, requestDigest: call.requestDigest };
  if (outcome === "succeeded") return { ...identity, outcome };
  if (outcome === "failed") return { ...identity, outcome, error: error! };
  return { ...identity, outcome, error };
}

export class LocalPodmanDriver {
  private readonly config: LocalPodmanHostConfig; private readonly roots: ResourceRoot; private readonly images: WorkspaceImage; private readonly journal: DurableOperationJournal;
  constructor(config: LocalPodmanHostConfig) { this.config = validateHostConfig(config); this.roots = new ResourceRoot(this.config.stateRoot); this.images = new WorkspaceImage(this.config); this.journal = new DurableOperationJournal(`${this.config.stateRoot}/operations`); }
  private async mutate<T extends { receipt: unknown }>(call: SandboxCreateInput["call"], effect: () => Promise<T>): Promise<T> {
    const begun = await this.journal.begin<T>(call);
    if (begun.kind === "replay") return begun.result;
    if (begun.kind === "unknown") return { receipt: begun.receipt } as T;
    const result = await effect(); await this.journal.complete(call, result); return result;
  }
  async create(input: SandboxCreateInput): Promise<SandboxCreateResult> {
    validateProviderMethodValue("sandbox.lifecycle.v1", "create", "input", input);
    return this.mutate(input.call, async () => {
    const resourceId = crypto.randomUUID(); const paths = await this.roots.initialize(resourceId); const containerName = `ez-local-${resourceId}`;
    await this.images.create(paths.image, paths.mount, input.limits.diskBytes);
    const argv = createContainerArgv(this.config, resourceId, containerName, paths.mount, input.limits);
    const { code, stdout, timedOut } = await runBoundedCommand(argv, { timeoutMs: PODMAN_TIMEOUT_MS, maxOutputBytes: PODMAN_OUTPUT_LIMIT });
    if (code !== 0) return timedOut
      ? { receipt: receipt(input.call, "unknown", { code: "create_unknown", message: "Container creation outcome is unknown.", retryable: true }) }
      : { receipt: receipt(input.call, "failed", { code: "create_failed", message: "Container creation failed.", retryable: false }) };
    const containerId = containerIdFromCreateOutput(stdout);
    if (containerId === null) return { receipt: receipt(input.call, "unknown", { code: "create_identity_unknown", message: "Podman did not return an exact container ID.", retryable: true }) } as SandboxCreateResult;
    const metadata: Metadata = { resourceId, containerId, containerName, configDigest: configurationDigest(this.config, input.limits), state: "stopped", limits: input.limits }; await this.roots.writeMetadata(resourceId, metadata);
    return { receipt: receipt(input.call, "succeeded"), resource: { resourceId, desiredState: "stopped", observedState: "stopped", limits: input.limits } } as SandboxCreateResult;
    });
  }
  async inspect(input: SandboxInspectInput): Promise<SandboxInspectResult> {
    validateProviderMethodValue("sandbox.lifecycle.v1", "inspect", "input", input);
    let value: Metadata; try { value = await this.roots.readMetadata<Metadata>(input.resourceId); } catch { return { receipt: receipt(input.call, "failed", { code: "not_found", message: "Resource not found.", retryable: false }) }; }
    try { await this.verify(value); } catch { return this.identityMismatch(input.call); }
    return { receipt: receipt(input.call, "succeeded"), resource: { resourceId: value.resourceId, desiredState: value.state === "running" ? "running" : "stopped", observedState: value.state, limits: value.limits } as const };
  }
  private podman(args: string[]): Promise<BoundedCommandResult> { return runBoundedCommand([this.config.podmanPath, "--remote=false", ...args], { timeoutMs: PODMAN_TIMEOUT_MS, maxOutputBytes: PODMAN_OUTPUT_LIMIT }); }
  private async verify(value: Metadata): Promise<void> {
    const { code, stdout, timedOut } = await this.podman(["inspect", value.containerId]); if (code !== 0 || timedOut) throw new Error("owned container identity is unavailable");
    const parsed = JSON.parse(stdout) as unknown; if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("owned container identity mismatch");
    const live = parsed[0] as InspectContainer; const paths = resourcePaths(this.config.stateRoot, value.resourceId); const expected = expectedContainerIdentity(this.config, value.resourceId, value.containerName, paths.mount, value.limits);
    const bindMounts = (live.Mounts ?? []).filter((entry) => entry.Type === "bind").map((entry) => ({ source: entry.Source, destination: entry.Destination, readWrite: entry.RW })).sort((left, right) => String(left.destination).localeCompare(String(right.destination)));
    const expectedMounts = expected.bindMounts.map((entry) => ({ source: entry.source, destination: entry.destination, readWrite: entry.readWrite })).sort((left, right) => left.destination.localeCompare(right.destination));
    if (live.Id !== value.containerId || live.Name !== expected.containerName || live.Image !== expected.imageId || live.Config?.Image !== expected.imageReference || live.Config?.User !== expected.user || live.Config?.Labels?.[RESOURCE_LABEL] !== expected.labels[RESOURCE_LABEL] || live.Config?.Labels?.[CONFIG_LABEL] !== value.configDigest || value.configDigest !== expected.labels[CONFIG_LABEL] || live.HostConfig?.NetworkMode !== expected.networkMode || live.HostConfig?.ReadonlyRootfs !== expected.readonlyRootfs || live.HostConfig?.Memory !== expected.memoryBytes || live.HostConfig?.MemorySwap !== expected.memorySwapBytes || live.HostConfig?.NanoCpus !== expected.nanoCpus || live.HostConfig?.PidsLimit !== expected.pids || JSON.stringify(bindMounts) !== JSON.stringify(expectedMounts)) throw new Error("owned container identity mismatch");
  }
  private identityMismatch(call: SandboxCreateInput["call"]) { return { receipt: receipt(call, "failed", { code: "identity_mismatch", message: "Owned container identity mismatch.", retryable: false }) }; }
  private async transition(input: SandboxStartInput | SandboxStopInput, target: "running" | "stopped"): Promise<SandboxStartResult | SandboxStopResult> {
    let value: Metadata; try { value = await this.roots.readMetadata<Metadata>(input.resourceId); } catch { return { receipt: receipt(input.call, "failed", { code: "not_found", message: "Resource not found.", retryable: false }) }; }
    try { await this.verify(value); } catch { return this.identityMismatch(input.call); } const result = await this.podman([target === "running" ? "start" : "stop", value.containerId]);
    if (result.code !== 0 || result.timedOut) return { receipt: receipt(input.call, "unknown", { code: `${target}_unknown`, message: `Container ${target} outcome is unknown.`, retryable: true }) };
    value.state = target; await this.roots.writeMetadata(value.resourceId, value);
    return { receipt: receipt(input.call, "succeeded"), resource: { resourceId: value.resourceId, desiredState: target, observedState: target, limits: value.limits } };
  }
  async start(input: SandboxStartInput): Promise<SandboxStartResult> { validateProviderMethodValue("sandbox.lifecycle.v1", "start", "input", input); return this.mutate(input.call, () => this.transition(input, "running")); }
  async stop(input: SandboxStopInput): Promise<SandboxStopResult> { validateProviderMethodValue("sandbox.lifecycle.v1", "stop", "input", input); return this.mutate(input.call, () => this.transition(input, "stopped")); }
  async destroy(input: SandboxDestroyInput): Promise<SandboxDestroyResult> {
    validateProviderMethodValue("sandbox.lifecycle.v1", "destroy", "input", input);
    return this.mutate(input.call, async () => {
    let value: Metadata; try { value = await this.roots.readMetadata<Metadata>(input.resourceId); } catch { return { receipt: receipt(input.call, "failed", { code: "not_found", message: "Resource not found.", retryable: false }) }; }
    try { await this.verify(value); } catch { return this.identityMismatch(input.call); } const removed = await this.podman(["rm", "--force", "--volumes", value.containerId]);
    if (removed.code !== 0 || removed.timedOut) return { receipt: receipt(input.call, "unknown", { code: "destroy_unknown", message: "Container destroy outcome is unknown.", retryable: true }) };
    const paths = resourcePaths(this.config.stateRoot, value.resourceId); await this.images.destroy(paths.image, paths.mount); value.state = "stopped";
    return { receipt: receipt(input.call, "succeeded"), resource: { resourceId: value.resourceId, desiredState: "destroyed", observedState: "destroyed", limits: value.limits } };
    });
  }
}
