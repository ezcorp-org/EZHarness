import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { resolveSandboxPreset, sandboxPresetDigest, validateSandboxProviderMethodExchange,
  type SandboxPreset, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import { getDb, type Database } from "../db/connection";
import { incusQualificationFixtures, sandboxBindings } from "../db/schema";
import { releaseRows } from "../db/queries/extension-releases";
import { getReleaseRuntime, ReleaseProcess, resolveActiveRelease,
  type ActiveExtensionRelease } from "../extensions/release-process";
import type { IncusSetupRecipe } from "../../scripts/incus/model";
import { IncusQualificationFixtureService, IncusQualificationStore, type IncusImageReceipt,
  type IncusQualificationScope } from "./incus-qualification";
import type { HostIncusLiveWitness, LiveFixtureHandle, LiveFixtureInspection } from "./incus-live-cases";
import { observeIncusResourceEnforcement, type IncusNetworkTarget } from "./incus-live-resource-probes";
import { IncusLiveNetworkProbe } from "./incus-live-network-probe";
import { HostIncusLiveReadback, type LiveReadbackContext } from "./incus-transport/live-readback";
import { ProviderConnectionStore, type ProviderConnectionCredentials,
  type ProviderConnectionScope } from "./provider-connections/store";

const MAX_FILE_BYTES = 64 * 1024;
const POLL_MS = 100;
const CONTROL_DENIALS = ["unsupported", "missingControl", "drift", "unqualified"] as const;
type ControlDenial = (typeof CONTROL_DENIALS)[number];
const guestOperations = new Set<SandboxProtocolOperation>([
  "files.stat", "files.readRange", "files.writeAtomic", "processes.start", "processes.inspect", "processes.readOutput",
]);

/** Operator qualification must stay closed until every SP witness method is real. */
export function incusHostLiveWitnessReady(): boolean {
  return false;
}

function deny(reason: string): never {
  throw new Error(`Incus live witness unavailable: ${reason}`);
}

function reply(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny("invalid guest reply");
  const result = value as Record<string, unknown>;
  if (result.ok !== true) deny("guest action failed");
  return result;
}

function safePath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")
    || path.split("/").some(part => part === ".." || part === "")) deny("invalid guest path");
  return path;
}

function inventoryIds(values: string[]): string {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))
    || new Set(values).size !== values.length) deny("control inventory identity is invalid");
  return [...values].sort().join("\0");
}

export interface IncusHostLiveWitnessDependencies {
  db?: Database;
  qualifications?: IncusQualificationStore;
  fixtures?: IncusQualificationFixtureService;
  /** Replace only with a test seam that performs the same protected release call. */
  invokeGuest?: (installationId: string, bindingId: string, operation: SandboxProtocolOperation,
    input: Record<string, unknown>) => Promise<unknown>;
  activeRelease?: (installationId: string) => Promise<ActiveExtensionRelease>;
  resolveConnection?: (scope: ProviderConnectionScope) => Promise<ProviderConnectionCredentials>;
  readSetup?: (installationId: string) => Promise<IncusImageReceipt | null>;
  backend?: Pick<HostIncusLiveReadback, "image" | "instance">;
  /** An operator-owned probe must call production admission and read independent
   * reservation, operation, backend inventory, and local canary state. No default. */
  controlProbe?: {
    snapshot(kind: ControlDenial, scope: IncusQualificationScope): Promise<{
      reservationIds: string[]; operationIds: string[]; backendIds: string[];
      canaryIdentity: string; canaryBytes: Uint8Array;
    }>;
    attempt(kind: ControlDenial, scope: IncusQualificationScope, preset: SandboxPreset): Promise<string>;
  };
  /** Host-owned source of a running, distinct sandbox service and independent
   * host reachability checks. */
  resourceNetwork?: {
    neighborTarget(context: LiveReadbackContext, neighbor: LiveFixtureHandle): Promise<IncusNetworkTarget & {
      sandboxId: string;
    }>;
    hostCanConnect(target: IncusNetworkTarget): Promise<boolean>;
  };
  now?: () => number;
}

