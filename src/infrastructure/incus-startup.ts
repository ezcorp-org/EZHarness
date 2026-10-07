import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { getDb, type Database } from "../db/connection";
import type { SandboxBinding } from "../db/schema";
import { getReleaseRuntime, resolveActiveRelease } from "../extensions/release-process";
import { createProviderSandboxWorkspaceBackend } from "../runtime/workspaces/provider-backend";
import { setSandboxWorkspaceTargetResolver } from "../runtime/workspaces/project-target";
import { sandboxWorkspaceTarget, type SandboxPreviewBackend } from "../runtime/workspaces/target";
import { ProviderConnectionStore } from "./provider-connections/store";
import { IncusWorkspaceCaller } from "./incus-workspace-caller";
import { IncusSandboxPreviewBackend } from "./incus-preview-backend";
import { createIncusPreviewAuthorizer, incusPreviewQualified } from "./incus-preview-authority";
import { connectIncusPreviewDuplex } from "./incus-transport/preview-duplex";
import { createIncusPreviewTrafficDriver } from "./incus-preview-traffic";
import type { ProviderSandboxWorkspaceCaller } from "../runtime/workspaces/provider-backend";
import { IncusFeatureService } from "./incus-feature-service";
import { assertIncusQualificationOwner, IncusQualificationFixtureService, IncusQualificationStore } from "./incus-qualification";
import { IncusQualificationCheckpointStore } from "./incus-qualification-checkpoint";
import { IncusHostLiveWitness, incusHostLiveWitnessReady } from "./incus-host-live-witness";
import { IncusLiveCleanupController } from "./incus-live-cleanup-controller";
import { IncusLiveControlProbes } from "./incus-live-control-probes";
import { IncusLiveProbeFixtureService } from "./incus-live-probe-fixtures";
import { resumeDurableIncusLiveCases } from "./incus-live-cases";
import type { IncusQualificationScope } from "./incus-qualification";
import { releaseTerminalIncusQualification } from "./incus-qualification-supervisor-client";
import { logger } from "../logger";

const log = logger.child("incus.reconcile");

function qualificationProbeRoot(): string {
  const root = process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
  if (!root) throw new Error("Incus control probe root is unavailable");
  return root;
}

/** Both normal projects and claimed qualification fixtures use this backend.
 * Construction grants no access; each request obtains fresh host authority. */
export function createIncusPreviewBackend(db?: Database, caller?: ProviderSandboxWorkspaceCaller): IncusSandboxPreviewBackend {
  return new IncusSandboxPreviewBackend(caller ?? { call: request => new IncusWorkspaceCaller({ db }).call(request) },
    Date.now, request => connectIncusPreviewDuplex(request, createIncusPreviewAuthorizer({ db })));
}

async function qualificationWitness(scope: IncusQualificationScope, runId: string,
  db: Database, rootDirectory: string, qualificationOwnerId?: string): Promise<IncusHostLiveWitness> {
  const config = await new IncusLiveProbeFixtureService({ db, rootDirectory }).readyConfig(scope, runId);
  return new IncusHostLiveWitness({ db, qualificationOwnerId, controlProbe: new IncusLiveControlProbes(config, { db }),
    previewTraffic: createIncusPreviewTrafficDriver(), previewBackend: createIncusPreviewBackend(db) });
}

/** New runs require selected readiness before any durable preparation or allocation. */
export async function createIncusQualificationWitness(scope: IncusQualificationScope,
  runId: string, db: Database = getDb(), deps: {
    selected?: Awaited<ReturnType<IncusQualificationStore["authorizeFixture"]>>;
    ready?: typeof incusHostLiveWitnessReady;
    previewReady?: () => Promise<void>;
    qualificationOwnerId?: string;
  } = {}): Promise<IncusHostLiveWitness> {
  const root = qualificationProbeRoot();
  const selected = deps.selected ?? await new IncusQualificationStore({ db }).authorizeFixture(scope);
  if (selected.preset.profile === "persistent-web-compose.v1") {
    await assertIncusQualificationOwner(db, deps.qualificationOwnerId ?? "");
    await (deps.previewReady ?? (() => createIncusPreviewTrafficDriver().ready()))();
  }
  if (!await (deps.ready ?? incusHostLiveWitnessReady)({ expectedPin: { scope,
    connectionRevision: selected.connection.revision, presetDigest: selected.presetDigest,
    effectiveSettingsDigest: selected.effectiveSettingsDigest,
    imageFingerprint: selected.preset.imageDigest, helperSha256: selected.helperDigest } })) {
    throw new Error("Incus selected operator pins are unavailable");
  }
  return qualificationWitness(scope, runId, db, root, deps.qualificationOwnerId);
}

