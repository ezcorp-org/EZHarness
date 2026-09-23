import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  sandboxPresetDigest,
  validateSandboxProviderMethodExchange,
  type LiveSandboxPresetQualification,
  type SandboxPreset,
} from "@ezcorp/extension-contract";
import { getDb, type Database } from "../db/connection";
import { sandboxBindings, sandboxOperations, sandboxReservations, type SandboxBinding, type SandboxOperation } from "../db/schema";
import { getReleaseRuntime, ReleaseProcess, resolveActiveRelease, type ActiveExtensionRelease } from "../extensions/release-process";
import { assertSandboxPresetReady } from "../extensions/v4/sandbox-preset-qualification";
import { SandboxAdmissionStore, type SandboxResourceVector } from "../sandboxes/admission";
import { SandboxController } from "../sandboxes/controller";
import { IncusSandboxProviderDispatcher } from "../sandboxes/incus-dispatcher";
import { IncusMethodCaller } from "./incus-method-caller";
import { callRetiredIncusCleanup } from "./incus-retired-cleanup";
import { ProviderConnectionStore, type ProviderConnectionCredentials, type ProviderConnectionScope } from "./provider-connections/store";
import { digest as setupDigest } from "../../scripts/incus/model";

export interface IncusFeatureServiceDependencies {
  db?: Database;
  controller?: SandboxController;
  admission?: SandboxAdmissionStore;
  activeRelease?: (installationId: string) => Promise<ActiveExtensionRelease>;
  resolveConnection?: (scope: ProviderConnectionScope) => Promise<ProviderConnectionCredentials>;
  connectionRevision?: (connectionId: string) => Promise<number | null>;
  /** Must read host-produced SP01–SP08 evidence; absent evidence denies provisioning. */
  loadQualification: (scope: { installationId: string; releaseId: string; connectionId: string; presetId: string }) => Promise<LiveSandboxPresetQualification | null>;
  inspect?: (installationId: string, bindingId: string, input: Record<string, unknown>) => Promise<unknown>;
  retiredCleanup?: typeof callRetiredIncusCleanup;
  now?: () => number;
  assertReady?: typeof assertSandboxPresetReady;
}

export interface PrepareIncusFeatureInput {
  projectId: string;
  installationId: string;
  connectionId: string;
  presetId: string;
}

export interface IncusFeatureRequest {
  bindingId: string;
  idempotencyScope: string;
  idempotencyKey: string;
}

export type IncusFeatureEffect =
  | { state: "QUEUED" | "REJECTED"; reason: string | null; operation: null }
  | { state: "DISPATCHED"; operation: SandboxOperation };

async function inspectRelease(installationId: string, bindingId: string, input: Record<string, unknown>): Promise<unknown> {
  const process = new ReleaseProcess(installationId);
  try {
    const response = await process.callIncusSandboxOperation(bindingId, "lifecycle.inspect", input);
    return response.result;
  } finally {
    process.kill();
    await process.whenCallsSettled();
  }
}

function resources(preset: SandboxPreset): SandboxResourceVector {
  return {
    memoryBytes: preset.limits.memoryBytes,
    cpuMillicores: preset.limits.cpuMillis,
    pids: preset.limits.pids,
    diskBytes: preset.limits.diskBytes,
    executionSlots: 1,
  };
}

function intentId(kind: string, request: IncusFeatureRequest): string {
  return `incus-${kind.toLowerCase()}-${createHash("sha256")
    .update(JSON.stringify([request.bindingId, request.idempotencyScope, request.idempotencyKey]))
    .digest("hex")}`;
}

export class IncusFeatureService {
  private readonly db: Database;
  private readonly controller: SandboxController;
  private readonly admission: SandboxAdmissionStore;
  private readonly activeRelease: NonNullable<IncusFeatureServiceDependencies["activeRelease"]>;
  private readonly resolveConnection: NonNullable<IncusFeatureServiceDependencies["resolveConnection"]>;
  private readonly connectionRevision: NonNullable<IncusFeatureServiceDependencies["connectionRevision"]>;
  private readonly inspect: NonNullable<IncusFeatureServiceDependencies["inspect"]>;
  private readonly retiredCleanup: typeof callRetiredIncusCleanup;
  private readonly now: () => number;
  private readonly assertReady: typeof assertSandboxPresetReady;

