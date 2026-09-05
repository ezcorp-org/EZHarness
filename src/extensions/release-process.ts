import { ContractError, assertJson, canonicalJson, compileValueSchema, sha256, validateInvocationContext, validateManifest, validateResourceLimits } from "@ezcorp/extension-contract";
import type { InstallationRecord, InvocationContext, JsonValue, ReleaseRecord, ResourceLimits, Runner, RunnerExecution } from "@ezcorp/extension-contract";
import { resolveCallProvenance } from "./call-provenance";
import { ExtensionProcess } from "./subprocess";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, ToolCallResult } from "./types";
import { InvocationLocks, type InvocationGuard } from "./runtime-locks";
import { getRuntimeToolContext, withRuntimeToolContext } from "./runtime-tool-context";
import type { MigrationDb } from "../db/migrations/types";

export interface ActiveExtensionRelease {
  release: ReleaseRecord;
  installation: InstallationRecord;
  limits: ResourceLimits;
}
export interface ReleaseRuntimeDependencies {
  runner(): Promise<Runner>;
  resolve(installationId: string, database?: MigrationDb): Promise<ActiveExtensionRelease | null>;
  dispatchNotification?(extensionId: string, method: string, params?: Record<string, unknown>): Promise<void>;
}
let dependencies: ReleaseRuntimeDependencies | undefined;
export function configureReleaseRuntime(value: ReleaseRuntimeDependencies): void { dependencies = value; }
export function getReleaseRuntime(): ReleaseRuntimeDependencies {
  if (!dependencies) throw new ContractError("RUNNER_UNAVAILABLE", "Extension release runner is not configured");
  return dependencies;
}
export async function resolveActiveRelease(extensionId: string, runtime: ReleaseRuntimeDependencies, database?: MigrationDb): Promise<ActiveExtensionRelease> {
  const snapshot = await runtime.resolve(extensionId, database);
  if (!snapshot?.installation.enabled || snapshot.installation.uninstalled || snapshot.installation.status !== "active" || snapshot.installation.activeReleaseId !== snapshot.release.id || snapshot.installation.id !== extensionId || snapshot.release.installationId !== extensionId || snapshot.installation.acknowledgedGeneration !== snapshot.installation.generation) throw new ContractError("RELEASE_NOT_ACTIVE", "Extension has no active acknowledged release");
  validateManifest(snapshot.release.manifest);
  validateResourceLimits(snapshot.limits);
  return snapshot;
}
export function releaseBinding(snapshot: ActiveExtensionRelease): string {
  return canonicalJson({ releaseId: snapshot.release.id, releaseDigest: snapshot.release.releaseDigest, generation: snapshot.installation.generation, grants: snapshot.installation.grants, policyDigest: snapshot.release.policyDigest });
}

const outputMethods = new Set(["ezcorp/state", "ezcorp/page-state"]);
interface ReleaseCallOptions { skipTimeout?: boolean; signal?: AbortSignal; invocationGuard?: InvocationGuard }

export class ReleaseProcess extends ExtensionProcess {
  private releaseClosed = false;
  private releaseReady = false;
  private releaseCalls = new Map<string, Promise<unknown>>();
  private releaseWorkers = new Map<string, RunnerExecution>();
  private releaseHandler?: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  private releaseNotification?: (notification: JsonRpcNotification) => void;

  constructor(extensionId: string, private readonly runtime: ReleaseRuntimeDependencies | undefined = dependencies) {
    super(extensionId, "", {});
  }

  override ensureRunning(): void {
    if (!this.runtime) throw new ContractError("RUNNER_UNAVAILABLE", "Extension release runner is not configured");
    if (this.releaseClosed) throw new ContractError("CLOSED", "Extension runtime has retired");
    this.releaseReady = true;
  }

  override getSpawnArgs(): string[] { throw new ContractError("NO_HOST_EXECUTION", "Extension code runs only through the release runner"); }
  override getSpawnCwd(): undefined { return undefined; }
  override get isRunning(): boolean { return this.releaseReady && !this.releaseClosed; }
  override get inFlightCallCount(): number { return this.releaseCalls.size; }
  override async whenCallsSettled(): Promise<void> { await Promise.allSettled(this.releaseCalls.values()); }
  override setRequestHandler(handler: (request: JsonRpcRequest) => Promise<JsonRpcResponse>): void { this.releaseHandler = handler; }
  override setNotificationHandler(handler: (notification: JsonRpcNotification) => void): void { this.releaseNotification = handler; }

  private async active(): Promise<ActiveExtensionRelease> {
    return resolveActiveRelease(this.extensionId, this.runtime!);
  }

  override async call(method: string, params: Record<string, unknown> = {}, options?: ReleaseCallOptions): Promise<JsonRpcResponse> {
    if (options?.signal?.aborted) throw new ContractError("CANCELLED", "Extension invocation cancelled");
    this.ensureRunning();
    const invocationId = crypto.randomUUID();
    const operation = this.execute(method, params, invocationId, this.releaseHandler, this.releaseNotification, options?.signal, options?.invocationGuard);
    this.releaseCalls.set(invocationId, operation);
    try {
      return { jsonrpc: "2.0", id: invocationId, result: await operation };
    } finally {
      this.releaseCalls.delete(invocationId);
    }
  }

