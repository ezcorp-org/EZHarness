import {
  validateSandboxProviderMethodExchange,
  type SandboxProtocolOperation,
} from "@ezcorp/extension-contract";
import type {
  SandboxProviderDispatcher,
  SandboxProviderOutcome,
  SandboxProviderRequest,
} from "./controller";

type LifecycleMethod =
  | "incus/lifecycle/create"
  | "incus/lifecycle/setPower"
  | "incus/lifecycle/destroy"
  | "incus/lifecycle/inspectOperation";

export interface IncusDispatchScope {
  installationId: string;
  releaseId: string;
  connectionId: string;
  connectionRevision: number;
  projectId: string;
  bindingId: string;
  resourceKey: string | null;
  generation: number;
  operationId: string;
  deadlineMs: number;
}

/** The host caller checks this exact scope against active release and connection records before invocation. */
export interface HostAuthorizedIncusMethodCaller {
  call(scope: IncusDispatchScope, method: LifecycleMethod, input: Record<string, unknown>): Promise<unknown>;
}

/** Only proven failures before any provider effect may be marked failed. */
export class IncusDispatchAuthorizationError extends Error {
  constructor(readonly code: "RELEASE_REVOKED" | "RELEASE_CHANGED" | "CONNECTION_REVOKED" | "CONNECTION_CHANGED" | "SCOPE_INVALID" | "ARTIFACT_UNAVAILABLE") {
    super(code);
    this.name = "IncusDispatchAuthorizationError";
  }
}

const methods = {
  CREATE: "incus/lifecycle/create",
  START: "incus/lifecycle/setPower",
  STOP: "incus/lifecycle/setPower",
  DESTROY: "incus/lifecycle/destroy",
} as const;

const protocolOperations = {
  CREATE: "lifecycle.create",
  START: "lifecycle.setPower",
  STOP: "lifecycle.setPower",
  DESTROY: "lifecycle.destroy",
} as const satisfies Record<SandboxProviderRequest["kind"], SandboxProtocolOperation>;

const expectedKinds = { CREATE: "create", START: "setPower", STOP: "setPower", DESTROY: "destroy" } as const;

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function mutationInput(request: SandboxProviderRequest, deadlineMs: number): Record<string, unknown> {
  const common = {
    providerId: "incus",
    connectionId: request.binding.connectionId,
    sandboxId: request.binding.id,
    rpcDeadlineMs: deadlineMs,
    requestId: request.operationId,
    idempotencyKey: request.operationId,
  };
  const payload = request.payload;
  if (request.kind === "CREATE") {
    if (!hasOnlyKeys(payload, ["profile", "presetId", "presetDigest", "effectiveSettingsDigest"])) {
      throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
    }
    const pins = {
      profile: request.binding.profile,
      presetId: request.binding.presetId,
      presetDigest: request.binding.presetDigest,
      effectiveSettingsDigest: request.binding.effectiveSettingsDigest,
    };
    if (Object.values(pins).some((value) => typeof value !== "string" || value.length === 0)
      || Object.entries(pins).some(([key, value]) => payload[key] !== value)) {
      throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
    }
    return { ...common, ...pins, desiredState: "stopped" };
  }
  if (!hasOnlyKeys(payload, ["expectedGeneration"]) || !Number.isSafeInteger(payload.expectedGeneration)
    || (payload.expectedGeneration as number) < 1) {
    throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
  }
  if (request.kind === "DESTROY") return { ...common, expectedGeneration: payload.expectedGeneration };
  return { ...common, expectedGeneration: payload.expectedGeneration,
    desiredState: request.kind === "START" ? "running" : "stopped" };
}

function scopeFor(request: SandboxProviderRequest, deadlineMs: number): IncusDispatchScope {
  const revision = request.binding.connectionRevision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
  }
  return {
    installationId: request.binding.providerInstallationId,
    releaseId: request.binding.providerReleaseId,
    connectionId: request.binding.connectionId,
    connectionRevision: revision,
    projectId: request.binding.projectId,
    bindingId: request.binding.id,
    resourceKey: request.binding.resourceKey,
    generation: request.generation,
    operationId: request.operationId,
    deadlineMs,
  };
}

function failure(result: Record<string, unknown>): SandboxProviderOutcome {
  const error = result.error as { code: string; message?: string; operationId?: string };
  if (error.code === "OUTCOME_UNKNOWN") {
    return { outcome: "UNKNOWN", providerOperationId: error.operationId };
  }
  // The adapter reports a lost mutation without a stable provider ID as INTERNAL.
  // It must remain uncertain because the server may already have applied it.
  if (error.code === "INTERNAL") return { outcome: "UNKNOWN", providerOperationId: error.operationId };
  return { outcome: "FAILED", errorCode: error.code, errorMessage: error.message,
    providerOperationId: error.operationId };
}