async function readSetup(db: Database, installationId: string): Promise<IncusImageReceipt | null> {
  const [row] = releaseRows<IncusImageReceipt>(await db.execute(sql`SELECT
    provider_release_id AS "providerReleaseId", provider_release_digest AS "providerReleaseDigest",
    connection_id AS "connectionId", connection_revision AS "connectionRevision", state, recipe
    FROM incus_operator_setups WHERE provider_installation_id = ${installationId}
    ORDER BY created_at DESC, id DESC LIMIT 1`));
  return row ?? null;
}

async function invokeRelease(installationId: string, bindingId: string, operation: SandboxProtocolOperation,
  input: Record<string, unknown>): Promise<unknown> {
  const process = new ReleaseProcess(installationId);
  try {
    return (await process.callIncusSandboxOperation(bindingId, operation, input)).result;
  } finally {
    process.kill();
    await process.whenCallsSettled();
  }
}

/** Host authority for a qualification fixture. It never accepts a user binding.
 * The incomplete host probes below throw, so this class cannot issue SP passes
 * until each missing readback has a real controller or Incus implementation. */
export class IncusHostLiveWitness implements HostIncusLiveWitness {
  private readonly db: Database;
  private readonly qualifications: IncusQualificationStore;
  private readonly fixtures: IncusQualificationFixtureService;
  private readonly invokeGuest: NonNullable<IncusHostLiveWitnessDependencies["invokeGuest"]>;
  private readonly activeRelease: NonNullable<IncusHostLiveWitnessDependencies["activeRelease"]>;
  private readonly resolveConnection: NonNullable<IncusHostLiveWitnessDependencies["resolveConnection"]>;
  private readonly readSetup: NonNullable<IncusHostLiveWitnessDependencies["readSetup"]>;
  private readonly backend: NonNullable<IncusHostLiveWitnessDependencies["backend"]>;
  private readonly controlProbe: IncusHostLiveWitnessDependencies["controlProbe"];
  private readonly resourceNetwork: IncusHostLiveWitnessDependencies["resourceNetwork"];
  private readonly now: () => number;

  constructor(deps: IncusHostLiveWitnessDependencies = {}) {
    this.db = deps.db ?? getDb();
    this.qualifications = deps.qualifications ?? new IncusQualificationStore({ db: this.db });
    this.fixtures = deps.fixtures ?? new IncusQualificationFixtureService({ db: this.db,
      qualifications: this.qualifications });
    this.invokeGuest = deps.invokeGuest ?? invokeRelease;
    this.activeRelease = deps.activeRelease ?? (id => resolveActiveRelease(id, getReleaseRuntime()));
    this.resolveConnection = deps.resolveConnection ?? (scope => new ProviderConnectionStore(this.db).resolveForHost(scope));
    this.readSetup = deps.readSetup ?? (id => readSetup(this.db, id));
    this.backend = deps.backend ?? new HostIncusLiveReadback(new ProviderConnectionStore(this.db));
    this.controlProbe = deps.controlProbe;
    this.resourceNetwork = deps.resourceNetwork ?? new IncusLiveNetworkProbe({ db: this.db });
    this.now = deps.now ?? Date.now;
  }

  private async persistedOwned(handle: LiveFixtureHandle, requireRunning: boolean, allowTombstoned = false) {
    const [fixture] = await this.db.select().from(incusQualificationFixtures)
      .where(eq(incusQualificationFixtures.operationId, handle.operationId)).limit(1);
    if (!fixture || fixture.bindingId !== handle.sandboxId) deny("fixture identity changed");
    const [binding] = await this.db.select().from(sandboxBindings)
      .where(eq(sandboxBindings.id, fixture.bindingId)).limit(1);
    if (!binding || binding.projectId !== fixture.projectId || binding.resourceKey !== fixture.bindingId
      || binding.providerInstallationId !== fixture.installationId || binding.providerReleaseId !== fixture.releaseId
      || binding.connectionId !== fixture.connectionId || binding.connectionRevision !== fixture.connectionRevision
      || binding.presetId !== fixture.presetId || binding.presetDigest !== fixture.presetDigest
      || binding.effectiveSettingsDigest !== fixture.effectiveSettingsDigest
      || binding.tombstonedAt && !allowTombstoned
      || requireRunning && (binding.desiredState !== "RUNNING" || binding.observedState !== "RUNNING")) {
      deny("fixture binding changed or is not running");
    }
    const scope: IncusQualificationScope = { installationId: fixture.installationId, releaseId: fixture.releaseId,
      connectionId: fixture.connectionId, presetId: fixture.presetId };
    return { fixture, binding, scope };
  }

