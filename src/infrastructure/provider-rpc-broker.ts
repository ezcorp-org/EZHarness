import { createHash, X509Certificate } from "node:crypto";
import { ContractError, canonicalJson, sandboxPresetDigest, validateSandboxProviderMethodValue, type JsonValue, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import { and, eq, sql } from "drizzle-orm";
import { getDb, type Database } from "../db/connection";
import { releaseRows } from "../db/queries/extension-releases";
import { sandboxBindings, sandboxOperations, sandboxReservations, type SandboxBinding, type SandboxOperation } from "../db/schema";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import { HostIncusProbeTransport, type HostConnectionResolver } from "./incus-transport/transport";
import type { IncusSetupRecipe } from "../../scripts/incus/model";
import { HostIncusLifecycleTransport, type PostEffectDestroyReplyFault } from "./incus-transport/lifecycle";
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
  readonly approvedPreflight?: { recipe: IncusSetupRecipe; imageFingerprint: string;
    helperSha256: string; nestedCompose: boolean };
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

type ActionBinding = SandboxBinding & {
  connectionRevision: number;
  profile: string;
  presetId: string;
  presetDigest: string;
  effectiveSettingsDigest: string;
  resourceKey: string;
};

function assertActionBinding(
  binding: SandboxBinding | undefined,
  snapshot: ActiveExtensionRelease,
  operation: SandboxProtocolOperation,
  input: Record<string, unknown>,
): ActionBinding {
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
  return binding as ActionBinding;
}

async function approvedActionPreset(snapshot: ActiveExtensionRelease, binding: SandboxBinding, operation: SandboxProtocolOperation) {
  const contribution = snapshot.release.manifest.sandboxProviders?.find(provider => provider.kind === "sandbox" && provider.id === "incus");
  const preset = contribution?.presets.find(candidate => candidate.id === binding.presetId && candidate.profile === binding.profile);
  if (!preset || await sandboxPresetDigest(preset) !== binding.presetDigest
    || !snapshot.release.manifest.methods?.some(method => method.name === incusMethodName(operation))) {
    throw new ContractError("RELEASE_CHANGED", "Incus preset or method changed");
  }
  if (preset.imageDigest === "0".repeat(64)) {
    throw new ContractError("CAPABILITY_UNAVAILABLE", "Reviewed Incus guest image is not published");
  }
  return preset;
}

async function assertCreateAdmission(db: Database, binding: SandboxBinding, preset: Awaited<ReturnType<typeof approvedActionPreset>>, operation: SandboxProtocolOperation, input: Record<string, unknown>): Promise<void> {
  if (operation === "lifecycle.create") {
    if (input.profile !== binding.profile || input.presetId !== binding.presetId
      || input.presetDigest !== binding.presetDigest || input.effectiveSettingsDigest !== binding.effectiveSettingsDigest) {
      throw new ContractError("CAPABILITY_DENIED", "Incus create request changed its approved preset");
    }
    const [reservation] = await db.select().from(sandboxReservations)
      .where(eq(sandboxReservations.bindingId, binding.id)).limit(1);
    if (!reservation || reservation.generation !== binding.generation || reservation.computeState !== "RESERVED"
      || reservation.connectionId !== binding.connectionId || reservation.providerInstallationId !== binding.providerInstallationId
      || reservation.memoryBytes !== preset.limits.memoryBytes || reservation.cpuMillicores !== preset.limits.cpuMillis
      || reservation.pids !== preset.limits.pids || reservation.diskBytes !== preset.limits.diskBytes) {
      throw new ContractError("CAPABILITY_DENIED", "Incus sandbox resource admission is unavailable");
    }
  }
}

function approvedGuestHelper(operation: SandboxProtocolOperation, base: PreparedIncusProbe, preset: Awaited<ReturnType<typeof approvedActionPreset>>): string | undefined {
  const guestOperation = operation.startsWith("files.") || operation.startsWith("processes.");
  const helperSha256 = guestOperation ? guestHelperSha256() : undefined;
  if (guestOperation && (base.config.helperVersion !== GUEST_HELPER_VERSION
    || base.config.guestUser !== "sandbox" || !helperSha256 || !preset.helperDigests.includes(helperSha256))) {
    throw new ContractError("RELEASE_CHANGED", "Approved Incus guest image or helper is unavailable");
  }
  return helperSha256;
}

type ReadbackKind = "CREATE" | "START" | "STOP" | "DESTROY";

function readbackScopeMatches(scope: PreparedIncusAction, binding: SandboxBinding,
  journal: SandboxOperation, kind: ReadbackKind): boolean {
  const preset = scope.approvedPreset;
  return ["DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN"].includes(journal.state)
    && journal.id === binding.currentOperationId && journal.generation === binding.generation
    && journal.generation === scope.bindingGeneration
    && Boolean(binding.tombstonedAt) === (kind === "DESTROY")
    && binding.desiredState === (kind === "START" ? "RUNNING" : kind === "DESTROY" ? "ABSENT" : "STOPPED")
    && binding.profile === preset.profile && binding.presetId === preset.presetId
    && binding.presetDigest === preset.presetDigest && binding.effectiveSettingsDigest === preset.effectiveSettingsDigest;
}

function readbackIntentMatches(scope: PreparedIncusAction, journal: SandboxOperation, kind: ReadbackKind): boolean {
  if (kind !== "CREATE") return journal.requestPayload.expectedGeneration === journal.generation;
  const preset = scope.approvedPreset;
  return journal.generation === 1 && journal.requestPayload.profile === preset.profile
    && journal.requestPayload.presetId === preset.presetId
    && journal.requestPayload.presetDigest === preset.presetDigest
    && journal.requestPayload.effectiveSettingsDigest === preset.effectiveSettingsDigest;
}

async function lifecycleReadbackJournal(db: Database, scope: PreparedIncusAction,
  binding: SandboxBinding, providerOperationId: string, kind: ReadbackKind):
  Promise<{ id: string; generation: number; desiredState: "running" | "stopped" | "absent" } | null> {
  if (scope.expectedCommand.idempotency) return null;
  const rows = await db.select().from(sandboxOperations).where(and(
    eq(sandboxOperations.bindingId, scope.bindingId),
    eq(sandboxOperations.providerOperationId, providerOperationId),
    eq(sandboxOperations.kind, kind),
  )).limit(2);
  if (rows.length !== 1) return null;
  const journal = rows[0]!;
  if (!readbackScopeMatches(scope, binding, journal, kind)
    || !readbackIntentMatches(scope, journal, kind)) return null;
  return { id: journal.id, generation: journal.generation,
    desiredState: kind === "START" ? "running" : kind === "DESTROY" ? "absent" : "stopped" };
}

function lifecycleReadbackKind(scope: PreparedIncusProbe, command: IncusTransportRequest,
  binding: SandboxBinding | undefined, providerOperationId: unknown): "CREATE" | "START" | "STOP" | "DESTROY" | null {
  if (!isAction(scope) || scope.operation !== "lifecycle.inspectOperation"
    || command.idempotency || typeof providerOperationId !== "string") return null;
  const match = /^(?:incus-(create|setPower|destroy)-[a-f0-9-]{36}|ezh-(create|setPower|destroy)-[a-f0-9]{32}-[a-f0-9]{32})$/.exec(providerOperationId);
  const kind = match?.[1] ?? match?.[2];
  if (kind === "create") return "CREATE";
  if (kind === "destroy") return "DESTROY";
  if (kind !== "setPower") return null;
  if (binding?.desiredState === "RUNNING") return "START";
  if (binding?.desiredState === "STOPPED") return "STOP";
  throw new IncusTransportError("permission", "Incus power journal has no desired state");
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
        approvedPreflight: scope.approvedPreflight,
        signal,
      }),
    private readonly db?: Database,
    private readonly actionTransportFactory: (scope: PreparedIncusAction, signal?: AbortSignal) => IncusTransport =
      (scope, signal) => {
        const hostScope = {
        providerInstallationId: scope.installationId,
        providerReleaseId: scope.releaseId,
        revision: scope.revision,
        approvedPreset: scope.approvedPreset,
        ...(scope.approvedGuest ? { approvedGuest: scope.approvedGuest } : {}),
        signal,
        };
        return scope.approvedGuest
          ? new HostIncusGuestTransport(connections, hostScope)
          : new HostIncusLifecycleTransport(connections, hostScope, undefined, lostDestroyReply);
      },
    lostDestroyReply?: PostEffectDestroyReplyFault,
  ) {}

  private get database(): Database { return this.db ?? getDb(); }

  private async reviewedPreflight(scope: PreparedIncusProbe, command: IncusTransportRequest): Promise<PreparedIncusProbe["approvedPreflight"]> {
    // Unit callers without a host database can still make a conservative probe.
    if (!this.db) return undefined;
    const payload = command.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const presetId = payload.presetId;
    if (typeof presetId !== "string") return undefined;
    const [setup] = releaseRows<{ providerReleaseId: string; providerReleaseDigest: string;
      connectionId: string; connectionRevision: number; state: string; recipe: IncusSetupRecipe }>(
      await this.db.execute(sql`SELECT provider_release_id AS "providerReleaseId",
        provider_release_digest AS "providerReleaseDigest", connection_id AS "connectionId",
        connection_revision AS "connectionRevision", state, recipe FROM incus_operator_setups
        WHERE provider_installation_id = ${scope.installationId}
        ORDER BY created_at DESC, id DESC LIMIT 1`));
    if (setup?.state !== "verified" || setup.providerReleaseId !== scope.releaseId
      || setup.providerReleaseDigest !== scope.releaseDigest || setup.connectionId !== scope.connectionId
      || setup.connectionRevision !== scope.revision) return undefined;
    const { IncusQualificationStore } = await import("./incus-qualification");
    const qualification = await new IncusQualificationStore({ db: this.db }).load({
      installationId: scope.installationId, releaseId: scope.releaseId,
      connectionId: scope.connectionId, presetId,
    });
    const image = setup.recipe?.guestImage;
    if (!qualification || qualification.presetDigest !== payload.presetDigest
      || qualification.effectiveSettingsDigest !== payload.effectiveSettingsDigest
      || !image || typeof image.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(image.fingerprint)
      || typeof image.helperSha256 !== "string" || !/^[a-f0-9]{64}$/.test(image.helperSha256)) return undefined;
    return { recipe: setup.recipe, imageFingerprint: image.fingerprint,
      helperSha256: image.helperSha256,
      nestedCompose: qualification.profile === "persistent-web-compose.v1" };
  }

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
    const [binding] = await this.database.select().from(sandboxBindings)
      .where(eq(sandboxBindings.id, bindingId)).limit(1);
    const approvedBinding = assertActionBinding(binding, snapshot, operation, input);
    const base = await this.prepare(snapshot, approvedBinding.connectionId);
    if (base.revision !== approvedBinding.connectionRevision) {
      throw new ContractError("RELEASE_CHANGED", "Incus connection revision changed");
    }
    const preset = await approvedActionPreset(snapshot, approvedBinding, operation);
    await assertCreateAdmission(this.database, approvedBinding, preset, operation, input);
    const expectedCommand = createIncusTransportCommand(operation, input, base.config);
    const helperSha256 = approvedGuestHelper(operation, base, preset);
    return Object.freeze({
      ...base,
      operation,
      method: incusMethodName(operation),
      bindingId,
      projectId: approvedBinding.projectId,
      bindingGeneration: approvedBinding.generation,
      resourceKey: approvedBinding.resourceKey,
      expectedCommand,
      ...(helperSha256 ? { approvedGuest: Object.freeze({ user: "sandbox", uid: 1000, gid: 1000, helperSha256 }) } : {}),
      approvedPreset: Object.freeze({
        profile: approvedBinding.profile,
        incusProfile: base.config.profile,
        presetId: approvedBinding.presetId,
        presetDigest: approvedBinding.presetDigest,
        effectiveSettingsDigest: approvedBinding.effectiveSettingsDigest,
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
      let binding: SandboxBinding | undefined;
      if (isAction(scope)) {
        [binding] = await this.database.select().from(sandboxBindings)
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
      const reviewedScope = !isAction(scope)
        ? { ...scope, approvedPreflight: await this.reviewedPreflight(scope, command) }
        : scope;
      const providerOperationId = command.action === "operation.inspect"
        && command.payload && typeof command.payload === "object" && !Array.isArray(command.payload)
        ? command.payload.operationId : null;
      const readbackKind = lifecycleReadbackKind(scope, command, binding, providerOperationId);
      let transportCommand = command;
      if (readbackKind && isAction(scope)) {
        const journal = binding ? await lifecycleReadbackJournal(this.database, scope, binding,
          providerOperationId as string, readbackKind) : null;
        if (!journal) throw new IncusTransportError("permission", "Incus lifecycle journal is unavailable");
        transportCommand = { ...command,
          idempotency: { requestId: journal.id, key: journal.id },
          ...(readbackKind === "CREATE" ? {} : { payload: { ...command.payload as Record<string, JsonValue>,
            readback: { expectedGeneration: journal.generation, desiredState: journal.desiredState } } }),
        };
      }
      const transport = isAction(scope)
        ? this.actionTransportFactory(scope, signal)
        : this.transportFactory(reviewedScope, signal);
      return await transport.request({ ...transportCommand, deadlineMs: Math.min(command.deadlineMs, deadline) }) as JsonValue;
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