function observation(value: unknown): SandboxProviderOutcome {
  switch (value) {
    case "running": return { outcome: "SUCCEEDED", observedState: "RUNNING" };
    case "stopped": return { outcome: "SUCCEEDED", observedState: "STOPPED" };
    case "absent": return { outcome: "SUCCEEDED", observedState: "ABSENT" };
    default: return { outcome: "UNKNOWN" };
  }
}

/** Converts durable controller requests to the approved Incus release protocol. */
export class IncusSandboxProviderDispatcher implements SandboxProviderDispatcher {
  constructor(
    private readonly caller: HostAuthorizedIncusMethodCaller,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 30_000,
  ) {}

  async dispatch(request: SandboxProviderRequest): Promise<SandboxProviderOutcome> {
    try {
      const deadlineMs = this.now() + this.timeoutMs;
      const scope = scopeFor(request, deadlineMs);
      const method = methods[request.kind];
      const input = mutationInput(request, deadlineMs);
      const result = await this.caller.call(scope, method, input);
      const validated = validateSandboxProviderMethodExchange(protocolOperations[request.kind], input, result).result as Record<string, unknown>;
      if (validated.ok === false) return failure(validated);
      const receipt = validated.receipt as { operationId: string; kind: string; requestId: string; idempotencyKey: string; sandboxId: string };
      if (receipt.kind !== expectedKinds[request.kind] || receipt.requestId !== request.operationId
        || receipt.idempotencyKey !== request.operationId || receipt.sandboxId !== request.binding.id) {
        return { outcome: "UNKNOWN" };
      }
      return { outcome: "PENDING", providerOperationId: receipt.operationId };
    } catch (error) {
      if (error instanceof IncusDispatchAuthorizationError) {
        return { outcome: "FAILED", errorCode: error.code };
      }
      throw error;
    }
  }

  async inspectOperation(request: SandboxProviderRequest & { providerOperationId: string | null }): Promise<SandboxProviderOutcome> {
    if (!request.providerOperationId) return { outcome: "UNKNOWN" };
    try {
      const deadlineMs = this.now() + this.timeoutMs;
      const scope = scopeFor(request, deadlineMs);
      const input = {
        providerId: "incus", connectionId: request.binding.connectionId,
        sandboxId: request.binding.id, rpcDeadlineMs: deadlineMs,
        operationId: request.providerOperationId,
        ...(request.kind === "CREATE" ? { requestId: request.operationId, idempotencyKey: request.operationId } : {}),
      };
      const result = await this.caller.call(scope, "incus/lifecycle/inspectOperation", input);
      const validated = validateSandboxProviderMethodExchange("lifecycle.inspectOperation", input, result).result as Record<string, unknown>;
      if (validated.ok === false) {
        // An inspection failure, including NOT_FOUND, proves nothing about the mutation.
        return { outcome: "UNKNOWN", providerOperationId: request.providerOperationId };
      }
      const operation = validated.operation as { kind: string; state: string; observedState: string | null; error: { code: string; message?: string } | null };
      if (operation.kind !== expectedKinds[request.kind]) {
        return { outcome: "UNKNOWN", providerOperationId: request.providerOperationId };
      }
      if (operation.state === "pending" || operation.state === "running") {
        return { outcome: "PENDING", providerOperationId: request.providerOperationId };
      }
      if (operation.state === "outcome_unknown") {
        return { outcome: "UNKNOWN", providerOperationId: request.providerOperationId };
      }
      if (operation.state === "succeeded") {
        const mapped = observation(operation.observedState);
        const expected = request.kind === "START" ? "RUNNING" : request.kind === "DESTROY" ? "ABSENT" : "STOPPED";
        if (mapped.outcome !== "SUCCEEDED" || mapped.observedState !== expected) {
          return { outcome: "UNKNOWN", providerOperationId: request.providerOperationId };
        }
        return { ...mapped, providerOperationId: request.providerOperationId };
      }
      return { outcome: "FAILED", providerOperationId: request.providerOperationId,
        errorCode: operation.error?.code ?? "PROVIDER_CANCELLED", errorMessage: operation.error?.message };
    } catch (error) {
      if (error instanceof IncusDispatchAuthorizationError) return { outcome: "UNKNOWN", providerOperationId: request.providerOperationId };
      throw error;
    }
  }
}
