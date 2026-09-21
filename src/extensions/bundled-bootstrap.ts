import { createHash } from "node:crypto";
import { snapshotFirstPartyExtension } from "../../scripts/migrate-extension-v4";
import { getDb } from "../db/connection";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { getExtensionByName, updateExtension } from "../db/queries/extensions";
import { listUsers } from "../db/queries/users";
import { extensionLogger } from "../logger";
import { getExtensionLifecycle } from "./extension-lifecycle-service";
import { getProjectRoot } from "./project-root";
import { isExtensionRunnerConfigured } from "./runner-connection";
import { digestObject } from "./v4/blobs";
import type { InstallationState, LifecycleActor, LifecycleOperation } from "./v4/types";

const log = extensionLogger("bundled", "bootstrap");
let buildQueue = Promise.resolve();

export function bundledInstallationId(name: string): string {
  const digest = createHash("sha256").update(`ezcorp-first-party-v4:${name}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

// A host that boots before its extension runner exists fails every bundled build
// with this one diagnostic and nothing else. That is the only outcome the
// bootstrap may attempt again; any other diagnostic stays a durable failure.
function failedWithoutRunner(operation: LifecycleOperation): boolean {
  return operation.state === "failed" && operation.diagnostics.length > 0 && operation.diagnostics.every((diagnostic) => diagnostic.code === "runner_unconfigured");
}

// Lifecycle idempotency is deliberately absolute: one key names one outcome
// forever. So a retry needs its own key. Walk the chain of keys for this source
// digest and stop at the first attempt that is absent (build it) or that
// recorded any other outcome (keep it). `previous` is set only when the next key
// is free, which makes at most one new attempt per boot.
function plannedBuild(state: InstallationState, baseKey: string): { key: string; previous?: LifecycleOperation } {
  const operations = Object.values(state.operations);
  let previous: LifecycleOperation | undefined;
  let key = baseKey;
  for (let attempt = 1; attempt <= operations.length; attempt += 1) {
    const existing = operations.find((operation) => operation.idempotencyKey === key);
    if (!existing) return { key, previous };
    if (!failedWithoutRunner(existing)) return { key };
    previous = existing;
    key = `${baseKey}:retry-${attempt}`;
  }
  return { key, previous };
}

export async function stageBundledExtensionSources(entries: readonly { name: string; path: string }[]): Promise<void> {
  const users = await listUsers();
  const administrator = users.filter((user) => user.role === "admin" && user.status === "active").sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!administrator) {
    log.info("Bundled extensions await an active administrator before source staging");
    return;
  }
  const lifecycle = await getExtensionLifecycle();
  const runnerConfigured = isExtensionRunnerConfigured();
  const repository = new DatabaseLifecycleRepository(getDb());
  for (const entry of entries) {
    try {
      const legacy = await getExtensionByName(entry.name);
      const ownerId = legacy?.creatorUserId ?? administrator.id;
      if (!users.some((user) => user.id === ownerId && user.status === "active")) {
        log.warn("Bundled source owner is inactive; manual ownership review required", { name: entry.name });
        continue;
      }
      const installationId = legacy?.id ?? bundledInstallationId(entry.name);
      let state = await repository.read(installationId);
      if (state?.installation.uninstalled) continue;
      if (!state) {
        await repository.create({ installation: { id: installationId, ownerId, scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 0 }, workspaces: {}, revisions: {}, operations: {}, releases: {}, approvals: {} });
        state = await repository.read(installationId);
      }
      if (!state) throw new Error("Source installation could not be persisted");
      if (!users.some((user) => user.id === state.installation.ownerId && user.status === "active")) {
        log.warn("Bundled installation owner is inactive; manual ownership review required", { name: entry.name });
        continue;
      }
      const legacyGrants = legacy?.grantedPermissions;
      const needsRevocation = legacy?.enabled || Object.keys(legacyGrants ?? {}).some((key) => key !== "grantedAt") || Object.keys(legacyGrants?.grantedAt ?? {}).length > 0;
      if (legacy && !state.installation.activeReleaseId && needsRevocation) await updateExtension(legacy.id, { enabled: false, grantedPermissions: { grantedAt: {} } });
      const actor: LifecycleActor = { principalId: state.installation.ownerId, scope: state.installation.scope, kind: "service" };
      const snapshot = await snapshotFirstPartyExtension(getProjectRoot(), entry.name);
      if (snapshot.source.directory !== entry.path) throw new Error("Bundled source path does not match the reviewed inventory");
      const sourceDigest = digestObject(snapshot.files);
      const workspace = Object.values(state.workspaces).find((candidate) => candidate.sourceDigest === sourceDigest)
        ?? (await lifecycle.createWorkspace(actor, { installationId, files: snapshot.files })).workspace;
      const baseKey = `bundled-bootstrap:${sourceDigest}`;
      const planned = runnerConfigured ? plannedBuild(state, baseKey) : { key: baseKey, previous: undefined };
      if (planned.previous) log.info("Retrying a bundled build that failed before the extension runner was configured", { name: entry.name, installationId, previousOperationId: planned.previous.id });
      const operation = await lifecycle.build(actor, { installationId, workspaceId: workspace.id, expectedRevision: workspace.revision, entrypoint: snapshot.source.entrypoint, idempotencyKey: planned.key });
      if (operation.state === "queued") {
        buildQueue = buildQueue.then(async () => {
          try { await lifecycle.runBuild(actor, installationId, operation.id); }
          catch (error) { log.error("Bundled isolated build failed", { name: entry.name, installationId, error: String(error) }); }
        });
      }
      log.info("Bundled source staged; verified releases require human approval", { name: entry.name, installationId, operationId: operation.id, status: operation.state });
    } catch (error) {
      log.error("Bundled source staging requires attention", { name: entry.name, error: String(error) });
    }
  }
}
