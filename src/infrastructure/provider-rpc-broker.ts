import { createHash, X509Certificate } from "node:crypto";
import { ContractError, canonicalJson, sandboxPresetDigest, validateSandboxProviderMethodValue, type JsonValue, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import { eq } from "drizzle-orm";
import { getDb, type Database } from "../db/connection";
import { sandboxBindings, sandboxReservations } from "../db/schema";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import { HostIncusProbeTransport, type HostConnectionResolver } from "./incus-transport/transport";
import { HostIncusLifecycleTransport } from "./incus-transport/lifecycle";
import { HostIncusGuestTransport } from "./incus-transport/guest";
import { GUEST_HELPER_VERSION, guestHelperSha256 } from "./incus-guest/protocol";
import { createIncusTransportCommand } from "../../extensions/incus-sandbox/adapter";
import { incusMethodName } from "../../extensions/incus-sandbox/manifest";
import type { IncusConnectionConfig } from "../../extensions/incus-sandbox/config";
import { IncusTransportError, type IncusTransport, type IncusTransportRequest } from "../../extensions/incus-sandbox/transport";

export const INCUS_PROVIDER_TRANSPORT_RPC = "ezcorp/provider.incus.transport";
export const INCUS_PROVIDER_PREFLIGHT_METHOD = "incus/preflight";

interface Connection extends Awaited<ReturnType<HostConnectionResolver["resolveForHost"]>> {
  id: string;
  revision: number;
  configuration: { kind: "incus"; profile: string; helperVersion: string; guestUser: string };
}

export interface ProviderConnectionResolver extends HostConnectionResolver {
  resolveForHost(scope: { connectionId: string; providerInstallationId: string; providerReleaseId: string; revision: number }): Promise<Connection>;
  getMetadata(id: string): Promise<Pick<Connection, "id" | "revision"> & { providerInstallationId: string; providerReleaseId: string; revokedAt: Date | null } | null>;
}

export interface PreparedIncusProbe {
  readonly installationId: string;
  readonly releaseId: string;
  readonly releaseDigest: string;
  readonly generation: number;
  readonly connectionId: string;
  readonly revision: number;
  readonly config: IncusConnectionConfig;
}

export interface PreparedIncusAction extends PreparedIncusProbe {
  readonly operation: SandboxProtocolOperation;
  readonly method: string;
  readonly bindingId: string;
  readonly projectId: string;
  readonly bindingGeneration: number;
  readonly resourceKey: string;
  readonly expectedCommand: IncusTransportRequest;
  readonly approvedPreset: {
    profile: string;
    incusProfile: string;
    presetId: string;
    presetDigest: string;
    effectiveSettingsDigest: string;
    imageFingerprint: string;
    limits: { memoryBytes: number; cpuMillis: number; pids: number; diskBytes: number };
  };
  readonly approvedGuest?: { user: string; uid: number; gid: number; helperSha256: string };
}

const mutationOperations = new Set<SandboxProtocolOperation>([
  "lifecycle.create", "lifecycle.setPower", "lifecycle.destroy",
  "files.writeAtomic", "files.remove", "processes.start", "processes.cancel",
]);

function isAction(scope: PreparedIncusProbe): scope is PreparedIncusAction {
  return "expectedCommand" in scope;
}

function fingerprint(pem: string): string {
  try { return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex"); }
  catch { throw new ContractError("INVALID_PROVIDER_CONFIG", "Incus server identity is invalid"); }
}

/** Only ReleaseProcess calls this broker. No generic extension capability exposes it. */
export class ProviderRpcBroker {
  private readonly dispatchedMutations = new WeakMap<PreparedIncusAction, Promise<JsonValue>>();
  constructor(
    private readonly connections: ProviderConnectionResolver,
    private readonly transportFactory: (scope: PreparedIncusProbe, signal?: AbortSignal) => HostIncusProbeTransport =
      (scope, signal) => new HostIncusProbeTransport(connections, {
        providerInstallationId: scope.installationId,
        providerReleaseId: scope.releaseId,
        revision: scope.revision,
        signal,
      }),
    private readonly db: Database = getDb(),
    private readonly actionTransportFactory: (scope: PreparedIncusAction, signal?: AbortSignal) => IncusTransport =
      (scope, signal) => new (scope.approvedGuest ? HostIncusGuestTransport : HostIncusLifecycleTransport)(connections, {
        providerInstallationId: scope.installationId,
        providerReleaseId: scope.releaseId,
        revision: scope.revision,
        approvedPreset: scope.approvedPreset,
        ...(scope.approvedGuest ? { approvedGuest: scope.approvedGuest } : {}),
        signal,
      }),
  ) {}

  /** Bind one host-journaled operation to its exact approved release and preset. */
  async prepareAction(
    snapshot: ActiveExtensionRelease,
    bindingId: string,
    operation: SandboxProtocolOperation,
    inputValue: unknown,
  ): Promise<PreparedIncusAction> {
    if (operation === "describe" || operation === "preflight" || operation.startsWith("endpoints.")) {
      throw new ContractError("CAPABILITY_DENIED", "Incus action is not available to the host broker");
    }
    const input = validateSandboxProviderMethodValue(operation, "input", inputValue) as Record<string, unknown>;
    const [binding] = await this.db.select().from(sandboxBindings)
      .where(eq(sandboxBindings.id, bindingId)).limit(1);
    if (!binding || binding.tombstonedAt && operation !== "lifecycle.destroy" && operation !== "lifecycle.inspectOperation"
      || binding.providerInstallationId !== snapshot.installation.id || binding.providerReleaseId !== snapshot.release.id
      || !binding.connectionRevision || !binding.profile || !binding.presetId || !binding.presetDigest
      || !binding.effectiveSettingsDigest || !binding.resourceKey
      || input.connectionId !== binding.connectionId || input.providerId !== "incus"
      || input.sandboxId !== binding.id) {
      throw new ContractError("CAPABILITY_DENIED", "Incus sandbox binding is unavailable");
    }
    if ((operation.startsWith("files.") || operation.startsWith("processes."))
      && (binding.desiredState !== "RUNNING" || binding.observedState !== "RUNNING")) {
      throw new ContractError("CAPABILITY_DENIED", "Incus workspace is not running");
    }
    const base = await this.prepare(snapshot, binding.connectionId);
    if (base.revision !== binding.connectionRevision) {
      throw new ContractError("RELEASE_CHANGED", "Incus connection revision changed");
    }
    const contribution = snapshot.release.manifest.sandboxProviders?.find(provider => provider.kind === "sandbox" && provider.id === "incus");
    const preset = contribution?.presets.find(candidate => candidate.id === binding.presetId && candidate.profile === binding.profile);
    if (!preset || await sandboxPresetDigest(preset) !== binding.presetDigest
      || !snapshot.release.manifest.methods?.some(method => method.name === incusMethodName(operation))) {
      throw new ContractError("RELEASE_CHANGED", "Incus preset or method changed");
    }
    if (preset.imageDigest === "0".repeat(64)) {
      throw new ContractError("CAPABILITY_UNAVAILABLE", "Reviewed Incus guest image is not published");
    }
    if (operation === "lifecycle.create") {
      if (input.profile !== binding.profile || input.presetId !== binding.presetId
        || input.presetDigest !== binding.presetDigest || input.effectiveSettingsDigest !== binding.effectiveSettingsDigest) {
        throw new ContractError("CAPABILITY_DENIED", "Incus create request changed its approved preset");
      }
      const [reservation] = await this.db.select().from(sandboxReservations)
        .where(eq(sandboxReservations.bindingId, binding.id)).limit(1);
      if (!reservation || reservation.generation !== binding.generation || reservation.computeState !== "RESERVED"
        || reservation.connectionId !== binding.connectionId || reservation.providerInstallationId !== binding.providerInstallationId
        || reservation.memoryBytes !== preset.limits.memoryBytes || reservation.cpuMillicores !== preset.limits.cpuMillis
        || reservation.pids !== preset.limits.pids || reservation.diskBytes !== preset.limits.diskBytes) {
        throw new ContractError("CAPABILITY_DENIED", "Incus sandbox resource admission is unavailable");
      }
    }
    const expectedCommand = createIncusTransportCommand(operation, input, base.config);
    const guestOperation = operation.startsWith("files.") || operation.startsWith("processes.");
    const helperSha256 = guestOperation ? guestHelperSha256() : undefined;
    if (guestOperation && (base.config.helperVersion !== GUEST_HELPER_VERSION
      || base.config.guestUser !== "sandbox" || !helperSha256 || !preset.helperDigests.includes(helperSha256))) {
      throw new ContractError("RELEASE_CHANGED", "Approved Incus guest image or helper is unavailable");
    }
    return Object.freeze({
      ...base,
      operation,
      method: incusMethodName(operation),
      bindingId,
      projectId: binding.projectId,
      bindingGeneration: binding.generation,
      resourceKey: binding.resourceKey,
      expectedCommand,
      ...(helperSha256 ? { approvedGuest: Object.freeze({ user: "sandbox", uid: 1000, gid: 1000, helperSha256 }) } : {}),
      approvedPreset: Object.freeze({
        profile: binding.profile,
        incusProfile: base.config.profile,
        presetId: binding.presetId,
        presetDigest: binding.presetDigest,
        effectiveSettingsDigest: binding.effectiveSettingsDigest,
        imageFingerprint: preset.imageDigest,
        limits: Object.freeze({
          memoryBytes: preset.limits.memoryBytes,
          cpuMillis: preset.limits.cpuMillis,
          pids: preset.limits.pids,
          diskBytes: preset.limits.diskBytes,
        }),
      }),
    });
  }

  async prepare(snapshot: ActiveExtensionRelease, connectionId: string): Promise<PreparedIncusProbe> {
    if (!snapshot.release.manifest.sandboxProviders?.some((provider) => provider.id === "incus" && provider.kind === "sandbox")
      || !snapshot.release.manifest.methods?.some((method) => method.name === INCUS_PROVIDER_PREFLIGHT_METHOD)) {
      throw new ContractError("UNDECLARED_CONTRIBUTION", "Incus provider preflight is not declared");
    }
    const metadata = await this.connections.getMetadata(connectionId);
    if (!metadata || metadata.revokedAt || metadata.providerInstallationId !== snapshot.installation.id
      || metadata.providerReleaseId !== snapshot.release.id) {
      throw new ContractError("INVALID_PROVIDER_CONFIG", "Incus provider connection is unavailable");
    }
    let connection: Connection;
    try {
      connection = await this.connections.resolveForHost({
        connectionId, providerInstallationId: snapshot.installation.id,
        providerReleaseId: snapshot.release.id, revision: metadata.revision,
      });
    } catch {
      throw new ContractError("INVALID_PROVIDER_CONFIG", "Incus provider connection is unavailable");
    }
    if (connection.configuration.kind !== "incus") {
      throw new ContractError("INVALID_PROVIDER_CONFIG", "Incus provider connection has the wrong kind");
    }
    return Object.freeze({
      installationId: snapshot.installation.id,
      releaseId: snapshot.release.id,
      releaseDigest: snapshot.release.releaseDigest,
      generation: snapshot.installation.generation,
      connectionId,
      revision: metadata.revision,
      config: Object.freeze({
        connectionId,
        serverCertificateSha256: fingerprint(connection.serverCertificatePem),
        project: connection.project,
        profile: connection.configuration.profile,
        helperVersion: connection.configuration.helperVersion,
        guestUser: connection.configuration.guestUser,
      }),
    });
  }

  async request(scope: PreparedIncusProbe, input: Record<string, unknown>, deadline: number, signal?: AbortSignal): Promise<JsonValue> {
    try { return { ok: true, result: await this.probe(scope, input, deadline, signal) } as JsonValue; }
    catch (error) {
      if (error instanceof IncusTransportError) {
        return { ok: false, error: { kind: error.kind, effect: error.effect,
          ...(error.operationId ? { operationId: error.operationId } : {}) } } as JsonValue;
      }
      throw error;
    }
  }

  private async probe(scope: PreparedIncusProbe, input: Record<string, unknown>, deadline: number, signal?: AbortSignal): Promise<JsonValue> {
    if (signal?.aborted) throw new IncusTransportError("deadline", "Incus probe was cancelled");
    if (Object.keys(input).length !== 1 || !input.command || typeof input.command !== "object" || Array.isArray(input.command)) {
      throw new ContractError("INVALID_REQUEST", "Invalid Incus provider request");
    }
    const command = input.command as unknown as IncusTransportRequest;
    if (isAction(scope)) {
      if (canonicalJson(command) !== canonicalJson(scope.expectedCommand)) {
        throw new IncusTransportError("permission", "Incus provider request changed its host-approved action");
      }
    } else if (command.action !== "probe") throw new IncusTransportError("unsupported", "Incus transport action is unavailable");
    if (!command.pins || typeof command.pins !== "object" || Array.isArray(command.pins)
      || !command.tags || typeof command.tags !== "object" || Array.isArray(command.tags)) {
      throw new IncusTransportError("invalid", "Invalid Incus provider request");
    }
    if (command.connectionId !== scope.connectionId
      || command.pins?.connectionId !== scope.connectionId
      || command.pins?.serverCertificateSha256 !== scope.config.serverCertificateSha256
      || command.pins?.project !== scope.config.project || command.pins?.profile !== scope.config.profile
      || command.pins?.helperVersion !== scope.config.helperVersion || command.pins?.guestUser !== scope.config.guestUser) {
      throw new IncusTransportError("permission", "Incus provider request is outside its approved connection");
    }
    const dispatch = async (): Promise<JsonValue> => {
      if (isAction(scope)) {
        const [binding] = await this.db.select().from(sandboxBindings)
          .where(eq(sandboxBindings.id, scope.bindingId)).limit(1);
        const inspection = scope.operation === "lifecycle.inspectOperation";
        if (!binding || binding.projectId !== scope.projectId
          || binding.providerInstallationId !== scope.installationId
          || binding.providerReleaseId !== scope.releaseId
          || binding.connectionId !== scope.connectionId || binding.connectionRevision !== scope.revision
          || binding.resourceKey !== scope.resourceKey
          || !inspection && (binding.generation !== scope.bindingGeneration || binding.tombstonedAt && scope.operation !== "lifecycle.destroy")
          || (scope.operation.startsWith("files.") || scope.operation.startsWith("processes."))
            && (binding.desiredState !== "RUNNING" || binding.observedState !== "RUNNING")
          || !inspection && scope.expectedCommand.idempotency
            && binding.currentOperationId !== scope.expectedCommand.idempotency.requestId
            && scope.operation.startsWith("lifecycle.")) {
          throw new IncusTransportError("permission", "Incus binding changed before transport dispatch");
        }
      }
      const transport = isAction(scope)
        ? this.actionTransportFactory(scope, signal)
        : this.transportFactory(scope, signal);
      return await transport.request({ ...command, deadlineMs: Math.min(command.deadlineMs, deadline) }) as JsonValue;
    };
    if (isAction(scope) && mutationOperations.has(scope.operation)) {
      const prior = this.dispatchedMutations.get(scope);
      if (prior) return prior;
      const invocation = dispatch();
      this.dispatchedMutations.set(scope, invocation);
      return invocation;
    }
    return dispatch();
  }
}