  constructor(private readonly deps: IncusFeatureServiceDependencies) {
    this.db = deps.db ?? getDb();
    this.controller = deps.controller ?? new SandboxController(this.db, new IncusSandboxProviderDispatcher(new IncusMethodCaller()));
    this.admission = deps.admission ?? new SandboxAdmissionStore(this.db);
    this.activeRelease = deps.activeRelease ?? (id => resolveActiveRelease(id, getReleaseRuntime()));
    this.resolveConnection = deps.resolveConnection ?? (scope => new ProviderConnectionStore(this.db).resolveForHost(scope));
    this.connectionRevision = deps.connectionRevision ?? (async id => (await new ProviderConnectionStore(this.db).getMetadata(id))?.revision ?? null);
    this.inspect = deps.inspect ?? inspectRelease;
    this.retiredCleanup = deps.retiredCleanup ?? callRetiredIncusCleanup;
    this.now = deps.now ?? Date.now;
    this.assertReady = deps.assertReady ?? assertSandboxPresetReady;
  }

  private async approved(input: PrepareIncusFeatureInput, expected?: SandboxBinding, requireQualification = true): Promise<{
    snapshot: ActiveExtensionRelease; connection: ProviderConnectionCredentials; preset: SandboxPreset;
    qualification: LiveSandboxPresetQualification | null; presetDigest: string; effectiveSettingsDigest: string;
  }> {
    const snapshot = await this.activeRelease(input.installationId);
    if (snapshot.installation.id !== input.installationId || snapshot.release.id !== snapshot.installation.activeReleaseId
      || expected && snapshot.release.id !== expected.providerReleaseId) {
      throw new Error("Approved Incus release is unavailable");
    }
    const provider = snapshot.release.manifest.sandboxProviders?.find(item => item.id === "incus" && item.kind === "sandbox");
    const preset = provider?.presets.find(item => item.id === input.presetId);
    if (!provider || !preset || provider.protocolMajor !== 1
      || !snapshot.release.manifest.methods?.some(item => item.name === "incus/lifecycle/create")) {
      throw new Error("Approved Incus preset is unavailable");
    }
    const revision = expected?.connectionRevision ?? await this.connectionRevision(input.connectionId);
    if (!revision || !Number.isSafeInteger(revision)) throw new Error("Approved Incus connection is unavailable");
    const connection = await this.resolveConnection({ connectionId: input.connectionId,
      providerInstallationId: input.installationId, providerReleaseId: snapshot.release.id, revision });
    if (connection.id !== input.connectionId || connection.revision !== revision || connection.revokedAt
      || connection.providerInstallationId !== input.installationId || connection.providerReleaseId !== snapshot.release.id
      || connection.configuration.kind !== "incus") {
      throw new Error("Approved Incus connection changed");
    }
    const digest = await sandboxPresetDigest(preset);
    const effectiveSettingsDigest = setupDigest({ presetDigest: digest, connectionRevision: revision });
    let qualification: LiveSandboxPresetQualification | null = null;
    if (requireQualification) {
      qualification = await this.deps.loadQualification({
        installationId: input.installationId, releaseId: snapshot.release.id,
        connectionId: input.connectionId, presetId: input.presetId,
      });
      if (!qualification) throw new Error("Live Incus preset qualification is unavailable");
      if (qualification.effectiveSettingsDigest !== effectiveSettingsDigest) {
        throw new Error("Live Incus preset qualification changed settings");
      }
      await this.assertReady(snapshot.release, qualification, { providerId: "incus", presetId: input.presetId,
        connectionId: input.connectionId, effectiveSettingsDigest,
        now: this.now() });
    }
    if (expected && (expected.profile !== preset.profile || expected.presetId !== preset.id
      || expected.presetDigest !== digest || expected.effectiveSettingsDigest !== effectiveSettingsDigest
      || expected.connectionId !== input.connectionId || expected.providerInstallationId !== input.installationId)) {
      throw new Error("Incus feature binding changed");
    }
    return { snapshot, connection, preset, qualification, presetDigest: digest, effectiveSettingsDigest };
  }

  async prepare(input: PrepareIncusFeatureInput): Promise<SandboxBinding> {
    const [existing] = await this.db.select().from(sandboxBindings)
      .where(eq(sandboxBindings.projectId, input.projectId)).limit(1);
    const approved = await this.approved(input, existing);
    if (existing) {
      if (existing.tombstonedAt || !existing.connectionRevision || existing.resourceKey !== existing.id) {
        throw new Error("Incus feature binding is unavailable");
      }
      return existing;
    }
    if (!approved.qualification) throw new Error("Live Incus preset qualification is unavailable");
    const id = randomUUID();
    return this.controller.createBinding({
      id, projectId: input.projectId, providerInstallationId: input.installationId,
      providerReleaseId: approved.snapshot.release.id, connectionId: input.connectionId,
      connectionRevision: approved.connection.revision, resourceKey: id,
      profile: approved.preset.profile, presetId: approved.preset.id,
      presetDigest: approved.presetDigest,
      effectiveSettingsDigest: approved.effectiveSettingsDigest,
      desiredState: "STOPPED", observedState: "UNKNOWN",
    });
  }

