import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { canonicalJson, compileValueSchema, validateManifest, type CandidateVerificationReport, type InstallationRecord, type ReleaseRecord, type ReverseRpc, type Runner, type RunnerExecution, type WorkspaceFiles } from "@ezcorp/extension-contract";
import { buildLimits, DEFAULT_IMAGE, executionLimits, resolveDependencies, RunnerClient } from "@ezcorp/extension-runner";
import { eq, sql } from "drizzle-orm";
import { DatabaseLifecycleRepository, releaseRows } from "../db/queries/extension-releases";
import { extensionLogger } from "../logger";
import { ExtensionControl, requestedReleaseGrants } from "./extension-control";
import { ExtensionLifecycle, FileBlobStore, LifecycleError, type LifecycleActor, type LifecycleDependencies, type LifecycleRelease } from "./v4";
import { ExtensionDataMigrations, type StorageMigrationInput } from "./v4/data-migrations";
import { ExtensionDeliveryQueue } from "./v4/deliveries";
import { createCandidateVerificationBroker, type CandidateFixtures } from "./candidate-verification-broker";
import { getFiles } from "./v4/blobs";

const log = extensionLogger("author", "lifecycle");

interface PolicyUser { id: string; role: "admin" | "member"; status: "active" | "inactive" }
interface PolicyProjection { id: string; name: string; creatorUserId: string | null; modifiable: boolean }

export interface LifecyclePolicyLookup {
  user(id: string): Promise<PolicyUser | undefined>;
  installation(id: string): Promise<InstallationRecord | null>;
  projectionById(id: string): Promise<PolicyProjection | null>;
  projectionByName(name: string): Promise<PolicyProjection | null>;
  projectMember(userId: string, projectId: string): Promise<boolean>;
}

export function createLifecycleAuthorization(lookup: LifecyclePolicyLookup): Pick<LifecycleDependencies, "authorize" | "authorizeAccess"> {
  async function activeUser(principalId: string) {
    const user = await lookup.user(principalId);
    if (user?.status !== "active") throw new LifecycleError("unauthorized", "An active user is required.");
    return user;
  }
  async function scopeAccess(actor: LifecycleActor, user: PolicyUser): Promise<void> {
    if (actor.scope === "global") return;
    if (!actor.scope.startsWith("project:") || !actor.scope.slice(8)) throw new LifecycleError("invalid_scope", "Use a host-resolved global or project scope.");
    if (user.role !== "admin" && !(await lookup.projectMember(user.id, actor.scope.slice(8)))) throw new LifecycleError("forbidden", "Project membership is required.");
  }
  return {
    async authorizeAccess(actor, installation) {
      const user = await activeUser(actor.principalId);
      if (user.role !== "admin" && (installation.ownerId !== user.id || installation.scope !== actor.scope)) throw new LifecycleError("not_found", "Installation not found.");
      await scopeAccess(actor, user);
    },
    async authorize(actor, action, release, grants) {
      const user = await activeUser(actor.principalId);
      await scopeAccess(actor, user);
      if (action === "approve" && (actor.kind !== "human" || user.role !== "admin")) throw new LifecycleError("human_admin_required", "An administrator must approve the release in a human session.");
      if (!release) return;
      validateManifest(release.manifest);
      const installation = await lookup.installation(release.installationId);
      if (!installation) throw new LifecycleError("not_found", "Installation not found.");
      const owner = await activeUser(installation.ownerId);
      await scopeAccess({ principalId: owner.id, scope: installation.scope, kind: "service" }, owner);
      if (user.id !== owner.id && user.role !== "admin") throw new LifecycleError("not_found", "Installation not found.");
      const requested = requestedReleaseGrants(release.manifest);
      if (grants && canonicalJson([...new Set(grants)].sort()) !== canonicalJson(requested)) throw new LifecycleError("grant_mismatch", "Approval must match the exact declared permissions.");
      const existing = await lookup.projectionById(installation.id);
      if (existing && existing.name !== release.manifest.name) throw new LifecycleError("extension_name_changed", "A release cannot rename its installation or data namespace.");
      const named = await lookup.projectionByName(release.manifest.name);
      if (named && named.id !== installation.id) throw new LifecycleError("extension_name_in_use", "Another installation owns this extension name.");
      if (existing && owner.role !== "admin" && (existing.creatorUserId !== owner.id || !existing.modifiable)) throw new LifecycleError("modification_denied", "An administrator must allow changes to this installation.");
    },
  };
}

