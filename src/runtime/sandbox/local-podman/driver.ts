import type { SandboxCreateInput, SandboxCreateResult, SandboxDestroyInput, SandboxDestroyResult, SandboxInspectInput, SandboxInspectResult, SandboxStartInput, SandboxStartResult, SandboxStopInput, SandboxStopResult } from "@ezcorp/extension-contract";
import { CONFIG_LABEL, RESOURCE_LABEL, configurationDigest, containerIdFromCreateOutput, createContainerArgv, expectedContainerIdentity, resourcePaths, validateHostConfig, type LocalPodmanHostConfig } from "./commands";
import { ResourceRoot } from "./resource-root";
import { WorkspaceImage } from "./workspace-image";
import { DurableOperationJournal } from "./journal";

type Metadata = { resourceId: string; containerId: string; containerName: string; configDigest: string; state: "stopped" | "running" | "unknown"; limits: SandboxCreateInput["limits"] };
type InspectMount = { Type?: string; Source?: string; Destination?: string; RW?: boolean };
type InspectContainer = { Id?: string; Name?: string; Image?: string; Config?: { Image?: string; Labels?: Record<string, string> }; HostConfig?: { NetworkMode?: string; ReadonlyRootfs?: boolean; Memory?: number; MemorySwap?: number; NanoCpus?: number; PidsLimit?: number }; Mounts?: InspectMount[] };
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
    return this.mutate(input.call, async () => {
    const resourceId = crypto.randomUUID(); const paths = await this.roots.initialize(resourceId); const containerName = `ez-local-${resourceId}`;
    await this.images.create(paths.image, paths.mount, input.limits.diskBytes);
    const argv = createContainerArgv(this.config, resourceId, containerName, paths.mount, input.limits);
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" }); const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (code !== 0) return { receipt: { ...input.call, outcome: "failed", error: { code: "create_failed", message: (await new Response(proc.stderr).text()).slice(0, 1024), retryable: false } } };
    const containerId = containerIdFromCreateOutput(stdout);
    if (containerId === null) return { receipt: { ...input.call, outcome: "unknown", error: { code: "create_identity_unknown", message: "Podman did not return an exact container ID", retryable: true } } };
    const metadata: Metadata = { resourceId, containerId, containerName, configDigest: configurationDigest(this.config, input.limits), state: "stopped", limits: input.limits }; await this.roots.writeMetadata(resourceId, metadata);
    return { receipt: { ...input.call, outcome: "succeeded" }, resource: { resourceId, desiredState: "stopped", observedState: "stopped", limits: input.limits } };
    });
  }
  async inspect(input: SandboxInspectInput): Promise<SandboxInspectResult> {
    let value: Metadata; try { value = await this.roots.readMetadata<Metadata>(input.resourceId); } catch { return { receipt: { ...input.call, outcome: "failed", error: { code: "not_found", message: "Resource not found", retryable: false } } }; }
    try { await this.verify(value); } catch { return this.identityMismatch(input.call); }
    return { receipt: { ...input.call, outcome: "succeeded" }, resource: { resourceId: value.resourceId, desiredState: value.state === "running" ? "running" : "stopped", observedState: value.state, limits: value.limits } };
  }
  private async podman(args: string[]): Promise<{ code: number; stderr: string }> { const proc = Bun.spawn([this.config.podmanPath, "--remote=false", ...args], { stdout: "ignore", stderr: "pipe" }); const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]); return { code, stderr }; }
  private async verify(value: Metadata): Promise<void> {
    const proc = Bun.spawn([this.config.podmanPath, "--remote=false", "inspect", value.containerId], { stdout: "pipe", stderr: "pipe" }); const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]); if (code !== 0) throw new Error("owned container identity is unavailable");
    const parsed = JSON.parse(stdout) as unknown; if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("owned container identity mismatch");
    const live = parsed[0] as InspectContainer; const paths = resourcePaths(this.config.stateRoot, value.resourceId); const expected = expectedContainerIdentity(this.config, value.resourceId, value.containerName, paths.mount, value.limits);
    const bindMounts = (live.Mounts ?? []).filter((entry) => entry.Type === "bind").map((entry) => ({ source: entry.Source, destination: entry.Destination, readWrite: entry.RW })).sort((left, right) => String(left.destination).localeCompare(String(right.destination)));
    const expectedMounts = expected.bindMounts.map((entry) => ({ source: entry.source, destination: entry.destination, readWrite: entry.readWrite })).sort((left, right) => left.destination.localeCompare(right.destination));
    if (live.Id !== value.containerId || live.Name !== expected.containerName || live.Image !== expected.imageId || live.Config?.Image !== expected.imageReference || live.Config?.Labels?.[RESOURCE_LABEL] !== expected.labels[RESOURCE_LABEL] || live.Config?.Labels?.[CONFIG_LABEL] !== value.configDigest || value.configDigest !== expected.labels[CONFIG_LABEL] || live.HostConfig?.NetworkMode !== expected.networkMode || live.HostConfig?.ReadonlyRootfs !== expected.readonlyRootfs || live.HostConfig?.Memory !== expected.memoryBytes || live.HostConfig?.MemorySwap !== expected.memorySwapBytes || live.HostConfig?.NanoCpus !== expected.nanoCpus || live.HostConfig?.PidsLimit !== expected.pids || JSON.stringify(bindMounts) !== JSON.stringify(expectedMounts)) throw new Error("owned container identity mismatch");
  }
  private identityMismatch(call: SandboxCreateInput["call"]) { return { receipt: { ...call, outcome: "failed" as const, error: { code: "identity_mismatch", message: "Owned container identity mismatch", retryable: false } } }; }
  private async transition(input: SandboxStartInput | SandboxStopInput, target: "running" | "stopped"): Promise<SandboxStartResult | SandboxStopResult> {
    let value: Metadata; try { value = await this.roots.readMetadata<Metadata>(input.resourceId); } catch { return { receipt: { ...input.call, outcome: "failed", error: { code: "not_found", message: "Resource not found", retryable: false } } }; }
    try { await this.verify(value); } catch { return this.identityMismatch(input.call); } const result = await this.podman([target === "running" ? "start" : "stop", value.containerId]);
    if (result.code !== 0) return { receipt: { ...input.call, outcome: "unknown", error: { code: `${target}_unknown`, message: result.stderr.slice(0, 1024), retryable: true } } };
    value.state = target; await this.roots.writeMetadata(value.resourceId, value);
    return { receipt: { ...input.call, outcome: "succeeded" }, resource: { resourceId: value.resourceId, desiredState: target, observedState: target, limits: value.limits } };
  }
  async start(input: SandboxStartInput): Promise<SandboxStartResult> { return this.mutate(input.call, () => this.transition(input, "running")); }
  async stop(input: SandboxStopInput): Promise<SandboxStopResult> { return this.mutate(input.call, () => this.transition(input, "stopped")); }
  async destroy(input: SandboxDestroyInput): Promise<SandboxDestroyResult> {
    return this.mutate(input.call, async () => {
    let value: Metadata; try { value = await this.roots.readMetadata<Metadata>(input.resourceId); } catch { return { receipt: { ...input.call, outcome: "failed", error: { code: "not_found", message: "Resource not found", retryable: false } } }; }
    try { await this.verify(value); } catch { return this.identityMismatch(input.call); } const removed = await this.podman(["rm", "--force", "--volumes", value.containerId]);
    if (removed.code !== 0) return { receipt: { ...input.call, outcome: "unknown", error: { code: "destroy_unknown", message: removed.stderr.slice(0, 1024), retryable: true } } };
    const paths = resourcePaths(this.config.stateRoot, value.resourceId); await this.images.destroy(paths.image, paths.mount); value.state = "stopped";
    return { receipt: { ...input.call, outcome: "succeeded" }, resource: { resourceId: value.resourceId, desiredState: "destroyed", observedState: "destroyed", limits: value.limits } };
    });
  }
}
