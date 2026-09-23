import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { sandboxPresetDigest, validateSandboxProviderMethodExchange,
  type SandboxPreset, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import { getDb, type Database } from "../db/connection";
import { incusQualificationFixtures, sandboxBindings } from "../db/schema";
import { getReleaseRuntime, ReleaseProcess, resolveActiveRelease } from "../extensions/release-process";
import { IncusQualificationFixtureService, IncusQualificationStore, type IncusQualificationScope } from "./incus-qualification";
import type { HostIncusLiveWitness, LiveFixtureHandle } from "./incus-live-cases";
import { ProviderConnectionStore } from "./provider-connections/store";

const MAX_FILE_BYTES = 64 * 1024;
const POLL_MS = 100;
const guestOperations = new Set<SandboxProtocolOperation>([
  "files.stat", "files.readRange", "files.writeAtomic", "processes.start", "processes.inspect", "processes.readOutput",
]);

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

export interface IncusHostLiveWitnessDependencies {
  db?: Database;
  qualifications?: IncusQualificationStore;
  fixtures?: IncusQualificationFixtureService;
  /** Replace only with a test seam that performs the same protected release call. */
  invokeGuest?: (installationId: string, bindingId: string, operation: SandboxProtocolOperation,
    input: Record<string, unknown>) => Promise<unknown>;
  now?: () => number;
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
  private readonly now: () => number;

  constructor(deps: IncusHostLiveWitnessDependencies = {}) {
    this.db = deps.db ?? getDb();
    this.qualifications = deps.qualifications ?? new IncusQualificationStore({ db: this.db });
    this.fixtures = deps.fixtures ?? new IncusQualificationFixtureService({ db: this.db,
      qualifications: this.qualifications });
    this.invokeGuest = deps.invokeGuest ?? invokeRelease;
    this.now = deps.now ?? Date.now;
  }

  private async owned(handle: LiveFixtureHandle, requireRunning: boolean) {
    const [fixture] = await this.db.select().from(incusQualificationFixtures)
      .where(eq(incusQualificationFixtures.operationId, handle.operationId)).limit(1);
    if (!fixture || fixture.bindingId !== handle.sandboxId) deny("fixture identity changed");
    const [binding] = await this.db.select().from(sandboxBindings)
      .where(eq(sandboxBindings.id, fixture.bindingId)).limit(1);
    if (!binding || binding.projectId !== fixture.projectId || binding.resourceKey !== fixture.bindingId
      || binding.providerInstallationId !== fixture.installationId || binding.providerReleaseId !== fixture.releaseId
      || binding.connectionId !== fixture.connectionId || binding.connectionRevision !== fixture.connectionRevision
      || binding.presetId !== fixture.presetId || binding.presetDigest !== fixture.presetDigest
      || binding.effectiveSettingsDigest !== fixture.effectiveSettingsDigest || binding.tombstonedAt
      || requireRunning && (binding.desiredState !== "RUNNING" || binding.observedState !== "RUNNING")) {
      deny("fixture binding changed or is not running");
    }
    const scope: IncusQualificationScope = { installationId: fixture.installationId, releaseId: fixture.releaseId,
      connectionId: fixture.connectionId, presetId: fixture.presetId };
    const selected = await this.qualifications.authorizeFixture(scope);
    if (selected.connection.revision !== fixture.connectionRevision || selected.presetDigest !== fixture.presetDigest
      || selected.effectiveSettingsDigest !== fixture.effectiveSettingsDigest) deny("reviewed fixture settings changed");
    return { fixture, binding, scope, selected };
  }

  private async guest(handle: LiveFixtureHandle, operation: SandboxProtocolOperation,
    payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!guestOperations.has(operation)) deny("guest operation is not approved for a witness");
    const { fixture, binding } = await this.owned(handle, true);
    const active = await resolveActiveRelease(fixture.installationId, getReleaseRuntime());
    if (active.installation.id !== fixture.installationId || active.release.id !== fixture.releaseId
      || active.installation.activeReleaseId !== fixture.releaseId) deny("active release changed");
    const connection = await new ProviderConnectionStore(this.db).resolveForHost({
      connectionId: fixture.connectionId, providerInstallationId: fixture.installationId,
      providerReleaseId: fixture.releaseId, revision: fixture.connectionRevision,
    });
    if (connection.id !== fixture.connectionId || connection.revision !== fixture.connectionRevision
      || connection.revokedAt || connection.configuration.kind !== "incus") deny("connection changed");
    const now = this.now();
    const input: Record<string, unknown> = { ...payload, providerId: "incus", connectionId: fixture.connectionId,
      sandboxId: fixture.bindingId, rpcDeadlineMs: now + 30_000 };
    if (operation === "processes.start") {
      input.user = connection.configuration.guestUser;
      input.processDeadlineMs = Math.min(now + 120_000, Number(payload.processDeadlineMs));
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

  async observe(_scope: IncusQualificationScope, _preset: SandboxPreset): ReturnType<HostIncusLiveWitness["observe"]> {
    return deny("backend image and helper readback is not implemented");
  }

  async controlFacts(_scope: IncusQualificationScope, _preset: SandboxPreset): ReturnType<HostIncusLiveWitness["controlFacts"]> {
    return deny("denied admissions and local canary probe are not implemented");
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

  async inspectFixture(_handle: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["inspectFixture"]> {
    return deny("backend resource and guest identity readback is not implemented");
  }

  async observeEnforcement(_handle: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["observeEnforcement"]> {
    return deny("guest cgroup, network, and Incus disk quota readback is not implemented");
  }

  async exerciseLimits(_handle: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["exerciseLimits"]> {
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
    const start = await this.guest(handle, "processes.start", { argv: [...argv], cwd: "/workspace",
      env: [], processDeadlineMs: deadline });
    if (typeof start.processId !== "string" || typeof start.bootId !== "string") deny("guest process identity missing");
    let offset = 0;
    let stdout = "";
    let stderr = "";
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
      if (next?.offsetBytes !== offset || stdout.length + stderr.length > MAX_FILE_BYTES) deny("guest process output exceeded bound");
      const inspected = await this.guest(handle, "processes.inspect", { processId: start.processId, bootId: start.bootId });
      const process = inspected.process as Record<string, unknown> | undefined;
      if (process?.processId !== start.processId || process.sandboxId !== handle.sandboxId
        || process.bootId !== start.bootId) deny("guest process identity changed");
      if (["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(String(process.state))) {
        if (output.eof !== true || !Number.isSafeInteger(process.exitCode)) deny("guest process output is incomplete");
        return { exitCode: Number(process.exitCode), stdout, stderr };
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    return deny("guest process deadline expired");
  }

  async restartController(): ReturnType<HostIncusLiveWitness["restartController"]> {
    return deny("host controller process restart and durable reconnect is not implemented");
  }

  async exerciseFailedCleanupRecovery(_handle: LiveFixtureHandle,
    _unrelated: LiveFixtureHandle): ReturnType<HostIncusLiveWitness["exerciseFailedCleanupRecovery"]> {
    return deny("failed cleanup fault and readiness denial probe is not implemented");
  }

  async destroyFixture(handle: LiveFixtureHandle): Promise<void> {
    const { scope } = await this.owned(handle, false);
    const operation = await this.fixtures.destroy(scope, handle.operationId);
    if (operation.state !== "SUCCEEDED" || operation.kind !== "DESTROY" || operation.bindingId !== handle.sandboxId) {
      deny("fixture destroy is not verified");
    }
    await this.assertDurableState(handle, scope, "ABSENT");
  }
}
