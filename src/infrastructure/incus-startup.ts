import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { getDb } from "../db/connection";
import { getReleaseRuntime, resolveActiveRelease } from "../extensions/release-process";
import { createProviderSandboxWorkspaceBackend } from "../runtime/workspaces/provider-backend";
import { setSandboxWorkspaceTargetResolver } from "../runtime/workspaces/project-target";
import { sandboxWorkspaceTarget } from "../runtime/workspaces/target";
import { ProviderConnectionStore } from "./provider-connections/store";
import { IncusWorkspaceCaller } from "./incus-workspace-caller";
import { IncusFeatureService } from "./incus-feature-service";
import { IncusQualificationStore } from "./incus-qualification";
import { logger } from "../logger";

const log = logger.child("incus.reconcile");

/** Install a resolver, not a standing provider grant. Each tool call rechecks
 * its binding, active release, connection revision, and selected preset. */
export function initializeIncusSandboxWorkspace(): void {
  const caller = new IncusWorkspaceCaller();
  const backend = createProviderSandboxWorkspaceBackend(caller);
  setSandboxWorkspaceTargetResolver(async binding => {
    if (!binding.resourceKey || binding.resourceKey !== binding.id || !binding.connectionRevision
      || !binding.profile || !binding.presetId || !binding.presetDigest || !binding.effectiveSettingsDigest
      || binding.desiredState !== "RUNNING" || binding.observedState !== "RUNNING" || binding.tombstonedAt) {
      return null;
    }
    try {
      const snapshot = await resolveActiveRelease(binding.providerInstallationId, getReleaseRuntime());
      const connection = await new ProviderConnectionStore(getDb()).getMetadata(binding.connectionId);
      if (snapshot.release.id !== binding.providerReleaseId || !connection || connection.revokedAt
        || connection.revision !== binding.connectionRevision
        || connection.providerInstallationId !== binding.providerInstallationId
        || connection.providerReleaseId !== binding.providerReleaseId
        || connection.configuration.kind !== "incus") return null;
      const provider = snapshot.release.manifest.sandboxProviders?.find(item => item.kind === "sandbox" && item.id === "incus");
      const preset = provider?.presets.find(item => item.id === binding.presetId && item.profile === binding.profile);
      if (!preset || await sandboxPresetDigest(preset) !== binding.presetDigest) return null;
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
      }, backend);
    } catch {
      return null;
    }
  });
}

/** Recover admitted effects and reservation state after a controller restart. */
export function startIncusSandboxReconciler(intervalMs = 30_000): () => Promise<void> {
  const database = getDb();
  const qualifications = new IncusQualificationStore({ db: database });
  const service = new IncusFeatureService({ db: database,
    loadQualification: scope => qualifications.load(scope) });
  let stopped = false;
  let pending: Promise<void> | null = null;
  const tick = () => {
    if (stopped || pending) return;
    pending = service.reconcile().then(() => undefined)
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