type QualificationContinuationDependencies = {
  db?: Database;
  checkpoints?: Pick<IncusQualificationCheckpointStore, "pending" | "fail">;
  qualifications?: Pick<IncusQualificationStore, "authorizeFixture" | "recordVerified">;
  createWitness?: typeof createIncusQualificationWitness;
  resume?: typeof resumeDurableIncusLiveCases;
  releaseTerminal?: typeof releaseTerminalIncusQualification;
};

/** Run only after the replacement process has opened its own database connection. */
export async function resumePendingIncusQualification(deps: QualificationContinuationDependencies = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const checkpoints = deps.checkpoints ?? new IncusQualificationCheckpointStore(db);
  const pending = await checkpoints.pending();
  if (!pending) return;
  const releaseTerminal = () => (deps.releaseTerminal ?? releaseTerminalIncusQualification)(db).catch(() =>
    log.warn("Incus terminal claim release remains unconfirmed"));
  try {
    const qualifications = deps.qualifications ?? new IncusQualificationStore({ db });
    const selected = await qualifications.authorizeFixture(pending.scope);
    const qualificationOwnerId = selected.preset.profile === "persistent-web-compose.v1"
      ? await new IncusQualificationFixtureService({ db }).ownerForResume(pending.scope, pending)
      : undefined;
    // This is an existing claimed run: the supervisor must keep its active-run
    // readiness fence. Resume uses the durable checkpoint and receipt path instead.
    const witness = deps.createWitness
      ? await deps.createWitness(pending.scope, pending.runId, db, { qualificationOwnerId })
      : await qualificationWitness(pending.scope, pending.runId, db, qualificationProbeRoot(), qualificationOwnerId);
    const evidence = await (deps.resume ?? resumeDurableIncusLiveCases)({ witness,
      composeFixtureImageRef: process.env.EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF },
    pending.scope, selected.preset, { runId: pending.runId, nonce: pending.nonce });
    await qualifications.recordVerified(pending.scope, evidence,
      { runId: pending.runId, nonce: pending.nonce });
    await releaseTerminal();
  } catch (error) {
    const saved = await checkpoints.fail(pending.runId).then(() => true).catch(failure => {
      log.warn("Incus qualification failure could not be saved", { error: String(failure) });
      return false;
    });
    if (saved) await releaseTerminal();
    throw error;
  }
}

/** Keep the database open until an accepted handoff finishes or fails. */
export function startIncusQualificationContinuation(deps: QualificationContinuationDependencies = {}): () => Promise<void> {
  const running = resumePendingIncusQualification(deps)
    .catch(error => log.warn("Incus qualification continuation failed", { error: String(error) }));
  return async () => { await running; };
}

type StartupDependencies = {
  backend?: ReturnType<typeof createProviderSandboxWorkspaceBackend>;
  previewBackend?: SandboxPreviewBackend;
  /** Host-owned preview qualification; production requires the saved profile proof. */
  previewQualified?: (binding: SandboxBinding) => Promise<boolean>;
  setResolver?: typeof setSandboxWorkspaceTargetResolver;
  resolveRelease?: (installationId: string) => ReturnType<typeof resolveActiveRelease>;
  getConnectionMetadata?: (connectionId: string) => ReturnType<ProviderConnectionStore["getMetadata"]>;
};

/** Install a resolver, not a standing provider grant. Each tool call rechecks
 * its binding, active release, connection revision, and selected preset. */
