import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  validateSandboxProviderMethodExchange,
  validateSandboxProviderMethodValue,
  type SandboxProtocolOperation,
} from "@ezcorp/extension-contract";
import type { Database } from "../db/connection";
import { getDb } from "../db/connection";
import { sandboxBindings } from "../db/schema";
import {
  getReleaseRuntime,
  ReleaseProcess,
  resolveActiveRelease,
  type ActiveExtensionRelease,
} from "../extensions/release-process";
import type { ProviderSandboxWorkspaceCaller, WorkspaceGuestAction } from "../runtime/workspaces/provider-backend";
import type { SandboxWorkspaceBinding } from "../runtime/workspaces/target";
import { incusMethodName } from "../../extensions/incus-sandbox/manifest";
import { ProviderConnectionStore, type ProviderConnectionCredentials, type ProviderConnectionScope } from "./provider-connections/store";

const operationByAction = {
  "file.stat": "files.stat",
  "file.list": "files.list",
  "file.readRange": "files.readRange",
  "file.writeAtomic": "files.writeAtomic",
  "process.start": "processes.start",
  "process.inspect": "processes.inspect",
  "process.readOutput": "processes.readOutput",
  "process.cancel": "processes.cancel",
} as const satisfies Record<WorkspaceGuestAction, SandboxProtocolOperation>;

const payloadKeys: Record<WorkspaceGuestAction, readonly string[]> = {
  "file.stat": ["path"],
  "file.list": ["path", "limit", "cursor"],
  "file.readRange": ["path", "revision", "offsetBytes", "lengthBytes"],
  "file.writeAtomic": ["path", "expectedRevision", "dataBase64", "byteLength", "executable"],
  "process.start": ["argv", "cwd", "user", "env", "processDeadlineMs"],
  "process.inspect": ["processId", "bootId"],
  "process.readOutput": ["processId", "bootId", "cursor", "maxBytes"],
  "process.cancel": ["processId", "bootId"],
};

const mutations = new Set<WorkspaceGuestAction>(["file.writeAtomic", "process.start", "process.cancel"]);
const actionSuffix = /^.+:[1-9][0-9]*$/;

export interface IncusWorkspaceCallerDependencies {
  db?: Database;
  resolveRelease?: (installationId: string) => Promise<ActiveExtensionRelease>;
  resolveConnection?: (scope: ProviderConnectionScope) => Promise<ProviderConnectionCredentials>;
  invoke?: (installationId: string, bindingId: string, operation: SandboxProtocolOperation, input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number;
}

async function invokeRelease(installationId: string, bindingId: string, operation: SandboxProtocolOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const process = new ReleaseProcess(installationId);
  try {
    const response = await process.callIncusSandboxOperation(bindingId, operation, input, { signal });
    return response.result;
  } finally {
    process.kill();
    await process.whenCallsSettled();
  }
}

function assertBinding(request: Readonly<SandboxWorkspaceBinding>, current: typeof sandboxBindings.$inferSelect): void {
  if (request.providerId !== "incus" || request.projectId !== current.projectId
    || request.workspaceId !== current.resourceKey || current.resourceKey !== current.id
    || request.connectionId !== current.connectionId || request.generation !== current.generation
    || request.presetId !== current.presetId || request.presetDigest !== current.presetDigest
    || request.effectiveSettingsDigest !== current.effectiveSettingsDigest
    || !current.connectionRevision || !current.profile || !current.providerReleaseId
    || current.tombstonedAt || current.desiredState !== "RUNNING" || current.observedState !== "RUNNING") {
    throw new Error("Incus workspace binding is unavailable");
  }
}

function mutationIdentity(bindingId: string, generation: number, action: WorkspaceGuestAction, toolCallId: string): string {
  if (!actionSuffix.test(toolCallId)) throw new Error("Incus workspace action has no unique call suffix");
  return `ws-${createHash("sha256").update(JSON.stringify([bindingId, generation, action, toolCallId])).digest("hex")}`;
}

/** Host-only guest action caller for a running, pinned Incus sandbox. */
export class IncusWorkspaceCaller implements ProviderSandboxWorkspaceCaller {
  private readonly db: Database;
  private readonly resolveRelease: NonNullable<IncusWorkspaceCallerDependencies["resolveRelease"]>;
  private readonly resolveConnection: NonNullable<IncusWorkspaceCallerDependencies["resolveConnection"]>;
  private readonly invoke: NonNullable<IncusWorkspaceCallerDependencies["invoke"]>;
  private readonly now: () => number;

