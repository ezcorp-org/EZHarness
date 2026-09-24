import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  sandboxPresetDigest,
  validateSandboxProviderMethodExchange,
  type LiveSandboxPresetQualification,
  type SandboxPreset,
} from "@ezcorp/extension-contract";
import { getDb, type Database, type DbTransaction } from "../db/connection";
import { incusQualificationFixtures, projects, sandboxBindings, sandboxOperations, sandboxReservations, type SandboxBinding, type SandboxOperation } from "../db/schema";
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
  assertCurrentScope?: ProviderConnectionStore["assertCurrentScope"];
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

export class IncusQualificationCleanupError extends Error {
  readonly code = "QUALIFICATION_CLEANUP_UNVERIFIED";

  constructor() {
    super("Incus qualification fixture cleanup is unverified");
  }
}

export async function inspectRelease(installationId: string, bindingId: string, input: Record<string, unknown>): Promise<unknown> {
  const process = new ReleaseProcess(installationId);
  try {
    const response = await process.callIncusSandboxOperation(bindingId, "lifecycle.inspect", input);
    return response.result;
  } finally {
    process.kill();
    await process.whenCallsSettled();
  }
}

export async function readIncusProviderGeneration(binding: SandboxBinding,
  inspect: NonNullable<IncusFeatureServiceDependencies["inspect"]>, now: () => number,
  requiredState?: "running" | "stopped"): Promise<number> {
  const input = { providerId: "incus", connectionId: binding.connectionId,
    sandboxId: binding.id, rpcDeadlineMs: now() + 30_000 };
  const result = validateSandboxProviderMethodExchange("lifecycle.inspect", input,
    await inspect(binding.providerInstallationId, binding.id, input)).result as Record<string, unknown>;
  if (result.ok !== true) throw new Error("Incus sandbox state is unavailable");
  const sandbox = result.sandbox as { generation: number; observedState: string };
  if (!Number.isSafeInteger(sandbox.generation) || sandbox.generation < 1
    || !["running", "stopped"].includes(sandbox.observedState)
    || requiredState && sandbox.observedState !== requiredState) {
    throw new Error("Incus sandbox generation is unavailable");
  }
  return sandbox.generation;
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

type QualificationFixture = typeof incusQualificationFixtures.$inferSelect;

function fixtureMatchesBinding(fixture: QualificationFixture, binding: SandboxBinding): boolean {
  return binding.id === fixture.bindingId && binding.projectId === fixture.projectId
    && binding.resourceKey === fixture.bindingId
    && binding.providerInstallationId === fixture.installationId
    && binding.providerReleaseId === fixture.releaseId && binding.connectionId === fixture.connectionId
    && binding.connectionRevision === fixture.connectionRevision && binding.presetId === fixture.presetId
    && binding.presetDigest === fixture.presetDigest
    && binding.effectiveSettingsDigest === fixture.effectiveSettingsDigest;
}

function qualificationDestroyIntent(operationId: string): string {
  return `incus-qualification-destroy-${operationId}`;
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
  private readonly assertCurrentScope: ProviderConnectionStore["assertCurrentScope"];

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
    this.assertCurrentScope = deps.assertCurrentScope ?? ((scope, transaction) =>
      new ProviderConnectionStore(this.db).assertCurrentScope(scope, transaction));
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
    if (requireQualification) {
      await this.assertFixtureCleanupVerified({ installationId: input.installationId,
        releaseId: snapshot.release.id, connectionId: input.connectionId, connectionRevision: revision,
        presetId: input.presetId, presetDigest: digest, effectiveSettingsDigest });
    }
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

  /** A fixture destroy is cleared only by the original journaled operation,
   * provider-confirmed absence, and settled admission reservation. */
  private async assertFixtureCleanupVerified(scope: {
    installationId: string; releaseId: string; connectionId: string; connectionRevision: number;
    presetId: string; presetDigest: string; effectiveSettingsDigest: string;
  }): Promise<void> {
    const destroys = await this.db.select({ fixture: incusQualificationFixtures,
      binding: sandboxBindings, operation: sandboxOperations, reservation: sandboxReservations })
      .from(incusQualificationFixtures)
      .innerJoin(sandboxBindings, eq(sandboxBindings.id, incusQualificationFixtures.bindingId))
      .innerJoin(sandboxOperations, and(eq(sandboxOperations.bindingId, incusQualificationFixtures.bindingId),
        eq(sandboxOperations.kind, "DESTROY")))
      .leftJoin(sandboxReservations, eq(sandboxReservations.bindingId, incusQualificationFixtures.bindingId))
      .where(and(eq(incusQualificationFixtures.installationId, scope.installationId),
        eq(incusQualificationFixtures.releaseId, scope.releaseId),
        eq(incusQualificationFixtures.connectionId, scope.connectionId),
        eq(incusQualificationFixtures.connectionRevision, scope.connectionRevision),
        eq(incusQualificationFixtures.presetId, scope.presetId),
        eq(incusQualificationFixtures.presetDigest, scope.presetDigest),
        eq(incusQualificationFixtures.effectiveSettingsDigest, scope.effectiveSettingsDigest)));
    for (const { fixture, binding, operation, reservation } of destroys) {
      if (!fixtureMatchesBinding(fixture, binding) || operation.idempotencyScope !== "incus-qualification"
        || operation.idempotencyKey !== `${fixture.operationId}:destroy`
        || operation.state !== "SUCCEEDED" || binding.currentOperationId !== operation.id
        || binding.generation !== operation.generation || binding.desiredState !== "ABSENT"
        || binding.observedState !== "ABSENT" || !binding.tombstonedAt || !binding.cleanupConfirmedAt
        || !reservation || reservation.generation !== operation.generation
        || reservation.cleanupIntentId !== qualificationDestroyIntent(fixture.operationId)
        || !reservation.cleanupRequestedAt || reservation.computeState !== "RELEASED"
        || reservation.diskState !== "RELEASED") {
        throw new IncusQualificationCleanupError();
      }
    }
  }

  private async checkedPreparation(input: PrepareIncusFeatureInput) {
    const [project] = await this.db.select({ purpose: projects.purpose }).from(projects)
      .where(eq(projects.id, input.projectId)).limit(1);
    if (project?.purpose !== "user") throw new Error("Incus feature project is unavailable");
    const [existing] = await this.db.select().from(sandboxBindings)
      .where(eq(sandboxBindings.projectId, input.projectId)).limit(1);
    const approved = await this.approved(input, existing);
    if (existing && (existing.tombstonedAt || !existing.connectionRevision || existing.resourceKey !== existing.id)) {
      throw new Error("Incus feature binding is unavailable");
    }
    return { existing, approved };
  }

  /** Uses the same production gate as prepare without creating a binding. */
  async checkReadiness(input: PrepareIncusFeatureInput): Promise<void> {
    await this.checkedPreparation(input);
  }

  async prepare(input: PrepareIncusFeatureInput): Promise<SandboxBinding> {
    const { existing, approved } = await this.checkedPreparation(input);
    if (existing) {
      return existing;
    }
    if (!approved.qualification) throw new Error("Live Incus preset qualification is unavailable");
    const id = randomUUID();
    return this.db.transaction(async (transaction: DbTransaction) => {
      await this.assertCurrentScope({ connectionId: input.connectionId,
        providerInstallationId: input.installationId,
        providerReleaseId: approved.snapshot.release.id,
        releaseDigest: approved.snapshot.release.releaseDigest,
        generation: approved.snapshot.installation.generation,
        revision: approved.connection.revision }, transaction);
      return this.controller.createBinding({
        id, projectId: input.projectId, providerInstallationId: input.installationId,
        providerReleaseId: approved.snapshot.release.id, connectionId: input.connectionId,
        connectionRevision: approved.connection.revision, resourceKey: id,
        profile: approved.preset.profile, presetId: approved.preset.id,
        presetDigest: approved.presetDigest,
        effectiveSettingsDigest: approved.effectiveSettingsDigest,
        desiredState: "STOPPED", observedState: "UNKNOWN",
      }, transaction);
    });
  }

  private async assertUserBinding(id: string): Promise<void> {
    const [fixture] = await this.db.select({ operationId: incusQualificationFixtures.operationId })
      .from(incusQualificationFixtures).where(eq(incusQualificationFixtures.bindingId, id)).limit(1);
    if (fixture) throw new Error("Incus feature binding is unavailable");
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
    return readIncusProviderGeneration(binding, this.inspect, this.now, requiredState);
  }

  async create(request: IncusFeatureRequest): Promise<IncusFeatureEffect> {
    await this.assertUserBinding(request.bindingId);
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
    await this.assertUserBinding(request.bindingId);
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
    await this.assertUserBinding(request.bindingId);
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
    await this.assertUserBinding(request.bindingId);
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
    await this.assertUserBinding(request.bindingId);
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
    const [fixture] = await this.db.select().from(incusQualificationFixtures)
      .where(eq(incusQualificationFixtures.bindingId, binding.id)).limit(1);
    const settlementIntent = () => {
      if (!fixture) return intentId(operation.kind, request);
      if (!fixtureMatchesBinding(fixture, binding)) {
        throw new IncusQualificationCleanupError();
      }
      if (operation.idempotencyScope === "incus-qualification" && operation.kind === "CREATE"
        && operation.idempotencyKey === fixture.operationId) {
        const scope = { installationId: fixture.installationId, releaseId: fixture.releaseId,
          connectionId: fixture.connectionId, presetId: fixture.presetId };
        const identity = createHash("sha256").update(JSON.stringify([scope, fixture.operationId])).digest("hex");
        return `incus-qualification-create-${identity}`;
      }
      if (operation.idempotencyScope === "incus-qualification-power" && operation.kind === "STOP"
        && operation.idempotencyKey.startsWith(`${fixture.operationId}:`)) {
        const powerId = operation.idempotencyKey.slice(fixture.operationId.length + 1);
        if (powerId) return `incus-qualification-stop-${fixture.operationId}-${powerId}`;
      }
      if (operation.idempotencyScope === "incus-qualification" && operation.kind === "DESTROY"
        && operation.idempotencyKey === `${fixture.operationId}:destroy`) {
        return qualificationDestroyIntent(fixture.operationId);
      }
      throw new IncusQualificationCleanupError();
    };
    if (operation.kind === "CREATE" && binding.observedState === "STOPPED") {
      const id = settlementIntent();
      await this.admission.markStopIntent(binding.id, binding.generation, id);
      await this.admission.recordObservedState(binding.id, binding.generation, "STOPPED", id);
    } else if (operation.kind === "STOP" && binding.observedState === "STOPPED") {
      await this.admission.recordObservedState(binding.id, binding.generation, "STOPPED", settlementIntent());
    } else if (operation.kind === "DESTROY" && binding.observedState === "ABSENT") {
      await this.admission.recordObservedState(binding.id, binding.generation, "ABSENT", settlementIntent());
    }
  }

  /** Settle one confirmed operation after an exact recovery pass. */
  async settleCompletedOperation(operationId: string): Promise<void> {
    const operation = await this.controller.getOperation(operationId);
    if (operation?.state !== "SUCCEEDED") {
      throw new IncusQualificationCleanupError();
    }
    await this.settle(operation);
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