export async function verifyExtensionCandidate(runner: Runner, release: ReleaseRecord, reverseRpc?: ReverseRpc, fixtures?: CandidateFixtures): Promise<CandidateVerificationReport> {
  const workerId = randomUUID();
  const scopeId = `verification:${randomUUID()}`;
  const context = { invocationId: randomUUID(), workerId, releaseId: release.id, principalId: "extension-verification", scopeId, token: randomUUID(), deadline: Date.now() + executionLimits.timeoutMs, metadata: { ezConversationId: scopeId } };
  const broker = await createCandidateVerificationBroker(release, context, fixtures);
  let worker: RunnerExecution | undefined;
  try {
    worker = await runner.start({ workerId, artifactDigest: release.artifactDigest, context, limits: executionLimits }, reverseRpc ?? broker.reverseRpc);
    const discovered = validateManifest(await worker.request("extension/discover", {}));
    if (canonicalJson(discovered) !== canonicalJson(release.manifest)) throw new LifecycleError("runtime_catalog_mismatch", "Runtime metadata changed after verification.");
    if (discovered.smokeTest) {
      const smoke = discovered.smokeTest;
      const tool = discovered.tools?.find((candidate) => candidate.name === smoke.tool);
      if (!tool) throw new LifecycleError("missing_test_tool", "Smoke test references an undeclared tool.");
      compileValueSchema(tool.inputSchema)(smoke.input);
      broker.begin(smoke.tool);
      const result = await worker.request("extension/invoke", { name: smoke.tool, input: smoke.input, context });
      compileValueSchema(tool.outputSchema)(result);
      const expected = smoke.expect;
      if (expected?.textIncludes !== undefined && !canonicalJson(result).includes(expected.textIncludes)) throw new LifecycleError("smoke_assertion_failed", "Smoke test output did not match the expected text.");
      if (expected?.isError === false && result && typeof result === "object" && "isError" in result && result.isError === true) throw new LifecycleError("smoke_assertion_failed", "Smoke test returned an error.");
    }
    const report: CandidateVerificationReport = { catalog: "verified", smoke: discovered.smokeTest ? "passed" : "not_declared", capabilities: broker.coverage() };
    if (report.capabilities.some((entry) => entry.state === "denied")) throw Object.assign(new LifecycleError("candidate_capability_blocked", "Candidate attempted a denied capability; supply an isolated fixture or fix its declaration."), { verification: report });
    return report;
  } catch (error) {
    if (error && typeof error === "object") Object.assign(error, { capabilities: broker.coverage() });
    throw error;
  } finally { try { await worker?.close(); } finally { await broker.close(); } }
}

export async function runStorageMigration(runner: Runner, input: StorageMigrationInput): Promise<unknown> {
  const method = input.release.manifest.methods?.find((candidate) => candidate.name === input.method);
  if (!method) throw new LifecycleError("migration_method_missing", "Storage migration method is not declared.");
  const workerId = randomUUID();
  const context = { invocationId: randomUUID(), workerId, releaseId: input.release.id, principalId: input.principalId, scopeId: `data-migration:${input.scope}`, token: randomUUID(), deadline: Date.now() + executionLimits.timeoutMs };
  const worker = await runner.start({ workerId, artifactDigest: input.release.artifactDigest, context, limits: executionLimits }, async () => { throw new LifecycleError("migration_effect_denied", "Storage migrations cannot access host capabilities."); });
  try {
    const payload = { fromVersion: input.fromVersion, toVersion: input.toVersion, values: input.values };
    compileValueSchema(method.inputSchema)(payload);
    const result = await worker.request("extension/dispatch", { method: input.method, input: payload, context });
    compileValueSchema(method.outputSchema)(result);
    return result;
  } finally { await worker.close(); }
}

