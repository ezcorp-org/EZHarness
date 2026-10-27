import { snapshotFirstPartyExtension } from "../../scripts/migrate-extension-v4";
import { getDb } from "../db/connection";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { getExtensionByName, updateExtension } from "../db/queries/extensions";
import { listUsers } from "../db/queries/users";
import { extensionLogger } from "../logger";
import { getExtensionLifecycle } from "./extension-lifecycle-service";
import { bundledInstallationId } from "./bundled-installation-id";
import { getProjectRoot } from "./project-root";
import { isExtensionRunnerConfigured } from "./runner-connection";
import { digestObject } from "./v4/blobs";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { REFERENCE_CODE_RUNNER_OWNER_INACTIVE, referenceCodeRunnerStageFailure, type ReferenceCodeRunnerStageFailure, type ReferenceCodeRunnerStaging } from "../factory/reference-code/runner-install";
import type { InstallationState, LifecycleActor, LifecycleOperation } from "./v4/types";

const log = extensionLogger("bundled", "bootstrap");
let buildQueue = Promise.resolve();

export { bundledInstallationId };

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

type Lifecycle = Awaited<ReturnType<typeof getExtensionLifecycle>>;

interface StagingContext {
  readonly users: Awaited<ReturnType<typeof listUsers>>;
  readonly lifecycle: Lifecycle;
  readonly repository: DatabaseLifecycleRepository;
  readonly runnerConfigured: boolean;
}

async function stagingContext(): Promise<StagingContext | undefined> {
  const users = await listUsers();
  if (!firstAdministrator(users)) {
    log.info("Bundled extensions await an active administrator before source staging");
    return undefined;
  }
  return { users, lifecycle: await getExtensionLifecycle(), repository: new DatabaseLifecycleRepository(getDb()), runnerConfigured: isExtensionRunnerConfigured() };
}

function firstAdministrator(users: StagingContext["users"]) {
  return users.filter((user) => user.role === "admin" && user.status === "active").sort((left, right) => left.id.localeCompare(right.id))[0];
}

/** The installation state, created disabled and global on first sight; `undefined` when it was uninstalled or its owner is inactive. */
async function stagedInstallation(context: StagingContext, name: string, installationId: string, ownerId: string): Promise<InstallationState | undefined> {
  let state = await context.repository.read(installationId);
  if (state?.installation.uninstalled) return undefined;
  if (!state) {
    await context.repository.create({ installation: { id: installationId, ownerId, scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 0 }, workspaces: {}, revisions: {}, operations: {}, releases: {}, approvals: {} });
    state = await context.repository.read(installationId);
  }
  if (!state) throw new Error("Source installation could not be persisted");
  if (!context.users.some((user) => user.id === state.installation.ownerId && user.status === "active")) {
    log.warn("Bundled installation owner is inactive; manual ownership review required", { name });
    return undefined;
  }
  return state;
}

/**
 * Stages one source as a v4 workspace and queues its isolated build. Idempotent: a workspace is
 * keyed by its source digest and a build by (source, build policy), so the same bytes stage once.
 * Changed bytes become a new workspace and build, whose release still waits for human approval.
 */
async function stageSource(context: StagingContext, name: string, state: InstallationState, files: WorkspaceFiles, entrypoint: string): Promise<void> {
  const installationId = state.installation.id;
  const actor: LifecycleActor = { principalId: state.installation.ownerId, scope: state.installation.scope, kind: "service" };
  const sourceDigest = digestObject(files);
  const workspace = Object.values(state.workspaces).find((candidate) => candidate.sourceDigest === sourceDigest)
    ?? (await context.lifecycle.createWorkspace(actor, { installationId, files })).workspace;
  // One key per (source, build policy). The lifecycle compares a reused key
  // against the full build input, which carries the policy digest, so a
  // source-only key collides the moment the runner image, profile,
  // validator or limits move — every bundled extension, every boot.
  const baseKey = `bundled-bootstrap:${sourceDigest}:${context.lifecycle.policyDigest()}`;
  const planned = context.runnerConfigured ? plannedBuild(state, baseKey) : { key: baseKey, previous: undefined };
  if (planned.previous) log.info("Retrying a bundled build that failed before the extension runner was configured", { name, installationId, previousOperationId: planned.previous.id });
  const operation = await context.lifecycle.build(actor, { installationId, workspaceId: workspace.id, expectedRevision: workspace.revision, entrypoint, idempotencyKey: planned.key });
  if (operation.state === "queued") {
    buildQueue = buildQueue.then(async () => {
      try { await context.lifecycle.runBuild(actor, installationId, operation.id); }
      catch (error) { log.error("Bundled isolated build failed", { name, installationId, error: String(error) }); }
    });
  }
  log.info("Bundled source staged; verified releases require human approval", { name, installationId, operationId: operation.id, status: operation.state });
}