  private async readyBinding(id: string, requireQualification = true): Promise<{ binding: SandboxBinding; preset: SandboxPreset }> {
    const binding = await this.controller.getBinding(id);
    if (!binding?.connectionRevision || !binding.presetId || !binding.resourceKey
      || binding.resourceKey !== binding.id || binding.tombstonedAt) {
      throw new Error("Incus feature binding is unavailable");
    }
    const approved = await this.approved({ projectId: binding.projectId,
      installationId: binding.providerInstallationId, connectionId: binding.connectionId,
      presetId: binding.presetId }, binding, requireQualification);
    return { binding, preset: approved.preset };
  }

  private async existing(request: IncusFeatureRequest, kind: SandboxOperation["kind"]): Promise<SandboxOperation | null> {
    const [operation] = await this.db.select().from(sandboxOperations).where(and(
      eq(sandboxOperations.bindingId, request.bindingId),
      eq(sandboxOperations.idempotencyScope, request.idempotencyScope),
      eq(sandboxOperations.idempotencyKey, request.idempotencyKey),
    )).limit(1);
    if (operation && operation.kind !== kind) throw new Error("Incus lifecycle idempotency key changed kind");
    return operation ?? null;
  }

  private async providerGeneration(binding: SandboxBinding, requiredState?: "running" | "stopped"): Promise<number> {
    const input = { providerId: "incus", connectionId: binding.connectionId,
      sandboxId: binding.id, rpcDeadlineMs: this.now() + 30_000 };
    const result = validateSandboxProviderMethodExchange("lifecycle.inspect", input,
      await this.inspect(binding.providerInstallationId, binding.id, input)).result as Record<string, unknown>;
    if (result.ok !== true) throw new Error("Incus sandbox state is unavailable");
    const sandbox = result.sandbox as { generation: number; observedState: string };
    if (!Number.isSafeInteger(sandbox.generation) || sandbox.generation < 1
      || !["running", "stopped"].includes(sandbox.observedState)
      || requiredState && sandbox.observedState !== requiredState) {
      throw new Error("Incus sandbox generation is unavailable");
    }
    return sandbox.generation;
  }

  async create(request: IncusFeatureRequest): Promise<IncusFeatureEffect> {
    const replay = await this.existing(request, "CREATE");
    if (replay) return { state: "DISPATCHED", operation: replay };
    const { binding, preset } = await this.readyBinding(request.bindingId);
    const admission = await this.admission.requestAdmission({ ...request, kind: "CREATE",
      generation: binding.generation, resources: resources(preset) });
    if (admission.state !== "ADMITTED") return { state: admission.state, reason: admission.reason, operation: null };
    const operation = await this.controller.requestAndDispatch({ ...request, kind: "CREATE",
      generation: binding.generation,
      payload: { profile: binding.profile, presetId: binding.presetId,
        presetDigest: binding.presetDigest, effectiveSettingsDigest: binding.effectiveSettingsDigest } });
    await this.settle(operation);
    return { state: "DISPATCHED", operation };
  }

  async start(request: IncusFeatureRequest): Promise<IncusFeatureEffect> {
    const replay = await this.existing(request, "START");
    if (replay) return { state: "DISPATCHED", operation: replay };
    const { binding, preset } = await this.readyBinding(request.bindingId);
    const expectedGeneration = await this.providerGeneration(binding, "stopped");
    const admission = await this.admission.requestAdmission({ ...request, kind: "START",
      generation: binding.generation, resources: resources(preset) });
    if (admission.state !== "ADMITTED") return { state: admission.state, reason: admission.reason, operation: null };
    const operation = await this.controller.requestAndDispatch({ ...request, kind: "START",
      generation: binding.generation, payload: { expectedGeneration } });
    return { state: "DISPATCHED", operation };
  }

  async stop(request: IncusFeatureRequest): Promise<SandboxOperation> {
    const replay = await this.existing(request, "STOP");
    if (replay) return replay;
    const { binding } = await this.readyBinding(request.bindingId, false);
    const expectedGeneration = await this.providerGeneration(binding, "running");
    await this.admission.markStopIntent(binding.id, binding.generation, intentId("STOP", request));
    const operation = await this.controller.requestAndDispatch({ ...request, kind: "STOP",
      generation: binding.generation, payload: { expectedGeneration } });
    await this.settle(operation);
    return operation;
  }

  async destroy(request: IncusFeatureRequest): Promise<SandboxOperation> {
    const replay = await this.existing(request, "DESTROY");
    if (replay) return replay;
    const { binding } = await this.readyBinding(request.bindingId, false);
    const expectedGeneration = await this.providerGeneration(binding);
    await this.admission.markCleanupIntent(binding.id, binding.generation, intentId("DESTROY", request));
    const operation = await this.controller.requestAndDispatch({ ...request, kind: "DESTROY",
      generation: binding.generation, payload: { expectedGeneration } });
    await this.settle(operation);
    return operation;
  }