  constructor(dependencies: IncusWorkspaceCallerDependencies = {}) {
    this.db = dependencies.db ?? getDb();
    this.resolveRelease = dependencies.resolveRelease ?? (id => resolveActiveRelease(id, getReleaseRuntime()));
    this.resolveConnection = dependencies.resolveConnection ?? (scope => new ProviderConnectionStore(this.db).resolveForHost(scope));
    this.invoke = dependencies.invoke ?? invokeRelease;
    this.now = dependencies.now ?? Date.now;
  }

  async call(request: Parameters<ProviderSandboxWorkspaceCaller["call"]>[0]): Promise<unknown> {
    if (request.signal?.aborted) throw new Error("Incus workspace action was cancelled");
    const [current] = await this.db.select().from(sandboxBindings)
      .where(eq(sandboxBindings.projectId, request.binding.projectId)).limit(1);
    if (!current) throw new Error("Incus workspace binding is unavailable");
    assertBinding(request.binding, current);
    const operation = operationByAction[request.action];
    if (!operation || Object.keys(request.payload).some(key => !payloadKeys[request.action].includes(key))) {
      throw new Error("Incus workspace action is unsupported");
    }
    const snapshot = await this.resolveRelease(current.providerInstallationId);
    if (snapshot.installation.id !== current.providerInstallationId || snapshot.release.id !== current.providerReleaseId
      || snapshot.release.releaseDigest !== request.binding.releaseDigest
      || !snapshot.release.manifest.methods?.some(method => method.name === incusMethodName(operation))) {
      throw new Error("Incus workspace release changed");
    }
    const connection = await this.resolveConnection({
      connectionId: current.connectionId,
      providerInstallationId: current.providerInstallationId,
      providerReleaseId: current.providerReleaseId,
      revision: current.connectionRevision!,
    });
    if (connection.id !== current.connectionId || connection.revision !== current.connectionRevision
      || connection.providerInstallationId !== current.providerInstallationId
      || connection.providerReleaseId !== current.providerReleaseId || connection.revokedAt
      || connection.configuration.kind !== "incus") {
      throw new Error("Incus workspace connection changed");
    }
    const nowMs = this.now();
    const processDeadlineMs = request.payload.processDeadlineMs;
    if (request.action === "process.start" && (!Number.isSafeInteger(processDeadlineMs)
      || (processDeadlineMs as number) <= nowMs)) {
      throw new Error("Invalid Incus process deadline");
    }
    const deadlineMs = request.action === "process.start"
      ? Math.min(nowMs + 30_000, processDeadlineMs as number)
      : nowMs + 30_000;
    const input: Record<string, unknown> = {
      ...request.payload,
      providerId: "incus", connectionId: current.connectionId, sandboxId: current.id,
      rpcDeadlineMs: deadlineMs,
    };
    if (request.action === "process.start") input.user = connection.configuration.guestUser;
    if (mutations.has(request.action)) {
      const identity = mutationIdentity(current.id, current.generation, request.action, request.toolCallId);
      input.requestId = identity;
      input.idempotencyKey = identity;
    }
    validateSandboxProviderMethodValue(operation, "input", input);
    if (request.signal?.aborted) throw new Error("Incus workspace action was cancelled");
    const result = await this.invoke(current.providerInstallationId, current.id, operation, input, request.signal);
    return validateSandboxProviderMethodExchange(operation, input, result).result;
  }
}