export async function stageBundledExtensionSources(entries: readonly { name: string; path: string }[]): Promise<void> {
  const context = await stagingContext();
  if (!context) return;
  for (const entry of entries) {
    try {
      const legacy = await getExtensionByName(entry.name);
      const ownerId = legacy?.creatorUserId ?? firstAdministrator(context.users)!.id;
      if (!context.users.some((user) => user.id === ownerId && user.status === "active")) {
        log.warn("Bundled source owner is inactive; manual ownership review required", { name: entry.name });
        continue;
      }
      const state = await stagedInstallation(context, entry.name, legacy?.id ?? bundledInstallationId(entry.name), ownerId);
      if (!state) continue;
      const legacyGrants = legacy?.grantedPermissions;
      const needsRevocation = legacy?.enabled || Object.keys(legacyGrants ?? {}).some((key) => key !== "grantedAt") || Object.keys(legacyGrants?.grantedAt ?? {}).length > 0;
      if (legacy && !state.installation.activeReleaseId && needsRevocation) await updateExtension(legacy.id, { enabled: false, grantedPermissions: { grantedAt: {} } });
      const snapshot = await snapshotFirstPartyExtension(getProjectRoot(), entry.name);
      if (snapshot.source.directory !== entry.path) throw new Error("Bundled source path does not match the reviewed inventory");
      await stageSource(context, entry.name, state, snapshot.files, snapshot.source.entrypoint);
    } catch (error) {
      log.error("Bundled source staging requires attention", { name: entry.name, error: String(error) });
    }
  }
}

/** The installation id one built-in runner package always gets: its own namespace, never a bundled extension's. */
export function builtinRunnerInstallationId(manifestName: string): string {
  return bundledInstallationId(`factory-runner:${manifestName}`);
}

/**
 * Stages built-in runner packages (C05 "Install built-in runner packages", W4H-26) the way bundled
 * sources are staged: owned by the first active administrator, global, disabled until that
 * administrator approves the exact release. The files are the product's committed source, staged by
 * the caller; the install confers no authority of its own.
 */
export async function stageBuiltinRunnerSources(entries: readonly { manifestName: string; files: WorkspaceFiles; entrypoint: string }[]): Promise<ReferenceCodeRunnerStaging> {
  const context = await stagingContext();
  if (!context) return { state: "awaiting-administrator" };
  const ownerId = firstAdministrator(context.users)!.id;
  const staged: string[] = [];
  const failed: ({ manifestName: string } & ReferenceCodeRunnerStageFailure)[] = [];
  for (const entry of entries) {
    try {
      const state = await stagedInstallation(context, entry.manifestName, builtinRunnerInstallationId(entry.manifestName), ownerId);
      if (!state) { failed.push({ manifestName: entry.manifestName, ...referenceCodeRunnerStageFailure(REFERENCE_CODE_RUNNER_OWNER_INACTIVE) }); continue; }
      await stageSource(context, entry.manifestName, state, entry.files, entry.entrypoint);
      staged.push(entry.manifestName);
    } catch (error) {
      log.error("Built-in runner package staging requires attention", { name: entry.manifestName, error: String(error) });
      // Published by code and fixed reason; the raw error stays in this log line.
      failed.push({ manifestName: entry.manifestName, ...referenceCodeRunnerStageFailure(error) });
    }
  }
  return { state: "staged", staged, failed };
}
