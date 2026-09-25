import { createHash } from "node:crypto";
import {
  ContractError,
  SANDBOX_PROVIDER_OPERATIONS,
  validateSandboxProviderMethodExchange,
  validateSandboxProviderMethodValue,
  type JsonValue,
  type SandboxProviderError,
  type SandboxProtocolOperation,
} from "@ezcorp/extension-contract";
import type { IncusConnectionConfig } from "./config";
import {
  INCUS_CAPABILITIES,
  INCUS_PRESETS,
  INCUS_PROFILES,
  INCUS_PROVIDER_ID,
} from "./manifest";
import {
  IncusTransportError,
  type IncusProbeResult,
  type IncusTransport,
  type IncusTransportAction,
  type IncusTransportRequest,
} from "./transport";

const mutationOperations = new Set<SandboxProtocolOperation>([
  "lifecycle.create",
  "lifecycle.setPower",
  "lifecycle.destroy",
  "files.writeAtomic",
  "files.remove",
  "processes.start",
  "processes.cancel",
  "endpoints.open",
  "endpoints.close",
]);

const actionByOperation = {
  "lifecycle.create": "instance.create",
  "lifecycle.inspect": "instance.inspect",
  "lifecycle.list": "instance.list",
  "lifecycle.setPower": "instance.setPower",
  "lifecycle.destroy": "instance.destroy",
  "lifecycle.inspectOperation": "operation.inspect",
  "files.stat": "helper.file.stat",
  "files.list": "helper.file.list",
  "files.readRange": "helper.file.readRange",
  "files.writeAtomic": "helper.file.writeAtomic",
  "files.remove": "helper.file.remove",
  "processes.start": "helper.process.start",
  "processes.inspect": "helper.process.inspect",
  "processes.readOutput": "helper.process.readOutput",
  "processes.cancel": "helper.process.cancel",
  "endpoints.open": "endpoint.open",
  "endpoints.close": "endpoint.close",
} as const satisfies Partial<Record<SandboxProtocolOperation, IncusTransportAction>>;

const safeMessages: Record<IncusTransportError["kind"], string> = {
  invalid: "The Incus request was invalid",
  not_found: "The Incus resource was not found",
  already_exists: "The Incus resource already exists",
  revision_conflict: "The Incus resource revision changed",
  unsupported: "The required Incus capability is unavailable",
  deadline: "The Incus request deadline was exceeded",
  unavailable: "The Incus service is unavailable",
  permission: "The Incus request was denied",
  resource_exhausted: "The Incus resource limit was reached",
  internal: "The Incus transport failed",
};