interface LifecycleServices { lifecycle: ExtensionLifecycle; control: ExtensionControl; runner: Runner; repository: DatabaseLifecycleRepository; deliveries: ExtensionDeliveryQueue; migrations: ExtensionDataMigrations }
let services: Promise<LifecycleServices> | undefined;

async function initialize(): Promise<LifecycleServices> {
  const socketPath = process.env.EZCORP_EXTENSION_RUNNER_SOCKET;
  const token = process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
  if (!socketPath || !isAbsolute(socketPath) || !token || token.length < 32) throw new LifecycleError("runner_unconfigured", "Configure the extension runner socket and its host authentication token.");
  const runner = new RunnerClient({ socketPath, token });
  const { getDb } = await import("../db/connection");
  const { getUserById } = await import("../db/queries/users");
  const { getExtension, getExtensionByName } = await import("../db/queries/extensions");
  const { getProjectMembership } = await import("../db/queries/project-members");
  const repository = new DatabaseLifecycleRepository(getDb());
  const migrations = new ExtensionDataMigrations(getDb(), (input) => runStorageMigration(runner, input));
  const deliveries = new ExtensionDeliveryQueue(getDb());
  const { configureReleaseRuntime } = await import("./release-process");
  configureReleaseRuntime({
    runner: async () => runner,
    dispatchNotification: async (extensionId, method, params) => {
      const { enqueueExtensionNotification } = await import("./delivery-runtime");
      await enqueueExtensionNotification(extensionId, method, params ?? {});
    },
    resolve: async (id: string) => {
      const state = await repository.read(id);
      if (!state?.installation.activeReleaseId || !state.installation.enabled || state.installation.uninstalled || await migrations.isPaused(id)) return null;
      const release = state.releases[state.installation.activeReleaseId];
      return release ? { release, installation: state.installation, limits: executionLimits } : null;
    },
  });
  const { getProjectRoot } = await import("./project-root");
  const blobs = new FileBlobStore(process.env.EZCORP_EXTENSION_BLOB_ROOT ?? join(getProjectRoot(), ".ezcorp", "extension-releases"));
  const authorization = createLifecycleAuthorization({ user: getUserById, installation: async (id) => (await repository.read(id))?.installation ?? null, projectionById: getExtension, projectionByName: getExtensionByName, projectMember: async (userId, projectId) => Boolean(await getProjectMembership(userId, projectId)) });
  const lifecycle = new ExtensionLifecycle({
    repository,
    blobs,
    runner, resolveDependencies, runnerProfile: "rootless-podman-v4", runnerImageDigest: process.env.EZCORP_EXTENSION_RUNNER_IMAGE ?? DEFAULT_IMAGE,
    validatorVersion: "runner-v4.1", buildLimits,
    ...authorization,
    verifyCandidate: (release) => verifyExtensionCandidate(runner, release),
    prepareActivation: (installation, previous, release, operation) => migrations.prepare(installation, previous, release, operation),
    abortActivation: (installationId, operation) => migrations.abort(installationId, operation.id, operation.lease?.fence),
    publish: async (installation, release) => { await migrations.finalize(installation.id); await publishExtensionGeneration(installation, release, release ? await getFiles(blobs, release.artifactDigest) : undefined); },
  });
  return { lifecycle, control: new ExtensionControl(lifecycle), runner, repository, deliveries, migrations };
}

function getServices(): Promise<LifecycleServices> {
  services ??= initialize().catch((error) => { services = undefined; throw error; });
  return services;
}