  private async owned(handle: LiveFixtureHandle, requireRunning: boolean, allowTombstoned = false) {
    const { fixture, binding, scope } = await this.persistedOwned(handle, requireRunning, allowTombstoned);
    const selected = await this.qualifications.authorizeFixture(scope);
    if (selected.connection.revision !== fixture.connectionRevision || selected.presetDigest !== fixture.presetDigest
      || selected.effectiveSettingsDigest !== fixture.effectiveSettingsDigest) deny("reviewed fixture settings changed");
    return { fixture, binding, scope, selected };
  }

  private async guest(handle: LiveFixtureHandle, operation: SandboxProtocolOperation,
    payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!guestOperations.has(operation)) deny("guest operation is not approved for a witness");
    const { fixture, binding } = await this.owned(handle, true);
    const active = await this.activeRelease(fixture.installationId);
    if (active.installation.id !== fixture.installationId || active.release.id !== fixture.releaseId
      || active.installation.activeReleaseId !== fixture.releaseId) deny("active release changed");
    const connection = await this.resolveConnection({
      connectionId: fixture.connectionId, providerInstallationId: fixture.installationId,
      providerReleaseId: fixture.releaseId, revision: fixture.connectionRevision,
    });
    if (connection.id !== fixture.connectionId || connection.revision !== fixture.connectionRevision
      || connection.revokedAt || connection.configuration.kind !== "incus") deny("connection changed");
    const now = this.now();
    const input: Record<string, unknown> = { ...payload, providerId: "incus", connectionId: fixture.connectionId,
      sandboxId: fixture.bindingId, rpcDeadlineMs: now + 30_000 };
    if (operation === "processes.start") {
      const requestedDeadline = Number(payload.processDeadlineMs);
      if (!Number.isSafeInteger(requestedDeadline) || requestedDeadline <= now
        || requestedDeadline > now + 120_000) deny("guest process deadline changed");
      input.user = connection.configuration.guestUser;
      input.rpcDeadlineMs = Math.min(now + 30_000, requestedDeadline);
      input.processDeadlineMs = requestedDeadline;
    }
    if (operation === "files.writeAtomic" || operation === "processes.start") {
      const identity = `qual-guest-${createHash("sha256").update(JSON.stringify([
        fixture.operationId, binding.generation, operation, payload, now,
      ])).digest("hex")}`;
      input.requestId = identity;
      input.idempotencyKey = identity;
    }
    const result = await this.invokeGuest(fixture.installationId, fixture.bindingId, operation, input);
    return reply(validateSandboxProviderMethodExchange(operation, input, result).result);
  }

  private async assertDurableState(handle: LiveFixtureHandle, scope: IncusQualificationScope,
    state: "RUNNING" | "STOPPED" | "ABSENT"): Promise<void> {
    const readback = await this.fixtures.status(scope, handle.operationId);
    if (readback.fixture.bindingId !== handle.sandboxId
      || readback.fixture.installationId !== scope.installationId
      || readback.fixture.releaseId !== scope.releaseId
      || readback.fixture.connectionId !== scope.connectionId
      || readback.fixture.presetId !== scope.presetId
      || readback.binding.id !== handle.sandboxId
      || readback.binding.observedState !== state || readback.binding.desiredState !== state) {
      deny("durable fixture state changed");
    }
  }

  private async context(scope: IncusQualificationScope, preset: SandboxPreset): Promise<{
    context: LiveReadbackContext; helperDigest: string;
  }> {
    const selected = await this.qualifications.authorizeFixture(scope);
    const setup = await this.readSetup(scope.installationId);
    const image = setup?.recipe?.guestImage;
    if (setup?.state !== "verified" || setup.providerReleaseId !== scope.releaseId
      || setup.providerReleaseDigest !== selected.snapshot.release.releaseDigest
      || setup.connectionId !== scope.connectionId || setup.connectionRevision !== selected.connection.revision
      || selected.preset.id !== preset.id || selected.presetDigest !== await sandboxPresetDigest(preset)
      || image?.fingerprint !== preset.imageDigest || !preset.helperDigests.includes(image.helperSha256)
      || setup.recipe.profile.name !== selected.connection.configuration.profile) {
      deny("verified setup, release, connection, image, or helper changed");
    }
    return { context: { scope, connection: selected.connection, preset,
      presetDigest: selected.presetDigest, effectiveSettingsDigest: selected.effectiveSettingsDigest,
      recipe: setup.recipe as IncusSetupRecipe }, helperDigest: image.helperSha256 };
  }

  async observe(scope: IncusQualificationScope, preset: SandboxPreset): ReturnType<HostIncusLiveWitness["observe"]> {
    const selected = await this.context(scope, preset);
    const observed = await this.backend.image(selected.context);
    if (observed.imageDigest !== preset.imageDigest || observed.helperDigest !== selected.helperDigest
      || observed.profile !== preset.profile) deny("backend artifact readback changed");
    return observed;
  }

  async controlFacts(scope: IncusQualificationScope, preset: SandboxPreset): ReturnType<HostIncusLiveWitness["controlFacts"]> {
    if (!this.controlProbe) deny("operator-owned production admission, inventory, and distinct canary probes are unavailable");
    const { context, helperDigest } = await this.context(scope, preset);
    const provider = (await this.qualifications.authorizeFixture(scope)).snapshot.release.manifest
      .sandboxProviders?.find(item => item.id === "incus" && item.kind === "sandbox");
    if (!provider) deny("reviewed provider declaration is unavailable");
    const backend = await this.backend.image(context);
    if (backend.imageDigest !== preset.imageDigest || backend.helperDigest !== helperDigest
      || backend.profile !== preset.profile) deny("backend artifact changed during control probe");
    const observed = backend.observation;
    const request = { profile: preset.profile, presetId: preset.id, observation: observed };
    const baseline = await resolveSandboxPreset(provider, request);
    const repeated = await resolveSandboxPreset(provider, request);
    const change = (Object.keys(preset.allowedOverrides) as Array<keyof SandboxPreset["limits"]>)
      .find(key => {
        const bounds = preset.allowedOverrides[key];
        return bounds && (bounds.minimum !== preset.limits[key] || bounds.maximum !== preset.limits[key]);
      });
    if (!change) deny("reviewed preset has no measurable settings change");
    const bounds = preset.allowedOverrides[change]!;
    const alternate = bounds.minimum !== preset.limits[change] ? bounds.minimum : bounds.maximum;
    const changed = await resolveSandboxPreset(provider,
      { ...request, overrides: { [change]: alternate } });
    if (baseline.effectiveSettingsDigest !== repeated.effectiveSettingsDigest
      || baseline.effectiveSettingsDigest === changed.effectiveSettingsDigest) {
      deny("effective settings resolution is not deterministic");
    }
    const codes = new Map<ControlDenial, string>();
    const deltas = new Map<ControlDenial, number>();
    const canaries: Array<{ kind: ControlDenial; identity: string; before: string; after: string }> = [];
    for (const kind of CONTROL_DENIALS) {
      const before = await this.controlProbe.snapshot(kind, scope);
      const code = await this.controlProbe.attempt(kind, scope, preset);
      const after = await this.controlProbe.snapshot(kind, scope);
      const allocationDelta = after.reservationIds.length + after.operationIds.length + after.backendIds.length
        - before.reservationIds.length - before.operationIds.length - before.backendIds.length;
      if (typeof code !== "string" || !code.startsWith("DENIED_")
        || allocationDelta !== 0
        || inventoryIds(before.reservationIds) !== inventoryIds(after.reservationIds)
        || inventoryIds(before.operationIds) !== inventoryIds(after.operationIds)
        || inventoryIds(before.backendIds) !== inventoryIds(after.backendIds)
        || !before.canaryIdentity || before.canaryIdentity !== after.canaryIdentity
        || !(before.canaryBytes instanceof Uint8Array) || !(after.canaryBytes instanceof Uint8Array)) {
        deny(`${kind} admission or allocation readback changed`);
      }
      codes.set(kind, code);
      deltas.set(kind, allocationDelta);
      canaries.push({ kind, identity: before.canaryIdentity,
        before: createHash("sha256").update(before.canaryBytes).digest("hex"),
        after: createHash("sha256").update(after.canaryBytes).digest("hex") });
    }
    if (new Set(canaries.map(value => value.identity)).size !== CONTROL_DENIALS.length
      || canaries.some(value => value.before !== value.after)) deny("distinct local canaries changed");
    const beforeCanaryDigest = createHash("sha256").update(JSON.stringify(canaries.map(value =>
      [value.kind, value.identity, value.before]))).digest("hex");
    const afterCanaryDigest = createHash("sha256").update(JSON.stringify(canaries.map(value =>
      [value.kind, value.identity, value.after]))).digest("hex");
    return { baselinePlanDigest: baseline.effectiveSettingsDigest,
      repeatedPlanDigest: repeated.effectiveSettingsDigest, changedPlanDigest: changed.effectiveSettingsDigest,
      unsupportedAdmissionCode: codes.get("unsupported")!, unsupportedAllocationDelta: deltas.get("unsupported")!,
      missingControlAdmissionCode: codes.get("missingControl")!, missingControlAllocationDelta: deltas.get("missingControl")!,
      driftAdmissionCode: codes.get("drift")!, driftAllocationDelta: deltas.get("drift")!,
      unqualifiedAdmissionCode: codes.get("unqualified")!, unqualifiedAllocationDelta: deltas.get("unqualified")!,
      localCanaryBefore: beforeCanaryDigest, localCanaryAfter: afterCanaryDigest };
  }

  async createFixture(scope: IncusQualificationScope, preset: SandboxPreset,
    operationId: string, dropFirstReply: boolean): Promise<LiveFixtureHandle> {
    const selected = await this.qualifications.authorizeFixture(scope);
    if (preset.id !== scope.presetId || preset.id !== selected.preset.id
      || await sandboxPresetDigest(preset) !== selected.presetDigest) deny("fixture preset changed");
    // Throw away the first service reply at this host boundary, then ask the
    // durable controller for the same operation. Both IDs must be identical.
    let effectPossible = false;
    try {
      effectPossible = true;
      const first = dropFirstReply ? await this.fixtures.create(scope, operationId) : null;
      const operation = await this.fixtures.create(scope, operationId);
      if (first && (first.id !== operation.id || first.bindingId !== operation.bindingId)) {
        deny("lost create reply replay allocated another fixture");
      }
      if (operation.state !== "SUCCEEDED" || operation.kind !== "CREATE") deny("fixture create is not verified");
      const handle = { sandboxId: operation.bindingId, operationId };
      await this.owned(handle, false);
      await this.assertDurableState(handle, scope, "STOPPED");
      return handle;
    } catch (error) {
      if (effectPossible) {
        try {
          const cleanup = await this.fixtures.destroy(scope, operationId);
          if (cleanup.state !== "SUCCEEDED") deny("failed create cleanup is not verified");
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Incus live create and cleanup are unverified");
        }
      }
      throw error;
    }
  }

  async inspectFixture(handle: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["inspectFixture"]> {
    const { scope, selected, binding } = await this.owned(handle, false, true);
    const approved = await this.context(scope, selected.preset);
    const observed = await this.backend.instance(approved.context, handle.sandboxId);
    const expected = binding.observedState === "RUNNING" ? "running"
      : binding.observedState === "STOPPED" ? "stopped"
        : binding.observedState === "ABSENT" ? "absent" : "unknown";
    if (observed.state !== expected) deny("backend and durable fixture state disagree");
    if (observed.state === "absent") return { sandboxId: handle.sandboxId, state: "absent" } as LiveFixtureInspection;
    if (observed.imageDigest !== selected.preset.imageDigest || observed.profile !== selected.preset.profile
      || !observed.memoryBytes || !observed.cpuMillis || !observed.pids || !observed.diskBytes
      || !observed.storageDriver || observed.privateNetwork !== true
      || observed.restrictedProject !== true || observed.unprivileged !== true) {
      deny("backend fixture resource or isolation readback changed");
    }
    let bootId: string | null = null;
    if (observed.state === "running") {
      const guest = await this.run(handle,
        ["sh", "-c", "id -un; pwd; cat /proc/sys/kernel/random/boot_id"], 30_000);
      const [user, workspace, boot, ...extra] = guest.stdout.trim().split("\n");
      if (guest.exitCode !== 0 || user !== selected.connection.configuration.guestUser
        || workspace !== "/workspace" || !/^[a-f0-9-]{36}$/.test(boot ?? "") || extra.length) {
        deny("guest user, workspace, or boot identity is unavailable");
      }
      bootId = boot!;
    }
    return { sandboxId: handle.sandboxId, state: observed.state,
      imageDigest: observed.imageDigest, helperDigest: approved.helperDigest,
      profile: observed.profile, workspaceRoot: "/workspace", guestUser: selected.connection.configuration.guestUser,
      memoryBytes: observed.memoryBytes, cpuMillis: observed.cpuMillis, pids: observed.pids,
      diskBytes: observed.diskBytes, storageDriver: observed.storageDriver,
      privateNetwork: observed.privateNetwork, restrictedProject: observed.restrictedProject,
      unprivileged: observed.unprivileged, bootId };
  }

  async observeEnforcement(handle: LiveFixtureHandle,
    neighbor: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["observeEnforcement"]> {
    if (!this.resourceNetwork) deny("host-owned sandbox network control targets are unavailable");
    if (handle.sandboxId === neighbor.sandboxId || handle.operationId === neighbor.operationId) {
      deny("resource probe needs two distinct fixtures");
    }
    const [primaryOwned, neighborOwned] = await Promise.all([
      this.owned(handle, true), this.owned(neighbor, true),
    ]);
    if (primaryOwned.scope.installationId !== neighborOwned.scope.installationId
      || primaryOwned.scope.releaseId !== neighborOwned.scope.releaseId
      || primaryOwned.scope.connectionId !== neighborOwned.scope.connectionId
      || primaryOwned.scope.presetId !== neighborOwned.scope.presetId) {
      deny("resource probe fixtures have different reviewed scopes");
    }
    const { context } = await this.context(primaryOwned.scope, primaryOwned.selected.preset);
    const [primary, adjacent, neighborTarget] = await Promise.all([
      this.backend.instance(context, handle.sandboxId),
      this.backend.instance(context, neighbor.sandboxId),
      this.resourceNetwork.neighborTarget(context, neighbor),
    ]);
    if (primary.state !== "running" || adjacent.state !== "running"
      || primary.privateNetwork !== true || adjacent.privateNetwork !== true
      || primary.diskBytes === undefined || neighborTarget.sandboxId !== neighbor.sandboxId) {
      deny("running fixture, root quota, or neighbor network identity changed");
    }
    const endpoint = new URL(primaryOwned.selected.connection.endpoint);
    const management = { address: endpoint.hostname.replace(/^\[|\]$/g, ""),
      port: Number(endpoint.port || 443) };
    return observeIncusResourceEnforcement(handle, primaryOwned.selected.preset,
      { management, otherSandbox: neighborTarget }, {
        runGuest: (fixture, argv, timeoutMs) => this.run(fixture, argv, timeoutMs),
        readRootQuota: async () => ({ sandboxId: handle.sandboxId, bytes: primary.diskBytes! }),
        hostCanConnect: target => this.resourceNetwork!.hostCanConnect(target),
      });
  }

  async exerciseLimits(_handle: LiveFixtureHandle,
    _neighbor: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["exerciseLimits"]> {
    return deny("controlled limit and neighbor load probes are not implemented");
  }

  async setPower(handle: LiveFixtureHandle, state: "running" | "stopped"): Promise<void> {
    const { scope } = await this.owned(handle, false);
    const operation = await this.fixtures.setPower(scope, handle.operationId, state,
      `qual-power-${randomUUID()}`);
    if (operation.state !== "SUCCEEDED" || operation.bindingId !== handle.sandboxId
      || operation.kind !== (state === "running" ? "START" : "STOP")) {
      deny("fixture power change is not verified");
    }
    await this.assertDurableState(handle, scope, state === "running" ? "RUNNING" : "STOPPED");
  }

  async writeFile(handle: LiveFixtureHandle, path: string, bytes: Uint8Array): Promise<void> {
    safePath(path);
    if (bytes.length > MAX_FILE_BYTES) deny("file exceeds one verified guest write");
    const result = await this.guest(handle, "files.writeAtomic", { path, expectedRevision: null,
      dataBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.length, executable: false });
    if (result.path !== path || result.sizeBytes !== bytes.length) deny("guest file write readback changed");
  }

  async readFile(handle: LiveFixtureHandle, path: string): Promise<Uint8Array> {
    safePath(path);
    const stat = await this.guest(handle, "files.stat", { path });
    const file = stat.file as Record<string, unknown> | undefined;
    if (file?.path !== path || file.kind !== "file" || typeof file.revision !== "string"
      || !Number.isSafeInteger(file.sizeBytes) || Number(file.sizeBytes) > MAX_FILE_BYTES) deny("guest file stat changed");
    const read = await this.guest(handle, "files.readRange", { path, revision: file.revision,
      offsetBytes: 0, lengthBytes: Math.max(1, Number(file.sizeBytes)) });
    const bytes = Buffer.from(String(read.dataBase64), "base64");
    if (read.path !== path || read.revision !== file.revision || read.offsetBytes !== 0
      || read.byteLength !== bytes.length || bytes.length !== file.sizeBytes || read.eof !== true) {
      deny("guest file readback changed");
    }
    return bytes;
  }

  async run(handle: LiveFixtureHandle, argv: readonly string[], timeoutMs: number): ReturnType<HostIncusLiveWitness["run"]> {
    if (!argv.length || argv.some(arg => typeof arg !== "string") || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > 120_000) deny("invalid guest process request");
    const deadline = this.now() + timeoutMs;
    const start = await this.guest(handle, "processes.start", { argv: [...argv], cwd: ".",
      env: [], processDeadlineMs: deadline });
    if (typeof start.processId !== "string" || typeof start.bootId !== "string") deny("guest process identity missing");
    let offset = 0;
    let stdout = "";
    let stderr = "";
    let terminalExitCode: number | null = null;
    while (this.now() < deadline) {
      const output = await this.guest(handle, "processes.readOutput", { processId: start.processId,
        bootId: start.bootId, cursor: { sandboxId: handle.sandboxId, processId: start.processId,
          bootId: start.bootId, offsetBytes: offset }, maxBytes: MAX_FILE_BYTES });
      if (output.gap || !Array.isArray(output.chunks)) deny("guest process output has a gap");
      for (const chunk of output.chunks as Record<string, unknown>[]) {
        const bytes = Buffer.from(String(chunk.dataBase64), "base64");
        if (chunk.offsetBytes !== offset || chunk.byteLength !== bytes.length) deny("guest process output changed");
        if (chunk.stream === "stdout") stdout += bytes.toString();
        else if (chunk.stream === "stderr") stderr += bytes.toString();
        else deny("guest process stream changed");
        offset += bytes.length;
      }
      const next = output.nextCursor as Record<string, unknown> | undefined;
      if (next?.offsetBytes !== offset || offset > MAX_FILE_BYTES) deny("guest process output exceeded bound");
      const inspected = await this.guest(handle, "processes.inspect", { processId: start.processId, bootId: start.bootId });
      const process = inspected.process as Record<string, unknown> | undefined;
      if (process?.processId !== start.processId || process.sandboxId !== handle.sandboxId
        || process.bootId !== start.bootId) deny("guest process identity changed");
      if (["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(String(process.state))) {
        if (!Number.isSafeInteger(process.exitCode)) deny("guest process exit is unavailable");
        terminalExitCode = Number(process.exitCode);
      }
      if (terminalExitCode !== null && output.eof === true) return { exitCode: terminalExitCode, stdout, stderr };
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    return deny("guest process deadline expired");
  }

  async restartController(_handle: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["restartController"]> {
    return deny("host controller process restart and durable reconnect is not implemented");
  }

  async exerciseFailedCleanupRecovery(_handle: LiveFixtureHandle,
    _unrelated: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["exerciseFailedCleanupRecovery"]> {
    return deny("failed cleanup fault and readiness denial probe is not implemented");
  }

  async destroyFixture(handle: LiveFixtureHandle): Promise<void> {
    const { scope } = await this.persistedOwned(handle, false, true);
    const operation = await this.fixtures.destroy(scope, handle.operationId);
    if (operation.state !== "SUCCEEDED" || operation.kind !== "DESTROY" || operation.bindingId !== handle.sandboxId) {
      deny("fixture destroy is not verified");
    }
    await this.assertDurableState(handle, scope, "ABSENT");
  }
}