const errorCodeByKind: Record<IncusTransportError["kind"], SandboxProviderError["code"]> = {
  invalid: "INVALID_ARGUMENT",
  not_found: "NOT_FOUND",
  already_exists: "ALREADY_EXISTS",
  revision_conflict: "REVISION_CONFLICT",
  unsupported: "UNSUPPORTED_CAPABILITY",
  deadline: "DEADLINE_EXCEEDED",
  unavailable: "UNAVAILABLE",
  permission: "PERMISSION_DENIED",
  resource_exhausted: "RESOURCE_EXHAUSTED",
  internal: "INTERNAL",
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid ${label}`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ContractError("INVALID_PROVIDER_VALUE", `Invalid ${label}`);
  return value;
}

function parseProbe(value: unknown): IncusProbeResult {
  const probe = object(value, "Incus probe");
  const controls = object(probe.controls, "Incus controls");
  const architecture = string(probe.architecture, "Incus architecture");
  const isolation = string(probe.isolation, "Incus isolation");
  if (architecture !== "amd64" && architecture !== "arm64") {
    throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid Incus architecture");
  }
  if (isolation !== "container" && isolation !== "virtual-machine") {
    throw new ContractError("INVALID_PROVIDER_VALUE", "Invalid Incus isolation");
  }
  if (controls.workspaceRoot !== "/workspace") {
    throw new ContractError("INVALID_PROVIDER_VALUE", "Incus helper reported an unsafe workspace root");
  }
  return {
    serverCertificateSha256: string(probe.serverCertificateSha256, "Incus server identity"),
    project: string(probe.project, "Incus project"),
    profile: string(probe.profile, "Incus profile"),
    helperVersion: string(probe.helperVersion, "Incus helper version"),
    backendApi: string(probe.backendApi, "Incus backend API"),
    backendVersion: string(probe.backendVersion, "Incus backend version"),
    architecture,
    storageDriver: string(probe.storageDriver, "Incus storage driver"),
    isolation,
    nestedCompose: boolean(probe.nestedCompose, "Incus nested Compose support"),
    controls: {
      restrictedProject: boolean(controls.restrictedProject, "restricted project control"),
      unprivileged: boolean(controls.unprivileged, "unprivileged container control"),
      projectLimits: boolean(controls.projectLimits, "project limit control"),
      privateNetwork: boolean(controls.privateNetwork, "private network control"),
      workspaceRoot: "/workspace",
      explicitGuestUser: boolean(controls.explicitGuestUser, "guest user control"),
      atomicFileReplace: boolean(controls.atomicFileReplace, "atomic file control"),
      durableProcesses: boolean(controls.durableProcesses, "durable process control"),
      boundedOutput: boolean(controls.boundedOutput, "bounded output control"),
      endpointProxy: boolean(controls.endpointProxy, "endpoint proxy control"),
    },
  };
}

function operationError(operation: SandboxProtocolOperation, cause: unknown): { ok: false; error: SandboxProviderError } {
  if (!(cause instanceof IncusTransportError)) {
    return { ok: false, error: { code: "INTERNAL", message: "The Incus adapter failed", retryable: false } };
  }
  if (cause.effect === "unknown" && mutationOperations.has(operation)) {
    if (cause.operationId && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(cause.operationId)) {
      return {
        ok: false,
        error: {
          code: "OUTCOME_UNKNOWN",
          message: "The Incus mutation outcome is unknown",
          retryable: false,
          operationId: cause.operationId,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: "The Incus transport lost a mutation without a stable operation identity",
        retryable: false,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: errorCodeByKind[cause.kind],
      message: safeMessages[cause.kind],
      retryable: (cause.effect === "none" || !mutationOperations.has(operation))
        && (cause.kind === "deadline" || cause.kind === "unavailable"),
    },
  };
}

function transportPayload(operation: SandboxProtocolOperation, input: Record<string, unknown>, config: IncusConnectionConfig): JsonValue {
  const omitted = new Set([
    "providerId",
    "connectionId",
    "sandboxId",
    "rpcDeadlineMs",
    "requestId",
    "idempotencyKey",
  ]);
  const payload: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!omitted.has(key)) payload[key] = value as JsonValue;
  }
  if (operation.startsWith("files.")) {
    payload.user = config.guestUser;
    payload.cwd = "/workspace";
  }
  if (operation.startsWith("processes.")) {
    payload.workspaceRoot = "/workspace";
    if (operation !== "processes.start") payload.user = config.guestUser;
  }
  return payload;
}

function preflightFailure(message: string): never {
  throw new ContractError("UNSUPPORTED_PROVIDER", message);
}

function providerFailure(
  code: SandboxProviderError["code"],
  message: string,
): { ok: false; error: SandboxProviderError } {
  return { ok: false, error: { code, message, retryable: false } };
}

function sandboxResourceName(connectionId: string, sandboxId: string): string {
  const digest = createHash("sha256")
    .update(connectionId, "utf8")
    .update("\0", "utf8")
    .update(sandboxId, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `ezh-${digest}`;
}

/** The host uses the same pure mapping to authorize the exact worker request. */
export function createIncusTransportCommand(
  operation: SandboxProtocolOperation,
  input: Record<string, unknown>,
  config: IncusConnectionConfig,
): IncusTransportRequest {
  const action = actionByOperation[operation as keyof typeof actionByOperation];
  if (!action) throw new ContractError("METHOD_NOT_FOUND", "Unknown Incus provider operation");
  const connectionId = input.connectionId as string;
  const sandboxId = input.sandboxId as string | undefined;
  return {
    action,
    connectionId,
    deadlineMs: input.rpcDeadlineMs as number,
    pins: config,
    tags: {
      managedBy: "ezharness-incus-sandbox",
      connectionId,
      ...(sandboxId ? { sandboxId } : {}),
    },
    ...(sandboxId ? { sandboxName: sandboxResourceName(connectionId, sandboxId) } : {}),
    ...(mutationOperations.has(operation) || (operation === "lifecycle.inspectOperation" && input.requestId !== undefined && input.idempotencyKey !== undefined)
      ? {
          idempotency: {
            requestId: input.requestId as string,
            key: input.idempotencyKey as string,
          },
        }
      : {}),
    payload: transportPayload(operation, input, config),
  };
}

export function describeIncusProvider(): unknown {
  return {
    providerId: INCUS_PROVIDER_ID,
    protocolMajor: 1,
    profiles: [...INCUS_PROFILES],
    presetIds: INCUS_PRESETS.map((preset) => preset.id),
    capabilities: [...INCUS_CAPABILITIES],
  };
}

export class IncusSandboxAdapter {
  readonly config: Readonly<IncusConnectionConfig>;
  readonly transport: IncusTransport;
  readonly now: () => number;

  constructor(config: IncusConnectionConfig, transport: IncusTransport, now: () => number = Date.now) {
    this.config = Object.freeze(structuredClone(config));
    this.transport = transport;
    this.now = now;
  }

  async invoke(operation: SandboxProtocolOperation, inputValue: unknown): Promise<unknown> {
    if (!SANDBOX_PROVIDER_OPERATIONS.includes(operation)) {
      throw new ContractError("METHOD_NOT_FOUND", "Unknown Incus provider operation");
    }
    const input = validateSandboxProviderMethodValue(operation, "input", inputValue) as Record<string, unknown>;
    let result: unknown;
    if (operation === "describe") {
      result = describeIncusProvider();
    } else if (operation === "preflight") {
      result = await this.preflight(input);
    } else {
      result = await this.dispatch(operation, input);
    }
    return validateSandboxProviderMethodExchange(operation, input, result).result;
  }

  private async preflight(input: Record<string, unknown>): Promise<unknown> {
    if (input.providerId !== INCUS_PROVIDER_ID) preflightFailure("Incus provider identity does not match");
    if (input.connectionId !== this.config.connectionId) preflightFailure("Incus connection identity does not match");
    const preset = INCUS_PRESETS.find((candidate) => candidate.id === input.presetId);
    if (!preset || preset.profile !== input.profile) preflightFailure("Incus preset and profile do not match");
    const command: IncusTransportRequest = {
      action: "probe",
      connectionId: input.connectionId as string,
      deadlineMs: this.now() + 30_000,
      pins: this.config,
      tags: { managedBy: "ezharness-incus-sandbox", connectionId: input.connectionId as string },
      payload: {
        providerId: INCUS_PROVIDER_ID,
        profile: input.profile as JsonValue,
        presetId: input.presetId as JsonValue,
        presetDigest: input.presetDigest as JsonValue,
        effectiveSettingsDigest: input.effectiveSettingsDigest as JsonValue,
        allocate: false,
      },
    };
    let probe: IncusProbeResult;
    try {
      probe = parseProbe(await this.transport.request(command));
    } catch (cause) {
      if (cause instanceof ContractError) throw cause;
      const failure = operationError("lifecycle.inspect", cause);
      throw new ContractError(failure.error.code, failure.error.message);
    }
    const pins: Array<[string, string, string]> = [
      ["server identity", probe.serverCertificateSha256, this.config.serverCertificateSha256],
      ["project", probe.project, this.config.project],
      ["profile", probe.profile, this.config.profile],
      ["helper version", probe.helperVersion, this.config.helperVersion],
    ];
    const mismatched = pins.find(([, actual, expected]) => actual !== expected);
    if (mismatched) preflightFailure(`Incus ${mismatched[0]} pin does not match`);

    const requiredControls = Object.entries(probe.controls)
      .filter(([name, enabled]) => name !== "workspaceRoot" && enabled !== true)
      .map(([name]) => name);
    if (requiredControls.length > 0) {
      preflightFailure(`Incus required controls are unavailable: ${requiredControls.sort().join(", ")}`);
    }
    if (!preset.requirements.backendApis.includes(probe.backendApi)) {
      preflightFailure("Incus backend API is unsupported by the preset");
    }
    if (!preset.requirements.architectures.includes(probe.architecture)) {
      preflightFailure("Incus architecture is unsupported by the preset");
    }
    if (!preset.requirements.storageDrivers.includes(probe.storageDriver)) {
      preflightFailure("Incus storage driver is unsupported by the preset");
    }
    if (!preset.requirements.isolation.includes(probe.isolation)) {
      preflightFailure("Incus isolation is unsupported by the preset");
    }
    if (preset.requirements.nestedCompose && !probe.nestedCompose) {
      preflightFailure("Incus nested Compose support is unavailable");
    }
    return {
      observation: {
        backendApi: probe.backendApi,
        backendVersion: probe.backendVersion,
        architecture: probe.architecture,
        storageDriver: probe.storageDriver,
        isolation: probe.isolation,
        nestedCompose: probe.nestedCompose,
      },
    };
  }

  private async dispatch(operation: SandboxProtocolOperation, input: Record<string, unknown>): Promise<unknown> {
    const action = actionByOperation[operation as keyof typeof actionByOperation];
    if (!action) throw new ContractError("METHOD_NOT_FOUND", "Unknown Incus provider operation");
    if (input.providerId !== INCUS_PROVIDER_ID) {
      return providerFailure("INVALID_ARGUMENT", "The Incus provider identity does not match");
    }
    if (input.connectionId !== this.config.connectionId) {
      return providerFailure("PERMISSION_DENIED", "The Incus connection identity is not approved");
    }
    if ((input.rpcDeadlineMs as number) <= this.now()) {
      return providerFailure("DEADLINE_EXCEEDED", "The Incus request deadline was exceeded");
    }
    if (operation === "processes.start" && input.user !== this.config.guestUser) {
      return providerFailure("PERMISSION_DENIED", "The requested guest user is not approved");
    }
    if (operation === "lifecycle.create") {
      const preset = INCUS_PRESETS.find((candidate) => candidate.id === input.presetId);
      if (!preset || preset.profile !== input.profile) {
        return providerFailure("INVALID_ARGUMENT", "The Incus preset and profile do not match");
      }
    }
    if (
      operation === "lifecycle.list"
      && input.cursor
      && (input.cursor as Record<string, unknown>).connectionId !== input.connectionId
    ) {
      return providerFailure("INVALID_ARGUMENT", "The sandbox list cursor escaped its connection scope");
    }
    if (
      operation === "files.list"
      && input.cursor
      && (input.cursor as Record<string, unknown>).sandboxId !== input.sandboxId
    ) {
      return providerFailure("INVALID_ARGUMENT", "The file list cursor escaped its sandbox scope");
    }
    if (operation === "processes.readOutput") {
      const cursor = input.cursor as Record<string, unknown>;
      if (
        cursor.sandboxId !== input.sandboxId
        || cursor.processId !== input.processId
        || cursor.bootId !== input.bootId
      ) {
        return providerFailure("INVALID_ARGUMENT", "The process output cursor escaped its process scope");
      }
    }
    const command = createIncusTransportCommand(operation, input, this.config);
    try {
      return await this.transport.request(command);
    } catch (cause) {
      return operationError(operation, cause);
    }
  }
}