export async function getExtensionLifecycle(): Promise<ExtensionLifecycle> { return (await getServices()).lifecycle; }
export async function getExtensionControl(): Promise<ExtensionControl> { return (await getServices()).control; }
export async function getExtensionRunner(): Promise<Runner> { return (await getServices()).runner; }
export async function getExtensionDeliveryQueue(): Promise<ExtensionDeliveryQueue> { return (await getServices()).deliveries; }
export async function getExtensionInstallationState(installationId: string) { return (await getServices()).repository.read(installationId); }

export async function publishExtensionGeneration(installation: InstallationRecord, release: LifecycleRelease | null, sourceFiles?: WorkspaceFiles): Promise<void> {
  const { getDb } = await import("../db/connection");
  const { extensions } = await import("../db/schema");
  const { serializeJsonbFields } = await import("../db/queries/extensions");
  const { buildFullGrantFromManifest } = await import("./install-grant");
  const { ExtensionRegistry } = await import("./registry");
  const { runEntitySeed } = await import("./entities/seed");
  await getDb().transaction(async (transaction: import("../db/connection").DbTransaction) => {
    if (release?.manifest.entities?.length) await transaction.execute(sql`LOCK TABLE extension_storage IN SHARE ROW EXCLUSIVE MODE`);
    const result = await transaction.execute(sql`SELECT payload FROM extension_release_installations WHERE id = ${installation.id} FOR UPDATE`);
    const rows = releaseRows<{ payload: string }>(result);
    const current: InstallationRecord | undefined = rows[0] ? JSON.parse(rows[0].payload) : undefined;
    if (!current || current.generation !== installation.generation || current.activeReleaseId !== installation.activeReleaseId || current.enabled !== installation.enabled) throw new LifecycleError("generation_superseded", "A newer activation replaced this catalog update.");
    if (!release || !installation.enabled) {
      await transaction.update(extensions).set(serializeJsonbFields({ enabled: false, disabledByUser: true, grantedPermissions: {}, updatedAt: new Date() })).where(eq(extensions.id, installation.id));
      return;
    }
    const manifest = release.manifest as unknown as import("./types").ExtensionManifestV2;
    const granted = buildFullGrantFromManifest(manifest);
    const values = serializeJsonbFields({ id: installation.id, name: release.manifest.name, version: release.manifest.version, description: release.manifest.description, manifest, source: "release-v4", installPath: null, enabled: true, grantedPermissions: granted, installedPermissions: granted, checksumVerified: true, isBundled: false, disabledByUser: false, creatorUserId: installation.ownerId, updatedAt: new Date() });
    await transaction.insert(extensions).values(values).onConflictDoUpdate({ target: extensions.id, set: values });
    if (manifest.entities?.length) {
      if (!sourceFiles) throw new LifecycleError("seed_source_missing", "Entity seeds require the verified immutable release files.");
      await runEntitySeed({ extensionId: installation.id, entities: manifest.entities, sourceDir: "", sourceFiles, userId: installation.ownerId, database: transaction });
    }
  });
  await ExtensionRegistry.getInstance().reload();
}

export async function recoverExtensionLifecycle(): Promise<void> {
  const { lifecycle, migrations } = await getServices();
  const { getDb } = await import("../db/connection");
  const result = await getDb().execute(sql`SELECT payload FROM extension_release_installations ORDER BY id`);
  const rows = releaseRows<{ payload: string }>(result);
  for (const row of rows) {
    const installation: InstallationRecord = JSON.parse(row.payload);
    try { await migrations.recover(installation.id); await lifecycle.recover({ principalId: installation.ownerId, scope: installation.scope, kind: "service" }, installation.id); }
    catch (error) { log.error("Extension recovery requires attention", { installationId: installation.id, code: error instanceof LifecycleError ? error.code : "recovery_failed" }); throw error; }
  }
}