export function initializeIncusSandboxWorkspace(dependencies: StartupDependencies = {}): void {
  const caller = dependencies.backend ? null : new IncusWorkspaceCaller();
  const backend = dependencies.backend ?? createProviderSandboxWorkspaceBackend(caller!);
  const previewQualified = dependencies.previewQualified ?? incusPreviewQualified;
  // Delay database access until a request: startup installs routing, not a grant.
  const previewBackend = dependencies.previewBackend ?? createIncusPreviewBackend(undefined, caller ?? undefined);
  (dependencies.setResolver ?? setSandboxWorkspaceTargetResolver)(async binding => {
    if (!binding.resourceKey || binding.resourceKey !== binding.id || !binding.connectionRevision
      || !binding.profile || !binding.presetId || !binding.presetDigest || !binding.effectiveSettingsDigest
      || binding.desiredState !== "RUNNING" || binding.observedState !== "RUNNING" || binding.tombstonedAt) {
      return null;
    }
    try {
      const snapshot = await (dependencies.resolveRelease ??
        (installationId => resolveActiveRelease(installationId, getReleaseRuntime())))(binding.providerInstallationId);
      const connection = await (dependencies.getConnectionMetadata ??
        (connectionId => new ProviderConnectionStore(getDb()).getMetadata(connectionId)))(binding.connectionId);
      if (snapshot.release.id !== binding.providerReleaseId || !connection || connection.revokedAt
        || connection.revision !== binding.connectionRevision
        || connection.providerInstallationId !== binding.providerInstallationId
        || connection.providerReleaseId !== binding.providerReleaseId
        || connection.configuration.kind !== "incus") return null;
      const provider = snapshot.release.manifest.sandboxProviders?.find(item => item.kind === "sandbox" && item.id === "incus");
      const preset = provider?.presets.find(item => item.id === binding.presetId && item.profile === binding.profile);
      if (!preset || await sandboxPresetDigest(preset) !== binding.presetDigest) return null;
      const selectedBackend = previewBackend && binding.profile === "persistent-web-compose.v1"
        && await previewQualified(binding)
        ? { ...backend, previews: previewBackend } : backend;
      return sandboxWorkspaceTarget({
        projectId: binding.projectId,
        workspaceId: binding.resourceKey,
        connectionId: binding.connectionId,
        providerId: "incus",
        generation: binding.generation,
        presetId: binding.presetId,
        releaseDigest: snapshot.release.releaseDigest,
        presetDigest: binding.presetDigest,
        effectiveSettingsDigest: binding.effectiveSettingsDigest,
      }, selectedBackend);
    } catch {
      return null;
    }
  });
}

/** Recover admitted effects and reservation state after a controller restart. */
export async function reconcileIncusWithClaimedCleanup(deps: {
  checkpoints: Pick<IncusQualificationCheckpointStore, "pendingCleanup" | "fail">;
  recover: (scope: IncusQualificationScope, handle: { operationId: string; sandboxId: string }) => Promise<void>;
  verifySettled: (scope: IncusQualificationScope, handle: { operationId: string; sandboxId: string },
    operationId: string) => Promise<void>;
  reconcile: () => Promise<unknown>;
}): Promise<void> {
  const pending = await deps.checkpoints.pendingCleanup();
  if (pending) {
    // The active witness owns its fault. A background tick must not settle it early.
    if (pending.originProcessCurrent) return;
    if (pending.operationState === "OUTCOME_UNKNOWN") await deps.recover(pending.scope, pending.handle);
    else if (pending.operationState === "SUCCEEDED") {
      await deps.verifySettled(pending.scope, pending.handle, pending.operationId);
    } else throw new Error("Incus recovery destroy needs operator review before reconciliation");
    // The old process cannot publish its SP05 evidence after a crash.
    await deps.checkpoints.fail(pending.runId);
  }
  await deps.reconcile();
}

export function startIncusSandboxReconciler(intervalMs = 30_000,
  reconcile?: () => Promise<unknown>, databaseOverride?: Database): () => Promise<void> {
  let observationBroker: ReturnType<typeof getReleaseRuntime>["providerRpcBroker"];
  if (!reconcile) {
    try { observationBroker = getReleaseRuntime().providerRpcBroker; }
    catch { log.warn("Incus native observation runtime is unavailable"); }
    const database = databaseOverride ?? getDb();
    const qualifications = new IncusQualificationStore({ db: database });
    const service = new IncusFeatureService({ db: database,
      loadQualification: scope => qualifications.load(scope) });
    const checkpoints = new IncusQualificationCheckpointStore(database);
    const cleanup = async () => {
        const readinessProjectId = process.env.EZCORP_INCUS_QUALIFICATION_USER_PROJECT_ID;
        if (!readinessProjectId) throw new Error("Incus cleanup recovery project is unavailable");
        return new IncusLiveCleanupController({ db: database,
          fixtures: new IncusQualificationFixtureService({ db: database, qualifications }),
          qualifications, readinessProjectId, checkpoints });
    };
    reconcile = () => reconcileIncusWithClaimedCleanup({ checkpoints,
      recover: async (scope, handle) => (await cleanup()).reconcileFromReopenedController(scope, handle),
      verifySettled: async (scope, handle, operationId) =>
        (await cleanup()).settleAlreadyCompletedDestroy(scope, handle, operationId),
      reconcile: async () => { await observationBroker?.resumePendingObservations(); return service.reconcile(); },
    });
  }
  let stopped = false;
  let pending: Promise<void> | null = null;
  const tick = () => {
    if (stopped || pending) return;
    pending = reconcile().then(() => undefined)
      .catch(error => log.warn("Incus reconciliation failed", { error: String(error) }))
      .finally(() => { pending = null; });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await observationBroker?.stopObservations();
    await pending;
  };
}
