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
import { IncusFeatureService } from "./incus-feature-service";
import { IncusQualificationFixtureService, IncusQualificationStore } from "./incus-qualification";
import { IncusQualificationCheckpointStore } from "./incus-qualification-checkpoint";
import { IncusHostLiveWitness } from "./incus-host-live-witness";
import { IncusLiveCleanupController } from "./incus-live-cleanup-controller";
import { IncusLiveControlProbes } from "./incus-live-control-probes";
import { IncusLiveProbeFixtureService } from "./incus-live-probe-fixtures";
import { resumeDurableIncusLiveCases } from "./incus-live-cases";
import type { IncusQualificationScope } from "./incus-qualification";
import { logger } from "../logger";

const log = logger.child("incus.reconcile");

export async function createIncusQualificationWitness(scope: IncusQualificationScope,
  runId: string, db: Database = getDb()): Promise<IncusHostLiveWitness> {
  const rootDirectory = process.env.EZCORP_INCUS_CONTROL_PROBE_ROOT;
  if (!rootDirectory) throw new Error("Incus control probe root is unavailable");
  const config = await new IncusLiveProbeFixtureService({ db, rootDirectory }).readyConfig(scope, runId);
  return new IncusHostLiveWitness({ db, controlProbe: new IncusLiveControlProbes(config) });
}

type QualificationContinuationDependencies = {
  db?: Database;
  checkpoints?: Pick<IncusQualificationCheckpointStore, "pending" | "fail">;
  qualifications?: Pick<IncusQualificationStore, "authorizeFixture" | "recordVerified">;
  createWitness?: typeof createIncusQualificationWitness;
  resume?: typeof resumeDurableIncusLiveCases;
};

/** Run only after the replacement process has opened its own database connection. */
export async function resumePendingIncusQualification(deps: QualificationContinuationDependencies = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const checkpoints = deps.checkpoints ?? new IncusQualificationCheckpointStore(db);
  const pending = await checkpoints.pending();
  if (!pending) return;
  try {
    const qualifications = deps.qualifications ?? new IncusQualificationStore({ db });
    const selected = await qualifications.authorizeFixture(pending.scope);
    const witness = await (deps.createWitness ?? createIncusQualificationWitness)(pending.scope, pending.runId, db);
    const evidence = await (deps.resume ?? resumeDurableIncusLiveCases)({ witness,
      composeFixtureImageRef: process.env.EZCORP_INCUS_COMPOSE_FIXTURE_IMAGE_REF },
    pending.scope, selected.preset, { runId: pending.runId, nonce: pending.nonce });
    await qualifications.recordVerified(pending.scope, evidence,
      { runId: pending.runId, nonce: pending.nonce });
  } catch (error) {
    await checkpoints.fail(pending.runId).catch(failure =>
      log.warn("Incus qualification failure could not be saved", { error: String(failure) }));
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
  /** Host-owned preview qualification. The default remains closed. */
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
  const previewBackend = dependencies.previewQualified
    ? dependencies.previewBackend ?? new IncusSandboxPreviewBackend(caller ?? new IncusWorkspaceCaller())
    : undefined;
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
        && await dependencies.previewQualified?.(binding)
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
  if (!reconcile) {
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
      reconcile: () => service.reconcile(),
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
    await pending;
  };
}