  /** Explicit host cleanup of a stopped guest after its approved release retires. */
  async destroyRetired(request: IncusFeatureRequest): Promise<SandboxOperation> {
    const replay = await this.existing(request, "DESTROY");
    if (replay) return replay;
    const binding = await this.controller.getBinding(request.bindingId);
    if (!binding || binding.tombstonedAt || binding.resourceKey !== binding.id
      || !binding.connectionRevision || !binding.presetId || binding.observedState !== "STOPPED") {
      throw new Error("Retired Incus binding is unavailable");
    }
    const input = { providerId: "incus", connectionId: binding.connectionId,
      sandboxId: binding.id, rpcDeadlineMs: this.now() + 30_000 };
    const observed = validateSandboxProviderMethodExchange("lifecycle.inspect", input,
      await this.retiredCleanup(this.db, binding, "lifecycle.inspect", input)).result as Record<string, unknown>;
    const sandbox = observed.sandbox as Record<string, unknown> | undefined;
    if (observed.ok !== true || !sandbox || sandbox.sandboxId !== binding.id
      || sandbox.profile !== binding.profile || sandbox.presetId !== binding.presetId
      || sandbox.observedState !== "stopped" || !Number.isSafeInteger(sandbox.generation)
      || (sandbox.generation as number) < 1) {
      throw new Error("Retired Incus sandbox generation is unavailable");
    }
    await this.admission.markCleanupIntent(binding.id, binding.generation, intentId("DESTROY", request));
    const operation = await this.controller.requestAndDispatch({ ...request, kind: "DESTROY",
      generation: binding.generation, payload: { expectedGeneration: sandbox.generation } });
    await this.settle(operation);
    return operation;
  }

  private async settle(operation: SandboxOperation): Promise<void> {
    if (operation.state !== "SUCCEEDED") return;
    const binding = await this.controller.getBinding(operation.bindingId);
    if (!binding || binding.generation !== operation.generation || binding.currentOperationId !== operation.id) return;
    const request = { bindingId: binding.id, idempotencyScope: operation.idempotencyScope,
      idempotencyKey: operation.idempotencyKey };
    if (operation.kind === "CREATE" && binding.observedState === "STOPPED") {
      const id = intentId("CREATE", request);
      await this.admission.markStopIntent(binding.id, binding.generation, id);
      await this.admission.recordObservedState(binding.id, binding.generation, "STOPPED", id);
    } else if (operation.kind === "STOP" && binding.observedState === "STOPPED") {
      await this.admission.recordObservedState(binding.id, binding.generation, "STOPPED", intentId("STOP", request));
    } else if (operation.kind === "DESTROY" && binding.observedState === "ABSENT") {
      await this.admission.recordObservedState(binding.id, binding.generation, "ABSENT", intentId("DESTROY", request));
    }
  }

  async reconcile(limit?: number): Promise<ReturnType<SandboxController["reconcile"]> extends Promise<infer T> ? T : never> {
    const result = await this.controller.reconcile(limit);
    const requested = limit === undefined || !Number.isFinite(limit) ? 100 : Math.trunc(limit);
    const settlementLimit = Math.min(Math.max(1, requested), 100);
    const completed = await this.db.select({ operation: sandboxOperations }).from(sandboxOperations)
      .innerJoin(sandboxBindings, eq(sandboxBindings.currentOperationId, sandboxOperations.id))
      .innerJoin(sandboxReservations, eq(sandboxReservations.bindingId, sandboxBindings.id))
      .where(and(eq(sandboxOperations.state, "SUCCEEDED"),
        eq(sandboxOperations.generation, sandboxBindings.generation),
        eq(sandboxReservations.generation, sandboxBindings.generation),
        or(
          and(inArray(sandboxOperations.kind, ["CREATE", "STOP"]),
            eq(sandboxBindings.observedState, "STOPPED"), ne(sandboxReservations.computeState, "RELEASED")),
          and(eq(sandboxOperations.kind, "DESTROY"),
            eq(sandboxBindings.observedState, "ABSENT"), ne(sandboxReservations.diskState, "RELEASED")),
        )))
      .orderBy(sql`${sandboxOperations.reconcileOrder} ASC NULLS FIRST`,
        asc(sandboxOperations.createdAt), asc(sandboxOperations.id))
      .limit(settlementLimit);
    const failures: unknown[] = [];
    for (const { operation } of completed) {
      try {
        await this.settle(operation);
      } catch (error) {
        // A bad row must not block later settlements on every poll.
        await this.db.update(sandboxOperations).set({
          reconcileOrder: sql`nextval('sandbox_reconcile_order_seq')`,
        }).where(eq(sandboxOperations.id, operation.id));
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Incus reservation settlement failed");
    return result;
  }
}