  private async execute(method: string, params: Record<string, unknown>, invocationId: string, handler: typeof this.releaseHandler, notification: typeof this.releaseNotification, signal?: AbortSignal, invocationGuard?: InvocationGuard): Promise<unknown> {
    const runtimeContext = getRuntimeToolContext() ?? {};
    const checkCancellation = () => { if (signal?.aborted) throw new ContractError("CANCELLED", "Extension invocation cancelled; admitted effects may already have completed"); };
    if (invocationGuard) await invocationGuard();
    checkCancellation();
    const snapshot = await this.active();
    checkCancellation();
    if (method === "tools/list") return { tools: snapshot.release.manifest.tools ?? [] };
    const meta = params._meta && typeof params._meta === "object" && !Array.isArray(params._meta) ? params._meta as Record<string, unknown> : {};
    if ((meta.releaseId !== undefined && meta.releaseId !== snapshot.release.id) || (meta.expectedGeneration !== undefined && meta.expectedGeneration !== snapshot.installation.generation) || (meta.expectedReleaseBinding !== undefined && meta.expectedReleaseBinding !== await sha256(releaseBinding(snapshot)))) throw new ContractError("RELEASE_CHANGED", "Invocation no longer targets the active release generation and grants");
    const token = typeof meta.ezCallId === "string" ? meta.ezCallId : undefined;
    const provenance = token ? resolveCallProvenance(token) : undefined;
    if (!token || !provenance || provenance.actorExtensionId !== this.extensionId || provenance.ownerless || !provenance.onBehalfOf) throw new ContractError("INVALID_CALL_TOKEN", "An active call token for this extension and principal is required");
    const workerId = crypto.randomUUID();
    const metadata: Record<string, JsonValue> = { ezConversationId: provenance.conversationId };
    for (const key of ["ezModel", "ezProvider", "ezPublicUrl", "invocationMetadata"]) {
      if (meta[key] !== undefined) { assertJson(meta[key]); metadata[key] = meta[key]; }
    }
    const context: InvocationContext = {
      invocationId,
      workerId,
      releaseId: snapshot.release.id,
      principalId: provenance.onBehalfOf,
      scopeId: provenance.conversationId ?? snapshot.installation.scope,
      token,
      deadline: Date.now() + snapshot.limits.timeoutMs,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
    const binding = releaseBinding(snapshot);
    const assertInvocationActive = () => {
      checkCancellation();
      if (this.releaseClosed || Date.now() >= context.deadline || !this.releaseCalls.has(invocationId)) throw new ContractError("EXPIRED_CONTEXT", "Extension invocation is no longer active");
      const liveProvenance = resolveCallProvenance(token);
      if (!liveProvenance || liveProvenance.actorExtensionId !== this.extensionId || liveProvenance.onBehalfOf !== context.principalId || (liveProvenance.conversationId ?? snapshot.installation.scope) !== context.scopeId) throw new ContractError("INVALID_CALL_TOKEN", "Invocation token has expired or changed scope");
    };
    const assertCurrentBinding = async () => {
      assertInvocationActive();
      const current = await this.active();
      if (invocationGuard) await invocationGuard();
      assertInvocationActive();
      if (releaseBinding(current) !== binding) throw new ContractError("RELEASE_CHANGED", "Extension release or grants changed during invocation");
    };
    const effectAdmission = { prepare: assertCurrentBinding, assertActive: assertInvocationActive, verifyTransaction: invocationGuard };
    let accepting = false;
    const runner = await this.runtime!.runner();
    checkCancellation();
    let worker: RunnerExecution | undefined;
    let closing: Promise<void> | undefined;
    const closeWorker = () => worker ? closing ??= worker.close() : Promise.resolve();
    const cancellation = Promise.withResolvers<never>();
    void cancellation.promise.catch(() => undefined);
    const onAbort = () => {
      accepting = false;
      cancellation.reject(new ContractError("CANCELLED", "Extension invocation cancelled; admitted effects may already have completed"));
      void closeWorker().catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const request = (method: string, input: unknown) => Promise.race([worker!.request(method, input), cancellation.promise]);
    const locks = new InvocationLocks(this.extensionId, context, snapshot.installation.generation);
    try {
      if (invocationGuard) await invocationGuard();
      checkCancellation();
      worker = await runner.start({ workerId, artifactDigest: snapshot.release.artifactDigest, context, limits: snapshot.limits }, async (rpcMethod, raw) => {
        checkCancellation();
        if (!accepting || this.releaseClosed || Date.now() >= context.deadline || !this.releaseCalls.has(invocationId)) throw new ContractError("EXPIRED_CONTEXT", "Extension invocation is no longer active");
        assertJson(raw);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ContractError("INVALID_CONTEXT", "Invalid capability envelope");
        const envelope = raw as Record<string, unknown>;
        if (Object.keys(envelope).some(key => key !== "context" && key !== "input") || !Object.hasOwn(envelope, "input") || canonicalJson(validateInvocationContext(envelope.context)) !== canonicalJson(context)) throw new ContractError("CONTEXT_MISMATCH", "Capability context does not match active invocation");
        await assertCurrentBinding();
        if (!envelope.input || typeof envelope.input !== "object" || Array.isArray(envelope.input)) throw new ContractError("INVALID_REQUEST", "Host capability parameters must be an object");
        if (rpcMethod === "ezcorp/lock.acquire" || rpcMethod === "ezcorp/lock.release") return locks.request(rpcMethod, envelope.input as Record<string, unknown>);
        const input: Record<string, unknown> = { ...envelope.input as Record<string, unknown>, _meta: { ezCallId: token } };
        delete input._toolName;
        if (method === "tools/call") input._toolName = params.name;
        if (outputMethods.has(rpcMethod)) {
          if (!notification) throw new ContractError("CAPABILITY_UNAVAILABLE", "UI mediator is unavailable");
          if (rpcMethod === "ezcorp/state" && !snapshot.release.manifest.panel) throw new ContractError("UNDECLARED_CONTRIBUTION", "No panel is declared");
          if (rpcMethod === "ezcorp/page-state" && !snapshot.release.manifest.pages?.some(page => page.id === input.pageId)) throw new ContractError("UNDECLARED_CONTRIBUTION", "Page is not declared");
          await locks.effect(rpcMethod, () => withRuntimeToolContext(runtimeContext, () => notification({ jsonrpc: "2.0", method: rpcMethod, params: input })), effectAdmission);
          return { ok: true };
        }
        if (!handler) throw new ContractError("CAPABILITY_UNAVAILABLE", "Host capability broker is not wired");
        const response = await locks.effect(rpcMethod, () => withRuntimeToolContext(runtimeContext, () => handler({ jsonrpc: "2.0", id: crypto.randomUUID(), method: rpcMethod, params: input })), effectAdmission);
        if (response.error?.code === -32009) throw new ContractError("STATE_CONFLICT", "State changed; reload before retrying.");
        if (response.error) throw new ContractError("CAPABILITY_DENIED", response.error.message);
        assertJson(response.result);
        return response.result;
      });
      this.releaseWorkers.set(workerId, worker);
      checkCancellation();
      if (this.releaseClosed) throw new ContractError("CLOSED", "Runtime closed during startup");
      const discovered = validateManifest(await request("extension/discover", {}));
      if (canonicalJson(discovered) !== canonicalJson(snapshot.release.manifest)) throw new ContractError("CATALOG_MISMATCH", "Runtime metadata does not match approved release");
      await assertCurrentBinding();
      if (method === "tools/call") {
        const tool = snapshot.release.manifest.tools?.find(tool => tool.name === params.name);
        if (!tool) throw new ContractError("UNDECLARED_CONTRIBUTION", "Tool is not declared");
        const input = params.arguments ?? {};
        compileValueSchema(tool.inputSchema)(input);
        accepting = true;
        const result = await request("extension/invoke", { name: tool.name, input, context });
        await assertCurrentBinding();
        compileValueSchema(tool.outputSchema)(result);
        return result;
      }
      const contribution = snapshot.release.manifest.methods?.find(entry => entry.name === method);
      if (!contribution) throw new ContractError("UNDECLARED_CONTRIBUTION", "Runtime method is not declared");
      const input = Object.fromEntries(Object.entries(params).filter(([key]) => key !== "_meta"));
      compileValueSchema(contribution.inputSchema)(input);
      accepting = true;
      const result = await request("extension/dispatch", { method, input, context });
      await assertCurrentBinding();
      compileValueSchema(contribution.outputSchema)(result);
      return result;
    } catch (error) {
      checkCancellation();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      accepting = false;
      this.releaseWorkers.delete(workerId);
      try { await closeWorker(); } finally { await locks.close(); }
    }
  }

  override async callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>, options?: ReleaseCallOptions): Promise<ToolCallResult> {
    const response = await this.call("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, options);
    const result = response.result;
    if (result && typeof result === "object" && !Array.isArray(result) && Array.isArray((result as Record<string, unknown>).content)) return result as ToolCallResult;
    return { content: [{ type: "text", text: typeof result === "string" ? result : canonicalJson(result) }], isError: false };
  }

  override async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    this.ensureRunning();
    if (!this.runtime?.dispatchNotification) throw new ContractError("DELIVERY_UNAVAILABLE", "Durable extension delivery is not configured");
    await this.runtime.dispatchNotification(this.extensionId, method, params);
  }

  override kill(): void {
    this.releaseClosed = true;
    this.releaseReady = false;
    for (const worker of this.releaseWorkers.values()) void worker.close().catch(() => {});
  }
}
