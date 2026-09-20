import type { SandboxCreateInput, SandboxCreateResult, SandboxDestroyInput, SandboxDestroyResult, SandboxInspectInput, SandboxInspectResult, SandboxStartInput, SandboxStartResult, SandboxStopInput, SandboxStopResult } from "@ezcorp/extension-contract";
import { createContainerArgv, resourcePaths, validateHostConfig, type LocalPodmanHostConfig } from "./commands";
import { ResourceRoot } from "./resource-root";
import { WorkspaceImage } from "./workspace-image";
import { DurableOperationJournal } from "./journal";

type Metadata = { resourceId: string; containerName: string; state: "stopped" | "running" | "unknown"; limits: SandboxCreateInput["limits"] };
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
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" }); const code = await proc.exited;
    if (code !== 0) return { receipt: { ...input.call, outcome: "failed", error: { code: "create_failed", message: (await new Response(proc.stderr).text()).slice(0, 1024), retryable: false } } };
    const metadata: Metadata = { resourceId, containerName, state: "stopped", limits: input.limits }; await this.roots.writeMetadata(resourceId, metadata);
    return { receipt: { ...input.call, outcome: "succeeded" }, resource: { resourceId, desiredState: "stopped", observedState: "stopped", limits: input.limits } };
    });
  }
  async inspect(input: SandboxInspectInput): Promise<SandboxInspectResult> {
    try { const value = await this.roots.readMetadata<Metadata>(input.resourceId); return { receipt: { ...input.call, outcome: "succeeded" }, resource: { resourceId: value.resourceId, desiredState: value.state === "running" ? "running" : "stopped", observedState: value.state, limits: value.limits } }; }
    catch { return { receipt: { ...input.call, outcome: "failed", error: { code: "not_found", message: "Resource not found", retryable: false } } }; }
  }
  private async podman(args: string[]): Promise<{ code: number; stderr: string }> { const proc = Bun.spawn([this.config.podmanPath, "--remote=false", ...args], { stdout: "ignore", stderr: "pipe" }); const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]); return { code, stderr }; }
  private async transition(input: SandboxStartInput | SandboxStopInput, target: "running" | "stopped"): Promise<SandboxStartResult | SandboxStopResult> {
    let value: Metadata; try { value = await this.roots.readMetadata<Metadata>(input.resourceId); } catch { return { receipt: { ...input.call, outcome: "failed", error: { code: "not_found", message: "Resource not found", retryable: false } } }; }
    const result = await this.podman([target === "running" ? "start" : "stop", value.containerName]);
    if (result.code !== 0) return { receipt: { ...input.call, outcome: "unknown", error: { code: `${target}_unknown`, message: result.stderr.slice(0, 1024), retryable: true } } };
    value.state = target; await this.roots.writeMetadata(value.resourceId, value);
    return { receipt: { ...input.call, outcome: "succeeded" }, resource: { resourceId: value.resourceId, desiredState: target, observedState: target, limits: value.limits } };
  }
  async start(input: SandboxStartInput): Promise<SandboxStartResult> { return this.mutate(input.call, () => this.transition(input, "running")); }
  async stop(input: SandboxStopInput): Promise<SandboxStopResult> { return this.mutate(input.call, () => this.transition(input, "stopped")); }
  async destroy(input: SandboxDestroyInput): Promise<SandboxDestroyResult> {
    return this.mutate(input.call, async () => {
    let value: Metadata; try { value = await this.roots.readMetadata<Metadata>(input.resourceId); } catch { return { receipt: { ...input.call, outcome: "failed", error: { code: "not_found", message: "Resource not found", retryable: false } } }; }
    const removed = await this.podman(["rm", "--force", "--volumes", value.containerName]);
    if (removed.code !== 0) return { receipt: { ...input.call, outcome: "unknown", error: { code: "destroy_unknown", message: removed.stderr.slice(0, 1024), retryable: true } } };
    const paths = resourcePaths(this.config.stateRoot, value.resourceId); await this.images.destroy(paths.image, paths.mount); value.state = "stopped";
    return { receipt: { ...input.call, outcome: "succeeded" }, resource: { resourceId: value.resourceId, desiredState: "destroyed", observedState: "destroyed", limits: value.limits } };
    });
  }
}
