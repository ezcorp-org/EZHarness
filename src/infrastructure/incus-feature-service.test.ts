import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign, X509Certificate } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTerminalIncusQualification } from "./incus-qualification-supervisor-client";
import { releaseRows } from "../db/queries/extension-releases";
import { up as addLiveQualification } from "../db/migrations/add-incus-qualification";
import { up as addQualificationRuns } from "../db/migrations/add-incus-qualification-runs";
import { up as completeQualificationRuns } from "../db/migrations/complete-incus-qualification-runs";
import { IncusQualificationCheckpointStore, currentProcessIdentity, observationDigest, qualificationFixtureIdentity, restartHandoffSigningBytes } from "./incus-qualification-checkpoint";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { sandboxPresetDigest, type SandboxOperationInspection } from "@ezcorp/extension-contract";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import { up as addQualificationFixtures } from "../db/migrations/add-incus-qualification-fixtures";
import * as schema from "../db/schema";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { SandboxController, type SandboxProviderDispatcher, type SandboxProviderRequest, type SandboxProviderOutcome } from "../sandboxes/controller";
import { incusManifest, INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { digest } from "../../scripts/incus/model";
import type { ProviderConnectionCredentials } from "./provider-connections/store";
import { IncusCleanupRecoveryService, IncusFeatureService, type IncusFeatureServiceDependencies } from "./incus-feature-service";
import { inspectedOutcome } from "../sandboxes/incus-dispatcher";
import { HostIncusLifecycleTransport, resourceName } from "./incus-transport/lifecycle";
import { makeTestCertificates } from "./incus-transport/test-certificates";

const databases: PGlite[] = [];
const tlsFixtures: ReturnType<typeof makeTestCertificates>[] = [];
// Each case starts and migrates a fresh PGlite database. In the combined
// Incus suite that work can exceed Bun's five-second default before assertions run.
const DB_TEST_TIMEOUT_MS = 30_000;

async function fixture() {
  const pglite = new PGlite();
  databases.push(pglite);
  await pglite.waitReady;
  await pglite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pglite.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
  await pglite.exec("INSERT INTO users (id) VALUES ('admin')");
  await pglite.exec("CREATE TABLE project_members (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(project_id, user_id))");
  const db = drizzle(pglite, { schema });
  await addSandboxController(db);
  await addQualificationFixtures(db);
  await addLiveQualification(db);
  await db.insert(schema.projects).values({ id: "project", name: "project", path: "/work/project" });
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const effectiveSettingsDigest = digest({ presetDigest, connectionRevision: 1 });
  const snapshot = {
    installation: { id: "installation", activeReleaseId: "release" },
    release: { id: "release", releaseDigest: "release-digest", manifest: incusManifest },
  } as unknown as ActiveExtensionRelease;
  const connection: ProviderConnectionCredentials = {
    id: "connection", revision: 1, providerInstallationId: "installation", providerReleaseId: "release",
    endpoint: "https://incus.example:8443/", serverCertificatePem: "server", project: "ezharness",
    configuration: { kind: "incus", profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" },
    clientCertificatePem: "client", privateKeyPem: "private-key-canary", revokedAt: null,
  };
  const dispatches: SandboxProviderRequest[] = [];
  const provider: SandboxProviderDispatcher = {
    dispatch: async request => { dispatches.push(request); return { outcome: "PENDING", providerOperationId: `provider-${request.operationId}` }; },
    inspectOperation: async request => ({ outcome: "SUCCEEDED",
      providerOperationId: request.providerOperationId ?? undefined,
      observedState: request.kind === "START" ? "RUNNING" : request.kind === "DESTROY" ? "ABSENT" : "STOPPED",
    } satisfies SandboxProviderOutcome),
  };
  const controller = new SandboxController(db, provider);
  const admission = new SandboxAdmissionStore(db);
  let qualificationAvailable = true;
  let providerState: "running" | "stopped" = "stopped";
  let providerGeneration = 1;
  let inspectUnavailable = false;
  const retiredCalls: string[] = [];
  const serviceDependencies: IncusFeatureServiceDependencies = {
    db, controller, admission, activeRelease: async () => snapshot,
    assertCurrentScope: async scope => {
      if (scope.providerReleaseId !== snapshot.installation.activeReleaseId) {
        throw new Error("Provider release changed during capacity review");
      }
    },
    connectionRevision: async () => connection.revision,
    resolveConnection: async () => connection,
    loadQualification: async () => qualificationAvailable ? {
      producer: "live-provider", connectionId: "connection", providerId: "incus",
      presetId: preset.id, profile: preset.profile, releaseDigest: "release-digest",
      presetDigest, effectiveSettingsDigest, backendVersion: "6.0.6",
      verifiedAt: "2026-09-22T11:00:00Z", validUntil: "2026-09-23T11:00:00Z", cases: [],
    } : null,
    assertReady: async () => {},
    inspect: async (_installationId, bindingId, input) => {
      if (inspectUnavailable) throw new Error("provider instance is absent");
      return { ok: true, sandbox: {
      sandboxId: bindingId, profile: preset.profile, presetId: preset.id,
      desiredState: providerState, observedState: providerState,
      generation: providerGeneration, bootId: "boot-1", observedAt: "2026-09-22T12:00:00Z",
    } }; },
    retiredCleanup: async (_db, binding, operation) => {
      retiredCalls.push(operation);
      return { ok: true, sandbox: { sandboxId: binding.id, profile: binding.profile,
        presetId: binding.presetId, desiredState: "stopped", observedState: "stopped",
        generation: providerGeneration, bootId: "boot-1", observedAt: "2026-09-22T12:00:00Z" } };
    },
    now: () => Date.parse("2026-09-22T12:00:00Z"),
  };
  const service = new IncusFeatureService(serviceDependencies);
  const configureAdmission = async () => {
    await admission.configureHostCapacity({ providerInstallationId: "installation", connectionId: "connection",
      allocatable: { memoryBytes: 2 * preset.limits.memoryBytes, cpuMillicores: 2 * preset.limits.cpuMillis,
        pids: 2 * preset.limits.pids, diskBytes: 2 * preset.limits.diskBytes, executionSlots: 2 },
      safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 } });
    await admission.configureProjectQuota({ projectId: "project", providerInstallationId: "installation", connectionId: "connection",
      limit: { memoryBytes: preset.limits.memoryBytes, cpuMillicores: preset.limits.cpuMillis,
        pids: preset.limits.pids, diskBytes: preset.limits.diskBytes, executionSlots: 1 } });
  };
  return { db, service, serviceDependencies, controller, admission, dispatches, provider, connection, setQualification: (value: boolean) => { qualificationAvailable = value; },
    setProvider: (state: "running" | "stopped", generation: number) => { providerState = state; providerGeneration = generation; },
    setInspectUnavailable: (value: boolean) => { inspectUnavailable = value; }, configureAdmission, preset, retiredCalls };
}

afterEach(async () => { for (const certificates of tlsFixtures.splice(0)) certificates.dispose(); await Promise.all(databases.splice(0).map(db => db.close())); });

test("read-only readiness uses the prepare gate without creating a binding", async () => {
  const { db, service, preset, dispatches } = await fixture();
  const input = { projectId: "project", installationId: "installation",
    connectionId: "connection", presetId: preset.id };
  await service.checkReadiness(input);
  expect(await db.select().from(schema.sandboxBindings)).toEqual([]);
  expect(dispatches).toEqual([]);
  await db.insert(schema.projects).values({ id: "qual-project", name: "qual-project",
    path: "/__incus_qualification__/qual-project", purpose: "incus-qualification" });
  await expect(service.checkReadiness({ ...input, projectId: "qual-project" }))
    .rejects.toThrow("feature project is unavailable");
  expect(await db.select().from(schema.sandboxBindings)).toEqual([]);
}, DB_TEST_TIMEOUT_MS);

test("new Incus project rolls back its local fallback and membership when host capacity is absent", async () => {
  const { db, service, preset } = await fixture();
  const input = { name: "Guest project", ownerUserId: "admin", idempotencyKey: "new-project",
    installationId: "installation", connectionId: "connection", presetId: preset.id };
  await expect(service.prepareProject(input)).rejects.toMatchObject({ code: "INVALID_PROJECT_QUOTA" });
  expect(await db.select().from(schema.projects)).toHaveLength(1);
  expect(await db.select().from(schema.projectMembers)).toEqual([]);
  expect(await db.select().from(schema.sandboxProjectQuotas)).toEqual([]);
  expect(await db.select().from(schema.sandboxBindings)).toEqual([]);
}, DB_TEST_TIMEOUT_MS);

test("new Incus project rejects malformed names and idempotency inputs before any row", async () => {
  const { db, service, preset } = await fixture();
  const input = { name: "Guest project", ownerUserId: "admin", idempotencyKey: "new-project",
    installationId: "installation", connectionId: "connection", presetId: preset.id };
  for (const changed of [{ name: "" }, { name: " " }, { name: " Guest" },
    { name: "a".repeat(129) }, { name: "bad\nname" }, { idempotencyKey: "bad key" },
    { ownerUserId: "" }]) {
    await expect(service.prepareProject({ ...input, ...changed })).rejects.toThrow("Invalid Incus project request");
  }
  expect(await db.select().from(schema.projects)).toHaveLength(1);
  expect(await db.select().from(schema.sandboxBindings)).toEqual([]);
}, DB_TEST_TIMEOUT_MS);

test("new Incus project atomically receives its owner, exact quota, and guest binding", async () => {
  const { db, service, admission, preset, connection, setQualification } = await fixture();
  const input = { name: "Guest project", ownerUserId: "admin", idempotencyKey: "new-project",
    installationId: "installation", connectionId: "connection", presetId: preset.id };
  await admission.configureHostCapacity({ providerInstallationId: "installation", connectionId: "connection",
    allocatable: { memoryBytes: 2 * preset.limits.memoryBytes, cpuMillicores: 2 * preset.limits.cpuMillis,
      pids: 2 * preset.limits.pids, diskBytes: 2 * preset.limits.diskBytes, executionSlots: 2 },
    safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 } });
  const result = await service.prepareProject(input);
  expect(result.project).toMatchObject({ name: input.name, purpose: "user" });
  expect(result.project.path.startsWith("/__incus_workspace_unavailable__/incus-project-")).toBe(true);
  expect(result.binding).toMatchObject({ projectId: result.project.id,
    resourceKey: result.binding.id, desiredState: "STOPPED", observedState: "UNKNOWN" });
  expect(await db.select().from(schema.projectMembers)).toEqual([expect.objectContaining({
    projectId: result.project.id, userId: "admin", role: "owner" })]);
  expect(await db.select().from(schema.sandboxProjectQuotas)).toEqual([expect.objectContaining({
    projectId: result.project.id, memoryBytes: preset.limits.memoryBytes,
    cpuMillicores: preset.limits.cpuMillis, diskBytes: preset.limits.diskBytes, executionSlots: 1 })]);
  expect((await service.prepareProject(input)).binding.id).toBe(result.binding.id);
  await expect(service.prepareProject({ ...input, name: "Changed" })).rejects.toThrow("idempotency key changed");
  await expect(service.prepareProject({ ...input, connectionId: "changed-connection" })).rejects.toThrow();
  expect(await db.select().from(schema.projects)).toHaveLength(2);
  setQualification(false);
  await expect(service.prepareProject({ ...input, idempotencyKey: "new-project-2" })).rejects.toThrow("qualification is unavailable");
  connection.revokedAt = new Date();
  await expect(service.prepareProject({ ...input, idempotencyKey: "new-project-3" })).rejects.toThrow("connection changed");
  expect(await db.select().from(schema.projects)).toHaveLength(2);
}, DB_TEST_TIMEOUT_MS);

test("concurrent prepareProject calls with one key publish only one bound project", async () => {
  const { db, service, admission, preset } = await fixture();
  await admission.configureHostCapacity({ providerInstallationId: "installation", connectionId: "connection",
    allocatable: { memoryBytes: preset.limits.memoryBytes, cpuMillicores: preset.limits.cpuMillis,
      pids: preset.limits.pids, diskBytes: preset.limits.diskBytes, executionSlots: 1 },
    safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 } });
  const input = { name: "Concurrent guest", ownerUserId: "admin", idempotencyKey: "concurrent",
    installationId: "installation", connectionId: "connection", presetId: preset.id };
  const [first, second] = await Promise.all([service.prepareProject(input), service.prepareProject(input)]);
  expect(second.project.id).toBe(first.project.id);
  expect(second.binding.id).toBe(first.binding.id);
  expect(await db.select().from(schema.projects)).toHaveLength(2);
  expect(await db.select().from(schema.projectMembers)).toHaveLength(1);
  expect(await db.select().from(schema.sandboxProjectQuotas)).toHaveLength(1);
  expect(await db.select().from(schema.sandboxBindings)).toHaveLength(1);
}, DB_TEST_TIMEOUT_MS);

test("prepare, create, start, stop and destroy use durable admission and provider receipts", async () => {
  const { service, controller, admission, dispatches, setProvider, preset, configureAdmission } = await fixture();
  const binding = await service.prepare({ projectId: "project", installationId: "installation", connectionId: "connection", presetId: preset.id });
  expect(binding.resourceKey).toBe(binding.id);
  await configureAdmission();
  const request = (key: string) => ({ bindingId: binding.id, idempotencyScope: "feature", idempotencyKey: key });
  const created = await service.create(request("create"));
  expect(created.state).toBe("DISPATCHED");
  if (created.state !== "DISPATCHED") throw new Error("CREATE was not dispatched");
  expect(created.operation.state).toBe("PROVIDER_PENDING");
  expect(typeof created.operation.reconcileOrder).toBe("bigint");
  const kitExports = "../../web/node_modules/@sveltejs/kit/src/exports/index.js";
  const { json }: { json(data: unknown): Response } = await import(kitExports);
  expect(() => json(created)).toThrow("BigInt");
  expect(created.operation.providerOperationId).toBe(`provider-${created.operation.id}`);
  expect(dispatches[0]?.kind).toBe("CREATE");
  expect(dispatches[0]?.binding.connectionRevision).toBe(1);
  expect((await service.create(request("create"))).state).toBe("DISPATCHED");
  expect(dispatches).toHaveLength(1);
  await service.reconcile();
  expect((await admission.getReservation(binding.id))?.computeState).toBe("RELEASED");
  setProvider("stopped", 1);
  const started = await service.start(request("start"));
  expect(started.state).toBe("DISPATCHED");
  expect(dispatches[1]?.payload).toEqual({ expectedGeneration: 1 });
  await service.reconcile();
  expect((await controller.getBinding(binding.id))?.observedState).toBe("RUNNING");
  setProvider("running", 2);
  const stopped = await service.stop(request("stop"));
  expect(stopped.kind).toBe("STOP");
  expect(dispatches[2]?.payload).toEqual({ expectedGeneration: 2 });
  await service.reconcile();
  expect((await admission.getReservation(binding.id))?.computeState).toBe("RELEASED");
  setProvider("stopped", 3);
  const destroyed = await service.destroy(request("destroy"));
  expect(destroyed.kind).toBe("DESTROY");
  await service.reconcile();
  expect((await admission.getReservation(binding.id))?.diskState).toBe("RELEASED");
  expect((await controller.getBinding(binding.id))?.cleanupConfirmedAt).toBeInstanceOf(Date);
}, DB_TEST_TIMEOUT_MS);

test("a missing or unfinished operation cannot be settled as complete", async () => {
  const { service, preset, configureAdmission } = await fixture();
  await expect(service.settleCompletedOperation("missing-operation"))
    .rejects.toThrow();
  const binding = await service.prepare({ projectId: "project", installationId: "installation",
    connectionId: "connection", presetId: preset.id });
  await configureAdmission();
  const operation = await service.create({ bindingId: binding.id,
    idempotencyScope: "feature", idempotencyKey: "pending-create" });
  expect(operation.state).toBe("DISPATCHED");
  if (operation.state !== "DISPATCHED") throw new Error("create was not dispatched");
  await expect(service.settleCompletedOperation(operation.operation.id)).rejects.toThrow();
}, DB_TEST_TIMEOUT_MS);

test("preparation fails closed without qualification or a matching connection revision", async () => {
  const { service, setQualification, connection } = await fixture();
  const input = { projectId: "project", installationId: "installation", connectionId: "connection", presetId: "incus-linux-exec-v1" };
  setQualification(false);
  await expect(service.prepare(input)).rejects.toThrow("qualification is unavailable");
  setQualification(true);
  connection.revokedAt = new Date();
  await expect(service.prepare(input)).rejects.toThrow("connection changed");
}, DB_TEST_TIMEOUT_MS);

test("expired qualification blocks new work but permits stop and destroy; destroy replay needs no inspection", async () => {
  const { service, admission, dispatches, preset, configureAdmission, setQualification,
    setProvider, setInspectUnavailable } = await fixture();
  const binding = await service.prepare({ projectId: "project", installationId: "installation",
    connectionId: "connection", presetId: preset.id });
  await configureAdmission();
  const request = (key: string) => ({ bindingId: binding.id, idempotencyScope: "feature", idempotencyKey: key });
  await service.create(request("create"));
  await service.reconcile();
  setProvider("stopped", 1);
  await service.start(request("start"));
  await service.reconcile();
  setProvider("running", 2);
  setQualification(false);
  await expect(service.start(request("another-start"))).rejects.toThrow("qualification is unavailable");
  const stopped = await service.stop(request("stop"));
  expect(stopped.kind).toBe("STOP");
  await service.reconcile();
  expect((await admission.getReservation(binding.id))?.computeState).toBe("RELEASED");
  setProvider("stopped", 3);
  const destroyed = await service.destroy(request("destroy"));
  expect(destroyed.kind).toBe("DESTROY");
  setInspectUnavailable(true);
  const replay = await service.destroy(request("destroy"));
  expect(replay.id).toBe(destroyed.id);
  expect(dispatches.filter(item => item.kind === "DESTROY")).toHaveLength(1);
}, DB_TEST_TIMEOUT_MS);

test("user project recovery preserves failed cleanup and charges until exact linked steps complete", async () => {
  const { db, service, controller, admission, dispatches, provider, connection, configureAdmission, preset, setProvider } = await fixture();
  await configureAdmission();
  const { project, binding } = await service.prepareProject({ name: "Recovered guest", ownerUserId: "admin",
    idempotencyKey: "user-recovery-project", installationId: "installation", connectionId: "connection", presetId: preset.id });
  expect(project.purpose).toBe("user");
  expect((await db.select().from(schema.projectMembers).where(eq(schema.projectMembers.projectId, project.id)))[0])
    .toMatchObject({ userId: "admin", role: "owner" });
  const request = (key: string) => ({ bindingId: binding.id, idempotencyScope: "user-recovery", idempotencyKey: key });
  await service.create(request("create"));
  await service.reconcile();
  await service.start(request("start"));
  await service.reconcile();
  setProvider("running", 2);
  const normalDispatch = provider.dispatch;
  let rejectLegacyDestroy = true;
  provider.dispatch = async input => {
    if (input.kind === "DESTROY" && rejectLegacyDestroy) {
      rejectLegacyDestroy = false;
      dispatches.push(input);
      return { outcome: "FAILED", errorCode: "REVISION_CONFLICT" };
    }
    return normalDispatch(input);
  };
  await admission.markCleanupIntent(binding.id, binding.generation, "legacy-user-cleanup");
  const failed = await controller.requestAndDispatch({ ...request("legacy-destroy"), generation: binding.generation,
    kind: "DESTROY", payload: { expectedGeneration: 2 } });
  expect(failed).toMatchObject({ state: "FAILED", errorCode: "REVISION_CONFLICT", providerOperationId: null });
  const before = await controller.getBinding(binding.id);
  const stop = await service.recoverCleanup(binding.id, failed.id);
  expect(stop.recovery.state).toBe("STOP_REQUIRED");
  expect(stop.operation).toMatchObject({ id: stop.recovery.stopOperationId, kind: "STOP", state: "PROVIDER_PENDING",
    requestPayload: { expectedGeneration: 2 } });
  expect(await controller.getOperation(failed.id)).toEqual(failed);
  expect(await admission.getReservation(binding.id)).toMatchObject({ computeState: "RELEASE_REQUESTED", diskState: "RELEASE_REQUESTED" });
  connection.revision = 2;
  await expect(service.recoverCleanup(binding.id, failed.id)).rejects.toThrow("connection changed");
  expect(dispatches.map(item => item.kind)).toEqual(["CREATE", "START", "DESTROY", "STOP"]);
  expect(await controller.getOperation(failed.id)).toEqual(failed);
  connection.revision = 1;
  setProvider("stopped", 3);
  const destroy = await service.recoverCleanup(binding.id, failed.id);
  expect(destroy.recovery).toMatchObject({ id: stop.recovery.id, state: "DESTROY_REQUIRED",
    failedDestroyOperationId: failed.id, stopOperationId: stop.recovery.stopOperationId });
  expect(destroy.operation).toMatchObject({ id: stop.recovery.destroyOperationId, kind: "DESTROY", state: "PROVIDER_PENDING",
    requestPayload: { expectedGeneration: 3 } });
  expect((await admission.getReservation(binding.id))?.diskState).toBe("RELEASE_REQUESTED");
  const complete = await service.recoverCleanup(binding.id, failed.id);
  expect(complete.recovery.state).toBe("COMPLETED");
  expect(await controller.getBinding(binding.id)).toMatchObject({ desiredState: "ABSENT", observedState: "ABSENT",
    generation: binding.generation, tombstonedAt: before!.tombstonedAt, currentOperationId: stop.recovery.destroyOperationId });
  expect(await admission.getReservation(binding.id)).toMatchObject({ computeState: "RELEASED", diskState: "RELEASED" });
  expect(await controller.getOperation(failed.id)).toEqual(failed);
  expect((await service.recoverCleanup(binding.id, failed.id)).recovery).toEqual(complete.recovery);
  expect(dispatches.map(item => item.kind)).toEqual(["CREATE", "START", "DESTROY", "STOP", "DESTROY"]);
  expect(await db.select().from(schema.sandboxCleanupRecoveries)).toHaveLength(1);
}, DB_TEST_TIMEOUT_MS);

test("linked destroy settled during recovery returns its exact completed receipt", async () => {
  const { db, service, controller, admission, dispatches, provider, preset, configureAdmission, setProvider } = await fixture();
  await configureAdmission();
  const { binding } = await service.prepareProject({ name: "Concurrent recovery", ownerUserId: "admin",
    idempotencyKey: "concurrent-recovery-project", installationId: "installation", connectionId: "connection", presetId: preset.id });
  const request = (key: string) => ({ bindingId: binding.id, idempotencyScope: "concurrent-recovery", idempotencyKey: key });
  await service.create(request("create"));
  await service.reconcile();
  await service.start(request("start"));
  await service.reconcile();
  setProvider("running", 2);
  const originalDispatch = provider.dispatch;
  provider.dispatch = async input => {
    if (input.kind === "DESTROY" && input.idempotency.scope === "concurrent-recovery") {
      dispatches.push(input);
      return { outcome: "FAILED", errorCode: "REVISION_CONFLICT" };
    }
    if (input.kind === "DESTROY" && input.idempotency.scope === "sandbox-cleanup-recovery") {
      dispatches.push(input);
      return { outcome: "SUCCEEDED", observedState: "ABSENT" };
    }
    return originalDispatch(input);
  };
  await admission.markCleanupIntent(binding.id, binding.generation, "failed-cleanup-intent");
  const failed = await controller.requestAndDispatch({ ...request("legacy-destroy"), generation: binding.generation,
    kind: "DESTROY", payload: { expectedGeneration: 2 } });
  expect(failed).toMatchObject({ state: "FAILED", errorCode: "REVISION_CONFLICT", providerOperationId: null });
  const stop = await service.recoverCleanup(binding.id, failed.id);
  expect(stop.recovery.state).toBe("STOP_REQUIRED");
  setProvider("stopped", 3);
  const execute = controller.executeOperation.bind(controller);
  controller.executeOperation = async operationId => {
    const operation = await execute(operationId);
    if (operation.kind === "DESTROY" && operation.state === "SUCCEEDED") {
      await service.settleCompletedOperation(operation.id);
    }
    return operation;
  };
  const result = await service.recoverCleanup(binding.id, failed.id);
  expect(result.operation).toMatchObject({ kind: "DESTROY", state: "SUCCEEDED" });
  expect(result.recovery).toMatchObject({ state: "COMPLETED", destroyOperationId: result.operation.id });
  expect(await admission.getReservation(binding.id)).toMatchObject({ computeState: "RELEASED", diskState: "RELEASED" });
  expect(dispatches.filter(item => item.kind === "DESTROY")).toHaveLength(2);
  expect((await service.recoverCleanup(binding.id, failed.id)).recovery).toEqual(result.recovery);
  const getBinding = controller.getBinding.bind(controller);
  let staleRead = true;
  controller.getBinding = async id => {
    const current = await getBinding(id);
    if (staleRead && current) {
      staleRead = false;
      return { ...current, cleanupConfirmedAt: null };
    }
    return current;
  };
  expect((await service.recoverCleanup(binding.id, failed.id)).recovery).toEqual(result.recovery);
  controller.getBinding = getBinding;
  await expect(service.recoverCleanup(binding.id, "unlinked-failure")).rejects.toMatchObject({ code: "CLEANUP_RECOVERY_UNAVAILABLE" });
  await db.update(schema.sandboxReservations).set({ generation: binding.generation + 1 })
    .where(eq(schema.sandboxReservations.bindingId, binding.id));
  await expect(service.recoverCleanup(binding.id, failed.id)).rejects.toMatchObject({ code: "CLEANUP_RECOVERY_UNAVAILABLE" });
  await db.update(schema.sandboxReservations).set({ generation: binding.generation })
    .where(eq(schema.sandboxReservations.bindingId, binding.id));
  await db.update(schema.sandboxReservations).set({ diskState: "RESERVED" }).where(eq(schema.sandboxReservations.bindingId, binding.id));
  await expect(service.recoverCleanup(binding.id, failed.id)).rejects.toMatchObject({ code: "CLEANUP_RECOVERY_UNAVAILABLE" });
  await db.update(schema.sandboxReservations).set({ diskState: "RELEASED" }).where(eq(schema.sandboxReservations.bindingId, binding.id));
  await db.update(schema.sandboxBindings).set({ currentOperationId: failed.id }).where(eq(schema.sandboxBindings.id, binding.id));
  await expect(service.recoverCleanup(binding.id, failed.id)).rejects.toMatchObject({ code: "CLEANUP_RECOVERY_UNAVAILABLE" });
}, DB_TEST_TIMEOUT_MS);

test("normal stopped project can recover a terminal native protected DELETE without erasing its receipt", async () => {
  const { db, service, controller, admission, provider, preset, configureAdmission, setProvider, connection } = await fixture();
  await configureAdmission();
  const { binding } = await service.prepareProject({ name: "Protected guest", ownerUserId: "admin",
    idempotencyKey: "protected-project", installationId: "installation", connectionId: "connection", presetId: preset.id });
  const request = (key: string) => ({ bindingId: binding.id, idempotencyScope: "protected-project", idempotencyKey: key });
  await service.create(request("create"));
  await service.reconcile();
  setProvider("stopped", 1);
  const certificates = makeTestCertificates();
  tlsFixtures.push(certificates);
  const serverCertificatePem = certificates.read("server-cert.pem");
  const sandboxName = resourceName("connection", binding.id);
  const nativeId = "33333333-3333-4333-8333-333333333333";
  const instance = { name: sandboxName, status: "Stopped", config: {
    "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection",
    "user.ezharness.sandbox_id": binding.id, "user.ezharness.generation": "1", "security.protection.delete": "true" } };
  const writes: string[] = [];
  const transport = new HostIncusLifecycleTransport({ resolveForHost: async () => ({ endpoint: "https://127.0.0.1:8443",
    serverCertificatePem, project: "sandbox", clientCertificatePem: certificates.read("client-cert.pem"), privateKeyPem: certificates.read("client-key.pem") }) },
  { providerInstallationId: "installation", providerReleaseId: "release", revision: 1, hostContractMinor: 1,
    approvedPreset: { profile: preset.profile, incusProfile: "ezharness", presetId: preset.id,
      presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64), imageFingerprint: preset.imageDigest, limits: preset.limits } },
  async (url, init) => {
    if (new URL(url).pathname.includes("/operations/")) return Response.json({ type: "sync", status_code: 200,
      metadata: { id: nativeId, class: "task", status: "Failure", status_code: 400, err: "Instance is protected",
        resources: { instances: [`/1.0/instances/${sandboxName}`] } } });
    if (init.method === "GET") return Response.json({ type: "sync", status_code: 200, metadata: instance }, { headers: { etag: '"protected"' } });
    writes.push(init.method!);
    if (init.method === "PATCH") {
      Object.assign(instance.config, JSON.parse(String(init.body)).config);
      setProvider("stopped", Number(instance.config["user.ezharness.generation"]));
      return Response.json({ type: "sync", status_code: 200, metadata: {} });
    }
    expect(init.method).toBe("DELETE");
    return Response.json({ type: "async", status_code: 100, operation: `/1.0/operations/${nativeId}`,
      metadata: { id: nativeId, class: "task", status: "Running", status_code: 103 } }, { status: 202 });
  });
  const dispatch = provider.dispatch;
  provider.dispatch = async input => {
    if (input.kind !== "DESTROY") return dispatch(input);
    const result = await transport.request({ action: "instance.destroy", connectionId: "connection", deadlineMs: Date.now() + 30_000,
      pins: { connectionId: "connection", project: "sandbox", profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox",
        serverCertificateSha256: createHash("sha256").update(new X509Certificate(serverCertificatePem).raw).digest("hex") },
      tags: { managedBy: "ezharness-incus-sandbox", connectionId: "connection", sandboxId: binding.id }, sandboxName,
      idempotency: { requestId: input.operationId, key: input.idempotency.key }, payload: { expectedGeneration: Number(input.payload.expectedGeneration) } }) as {
        receipt: { operationId: string; terminalObservation: SandboxOperationInspection } };
    return inspectedOutcome("DESTROY", result.receipt.operationId, result.receipt.terminalObservation);
  };
  const failed = await service.destroy(request("destroy"));
  expect(failed).toMatchObject({ kind: "DESTROY", state: "FAILED", errorCode: "INTERNAL",
    providerOperationId: "incus-destroy-33333333-3333-4333-8333-333333333333",
    requestPayload: { expectedGeneration: 1 } });
  expect(writes).toEqual(["PATCH", "DELETE"]);
  expect(instance.status).toBe("Stopped");
  expect(await admission.getReservation(binding.id)).toMatchObject({ diskState: "RELEASE_REQUESTED" });
  provider.dispatch = dispatch;
  for (const patch of [{ state: "OUTCOME_UNKNOWN" as const }, { providerOperationId: "ezh-destroy-stable" }]) {
    await db.update(schema.sandboxOperations).set(patch).where(eq(schema.sandboxOperations.id, failed.id));
    await expect(service.recoverCleanup(binding.id, failed.id)).rejects.toMatchObject({ code: "CLEANUP_RECOVERY_UNAVAILABLE" });
    expect(await db.select().from(schema.sandboxCleanupRecoveries)).toEqual([]);
    await db.update(schema.sandboxOperations).set(failed).where(eq(schema.sandboxOperations.id, failed.id));
  }
  for (const [state, generation] of [["running", 2], ["stopped", 1], ["stopped", 3]] as const) {
    setProvider(state, generation);
    await expect(service.recoverCleanup(binding.id, failed.id)).rejects.toThrow();
    expect(await db.select().from(schema.sandboxCleanupRecoveries)).toEqual([]);
  }
  setProvider("stopped", 2);
  connection.revision = 2;
  await expect(service.recoverCleanup(binding.id, failed.id)).rejects.toThrow("connection changed");
  connection.revision = 1;
  const recovered = await service.recoverCleanup(binding.id, failed.id);
  expect(recovered.operation).toMatchObject({ kind: "STOP", requestPayload: { expectedGeneration: 2 } });
  expect(await controller.getOperation(failed.id)).toEqual(failed);
  setProvider("stopped", 3);
  const destroyed = await service.recoverCleanup(binding.id, failed.id);
  expect(destroyed.operation).toMatchObject({ kind: "DESTROY", requestPayload: { expectedGeneration: 3 } });
  const complete = await service.recoverCleanup(binding.id, failed.id);
  expect(complete.recovery.state).toBe("COMPLETED");
  expect(await admission.getReservation(binding.id)).toMatchObject({ computeState: "RELEASED", diskState: "RELEASED" });
  expect(await controller.getOperation(failed.id)).toEqual(failed);
}, DB_TEST_TIMEOUT_MS);

test("retired destroy journals an exact stopped guest and replays without another readback", async () => {
  const { service, controller, admission, dispatches, preset, configureAdmission, retiredCalls } = await fixture();
  const binding = await service.prepare({ projectId: "project", installationId: "installation",
    connectionId: "connection", presetId: preset.id });
  await configureAdmission();
  const request = { bindingId: binding.id, idempotencyScope: "retired", idempotencyKey: "cleanup" };
  await service.create({ ...request, idempotencyKey: "create" });
  await service.reconcile();
  const destroyed = await service.destroyRetired(request);
  expect(destroyed.kind).toBe("DESTROY");
  expect(dispatches.at(-1)?.payload).toEqual({ expectedGeneration: 1 });
  expect(retiredCalls).toEqual(["lifecycle.inspect"]);
  expect((await controller.getBinding(binding.id))?.tombstonedAt).toBeInstanceOf(Date);
  expect((await service.destroyRetired(request)).id).toBe(destroyed.id);
  expect(retiredCalls).toHaveLength(1);
  await service.reconcile();
  expect((await admission.getReservation(binding.id))?.diskState).toBe("RELEASED");
}, DB_TEST_TIMEOUT_MS);

test("reservation settlement is bounded, fair after a bad row, and durable across polls", async () => {
  const { db, service, admission, preset } = await fixture();
  const capacity = { memoryBytes: 10, cpuMillicores: 10, pids: 10, diskBytes: 10, executionSlots: 10 };
  const zero = { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 };
  await admission.configureHostCapacity({ providerInstallationId: "installation", connectionId: "connection",
    allocatable: capacity, safetyMargin: zero });
  for (let index = 0; index < 5; index++) {
    const projectId = `settlement-project-${index}`;
    const bindingId = `settlement-binding-${index}`;
    const operationId = `settlement-operation-${index}`;
    await db.insert(schema.projects).values({ id: projectId, name: projectId, path: `/work/${projectId}` });
    await admission.configureProjectQuota({ projectId, providerInstallationId: "installation",
      connectionId: "connection", limit: capacity });
    await db.insert(schema.sandboxBindings).values({
      id: bindingId, projectId, providerInstallationId: "installation", providerReleaseId: "release",
      connectionId: "connection", connectionRevision: 1, profile: preset.profile,
      presetId: preset.id, presetDigest: "digest", effectiveSettingsDigest: "settings",
      resourceKey: bindingId, desiredState: "STOPPED", observedState: "STOPPED",
      generation: 1, currentOperationId: operationId,
    });
    await db.insert(schema.sandboxReservations).values({
      bindingId, projectId, providerInstallationId: "installation", connectionId: "connection", generation: 1,
      memoryBytes: 1, cpuMillicores: 1, pids: 1, diskBytes: 1, executionSlots: 1,
      computeState: index === 0 ? "RELEASE_REQUESTED" : "RESERVED", diskState: "RESERVED",
      stopIntentId: index === 0 ? "wrong-intent" : null,
    });
    await db.insert(schema.sandboxOperations).values({
      id: operationId, bindingId, kind: "CREATE", generation: 1,
      idempotencyScope: "settlement", idempotencyKey: String(index),
      payloadHash: "hash", requestPayload: {}, state: "SUCCEEDED",
    });
  }

  const released = async () => (await db.select().from(schema.sandboxReservations))
    .filter(row => row.computeState === "RELEASED").length;
  await expect(service.reconcile(2)).rejects.toThrow("Incus reservation settlement failed");
  expect(await released()).toBe(1);
  await service.reconcile(2);
  expect(await released()).toBe(3);
  await expect(service.reconcile(2)).rejects.toThrow("Incus reservation settlement failed");
  expect(await released()).toBe(4);
  await db.update(schema.sandboxReservations).set({ stopIntentId: null, computeState: "RESERVED" })
    .where(eq(schema.sandboxReservations.bindingId, "settlement-binding-0"));
  await service.reconcile(2);
  expect(await released()).toBe(5);
  // A later poll sees no unsettled receipt, even though all operations remain SUCCEEDED.
  await db.update(schema.sandboxReservations).set({ stopIntentId: "wrong-intent" })
    .where(eq(schema.sandboxReservations.bindingId, "settlement-binding-0"));
  await service.reconcile(2);
  expect((await admission.getReservation("settlement-binding-0"))?.computeState).toBe("RELEASED");
}, DB_TEST_TIMEOUT_MS);

async function addQualificationFixture(f: Awaited<ReturnType<typeof fixture>>, fixtureOperationId: string, bindingId: string) {
  const { db, preset } = f;
  const fixtureProjectId = `${bindingId}-project`;
  const presetDigest = await sandboxPresetDigest(preset);
  const effectiveSettingsDigest = digest({ presetDigest, connectionRevision: 1 });
  await db.insert(schema.projects).values({ id: fixtureProjectId, name: fixtureProjectId,
    purpose: "incus-qualification", path: "/__incus_qualification__/test" });
  await db.insert(schema.sandboxBindings).values({ id: bindingId, projectId: fixtureProjectId,
    providerInstallationId: "installation", providerReleaseId: "release", connectionId: "connection",
    connectionRevision: 1, profile: preset.profile, presetId: preset.id, presetDigest,
    effectiveSettingsDigest, resourceKey: bindingId, desiredState: "STOPPED", observedState: "STOPPED" });
  await db.insert(schema.incusQualificationFixtures).values({ operationId: fixtureOperationId,
    projectId: fixtureProjectId, bindingId, installationId: "installation", releaseId: "release",
    connectionId: "connection", connectionRevision: 1, presetId: preset.id, presetDigest,
    effectiveSettingsDigest });
  await db.insert(schema.sandboxReservations).values({ bindingId, projectId: fixtureProjectId,
    providerInstallationId: "installation", connectionId: "connection", generation: 1,
    memoryBytes: preset.limits.memoryBytes, cpuMillicores: preset.limits.cpuMillis,
    pids: preset.limits.pids, diskBytes: preset.limits.diskBytes, executionSlots: 1,
    computeState: "RELEASED", diskState: "RESERVED" });
}

test("early preview failure releases a failed terminal claim after two exact cleanups", async () => {
  const f = await fixture();
  const runId = "early-preview";
  const scope = { installationId: "installation", releaseId: "release", connectionId: "connection", presetId: f.preset.id };
  await f.configureAdmission();
  for (const kind of ["primary", "unrelated"]) {
    const operationId = `qual-${kind}-${runId}`;
    const bindingId = `${runId}-${kind}`;
    await addQualificationFixture(f, operationId, bindingId);
    await f.admission.markCleanupIntent(bindingId, 1, `incus-qualification-destroy-${operationId}`);
    await f.controller.requestAndDispatch({ bindingId, generation: 1, kind: "DESTROY",
      idempotencyScope: "incus-qualification", idempotencyKey: `${operationId}:destroy`, payload: { expectedGeneration: 1 } });
    await f.service.reconcile(100);
  }
  await addQualificationRuns(f.db); await completeQualificationRuns(f.db);
  const keys = generateKeyPairSync("ed25519"); const process = currentProcessIdentity();
  const before = {} as Parameters<typeof observationDigest>[0];
  const payload = { version: 1 as const, runId, nonce: "early-preview-nonce", scope,
    fixtureOperationId: `qual-primary-${runId}`, bindingId: `${runId}-primary`, generation: 1, connectionRevision: 1,
    deadlineMs: 1, lastOperationId: "saved-stop", oldProcess: { pid: 1, startTicks: "1" },
    newProcess: process, beforeDigest: observationDigest(before), afterDigest: "a".repeat(64) };
  const receipt = { payload, signature: sign(null, restartHandoffSigningBytes(payload), keys.privateKey).toString("base64") };
  await f.db.execute(sql`INSERT INTO incus_qualification_runs
    (run_id,nonce,scope,fixture_operation_id,binding_id,generation,connection_revision,last_operation_id,
     deadline_at,before_observation,before_digest,old_process_identity,state,receipt,claimed_at)
    VALUES (${runId},${payload.nonce},${JSON.stringify(scope)}::jsonb,${payload.fixtureOperationId},
      ${payload.bindingId},1,1,${payload.lastOperationId},${new Date(1)},${JSON.stringify(before)}::jsonb,
      ${payload.beforeDigest},${JSON.stringify(payload.oldProcess)}::jsonb,'FAILED',${JSON.stringify(receipt)}::jsonb,NOW())`);
  const checkpoint = new IncusQualificationCheckpointStore(f.db, keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  expect(await checkpoint.terminalAttestation()).toMatchObject({ runId, state: "FAILED" });
  await expect(f.service.assertTerminalRunCleanup(scope, runId, 1, "COMPLETED")).rejects.toThrow();
  const directory = await mkdtemp(join(tmpdir(), "incus-early-terminal-"));
  const socket = join(directory, "control.sock");
  const frames: unknown[] = [];
  const server = createServer(connection => {
    let data = "";
    connection.on("data", chunk => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      frames.push(JSON.parse(data));
      connection.end('{"released":true}\n');
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(socket, resolve));
    await releaseTerminalIncusQualification(f.db, { EZCORP_INCUS_SUPERVISOR_SOCKET: socket,
      EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY: keys.publicKey.export({ type: "spki", format: "pem" }).toString() });
    expect(frames).toEqual([{ version: 1, action: "terminal", ...(await checkpoint.terminalAttestation()) }]);
    expect(releaseRows<{ state: string }>(await f.db.execute(sql`SELECT state FROM incus_qualification_runs
      WHERE run_id = ${runId}`))).toEqual([{ state: "FAILED" }]);
    expect(releaseRows(await f.db.execute(sql`SELECT 1 FROM incus_live_qualifications
      WHERE installation_id = ${scope.installationId} AND connection_id = ${scope.connectionId}
        AND preset_id = ${scope.presetId}`))).toEqual([]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
  const recoveryOperationId = `qual-recovery-${runId}`;
  const identity = qualificationFixtureIdentity(scope, recoveryOperationId);
  const projectId = `incus-qual-project-${identity}`;
  await f.db.insert(schema.projects).values({ id: projectId, name: projectId,
    purpose: "incus-qualification", path: `/__incus_qualification__/${identity}` });
  await expect(checkpoint.terminalAttestation()).rejects.toThrow("cleanup is unverified");
  await f.db.delete(schema.projects).where(eq(schema.projects.id, projectId));
  const [primaryOperation] = await f.db.select().from(schema.sandboxOperations)
    .where(eq(schema.sandboxOperations.bindingId, `${runId}-primary`)).limit(1);
  if (!primaryOperation) throw new Error("Expected saved primary operation");
  const misplacedId = randomUUID();
  await f.db.insert(schema.sandboxOperations).values({ ...primaryOperation, id: misplacedId,
    kind: "CREATE", state: "SUCCEEDED", idempotencyKey: recoveryOperationId, providerOperationId: null });
  await expect(checkpoint.terminalAttestation()).rejects.toThrow("cleanup is unverified");
  await f.db.delete(schema.sandboxOperations).where(eq(schema.sandboxOperations.id, misplacedId));
  const misplacedAdmissionId = randomUUID();
  await f.db.insert(schema.sandboxAdmissionRequests).values({ id: misplacedAdmissionId,
    bindingId: `${runId}-primary`, generation: 1, kind: "CREATE",
    idempotencyScope: "incus-qualification", idempotencyKey: `${recoveryOperationId}:create`,
    payloadHash: "misplaced-recovery", memoryBytes: 1, cpuMillicores: 1, pids: 1, diskBytes: 1,
    executionSlots: 1, state: "ADMITTED" });
  await expect(checkpoint.terminalAttestation()).rejects.toThrow("cleanup is unverified");
  await f.db.delete(schema.sandboxAdmissionRequests).where(eq(schema.sandboxAdmissionRequests.id, misplacedAdmissionId));
  const bindingId = `incus-qual-binding-${identity}`;
  await addQualificationFixture(f, recoveryOperationId, bindingId);
  await f.controller.requestAndDispatch({ bindingId, generation: 1, kind: "CREATE",
    idempotencyScope: "incus-qualification", idempotencyKey: `${recoveryOperationId}:create`, payload: {} });
  await f.db.delete(schema.incusQualificationFixtures)
    .where(eq(schema.incusQualificationFixtures.operationId, recoveryOperationId));
  await expect(checkpoint.terminalAttestation()).rejects.toThrow("cleanup is unverified");
}, DB_TEST_TIMEOUT_MS);

async function qualificationFixture() {
  const f = await fixture();
  await f.configureAdmission();
  const fixtureOperationId = "qual-recovery-run-one";
  const bindingId = "qualification-binding";
  await addQualificationFixture(f, fixtureOperationId, bindingId);
  const input = { projectId: "project", installationId: "installation", connectionId: "connection", presetId: f.preset.id };
  return { ...f, fixtureOperationId, bindingId, input };
}

test("uncertain fixture destroy denies Ready until the original operation confirms absence and cleanup settles", async () => {
  const { db, service, controller, admission, bindingId, fixtureOperationId, input } = await qualificationFixture();
  await service.prepare(input);
  await admission.markCleanupIntent(bindingId, 1, `incus-qualification-destroy-${fixtureOperationId}`);
  const destroy = await controller.requestAndDispatch({ bindingId, generation: 1,
    idempotencyScope: "incus-qualification", idempotencyKey: `${fixtureOperationId}:destroy`,
    kind: "DESTROY", payload: { expectedGeneration: 1 } });
  expect(destroy.state).toBe("PROVIDER_PENDING");
  await db.update(schema.sandboxOperations).set({ state: "OUTCOME_UNKNOWN" })
    .where(eq(schema.sandboxOperations.id, destroy.id));
  const savedFixtureDestroy = await controller.getOperation(destroy.id);
  const savedFixtureBinding = await controller.getBinding(bindingId);
  await expect(service.recoverCleanup(bindingId, destroy.id)).rejects.toThrow("feature binding is unavailable");
  expect(await controller.getOperation(destroy.id)).toEqual(savedFixtureDestroy);
  expect(await controller.getBinding(bindingId)).toEqual(savedFixtureBinding);
  expect(await db.select().from(schema.sandboxCleanupRecoveries)).toEqual([]);
  await expect(service.prepare(input)).rejects.toMatchObject({ code: "QUALIFICATION_CLEANUP_UNVERIFIED" });

  // Reconciliation inspects the same operation. A provider absence receipt by
  // itself is insufficient: the retained disk still needs its cleanup intent.
  await service.reconcile();
  expect((await controller.getOperation(destroy.id))?.state).toBe("OUTCOME_UNKNOWN");
  await controller.reconcile(1, destroy.id);
  expect((await controller.getOperation(destroy.id))?.state).toBe("SUCCEEDED");
  expect((await controller.getBinding(bindingId))?.cleanupConfirmedAt).toBeInstanceOf(Date);
  expect((await admission.getReservation(bindingId))?.diskState).toBe("RELEASE_REQUESTED");
  await expect(service.prepare(input)).rejects.toMatchObject({ code: "QUALIFICATION_CLEANUP_UNVERIFIED" });
  await service.reconcile();
  expect((await admission.getReservation(bindingId))?.diskState).toBe("RELEASE_REQUESTED");
  await service.reconcile(1, destroy.id);
  expect((await admission.getReservation(bindingId))?.diskState).toBe("RELEASED");
  expect((await controller.getOperation(destroy.id))?.id).toBe(destroy.id);
  await db.update(schema.sandboxBindings).set({ cleanupConfirmedAt: null })
    .where(eq(schema.sandboxBindings.id, bindingId));
  await expect(service.prepare(input)).rejects.toMatchObject({ code: "QUALIFICATION_CLEANUP_UNVERIFIED" });
  await db.update(schema.sandboxBindings).set({ cleanupConfirmedAt: new Date() })
    .where(eq(schema.sandboxBindings.id, bindingId));
  expect(await service.prepare(input)).toMatchObject({ projectId: "project" });
}, DB_TEST_TIMEOUT_MS);

 test("completed exact linked recovery clears fixture readiness while retaining the failed receipt", async () => {
  const { db, service, controller, admission, provider, setProvider, serviceDependencies, connection, bindingId, fixtureOperationId, input } = await qualificationFixture();
  setProvider("running", 2);
  await db.update(schema.sandboxBindings).set({ desiredState: "RUNNING", observedState: "RUNNING" }).where(eq(schema.sandboxBindings.id,bindingId));
  const dispatch = provider.dispatch;
  provider.dispatch = async request => request.kind === "DESTROY" ? { outcome: "FAILED", errorCode: "REVISION_CONFLICT" } : dispatch(request);
  await admission.markCleanupIntent(bindingId,1,`incus-qualification-destroy-${fixtureOperationId}`);
  const failed = await controller.requestAndDispatch({ bindingId,generation:1,kind:"DESTROY",idempotencyScope:"incus-qualification",idempotencyKey:`${fixtureOperationId}:destroy`,payload:{expectedGeneration:2} });
  provider.dispatch = dispatch;
  expect(failed.state).toBe("FAILED");
  const recovery = new IncusCleanupRecoveryService(db,controller,admission,async () => {},serviceDependencies.inspect!,serviceDependencies.now!);
  await recovery.recover(bindingId,failed.id);
  setProvider("stopped",3);
  await recovery.recover(bindingId,failed.id);
  const completed = await recovery.recover(bindingId,failed.id);
  expect(completed.recovery.state).toBe("COMPLETED");
  expect(await controller.getOperation(failed.id)).toEqual(failed);
  await service.checkReadiness(input);
  const beforeDispatches = (await db.select().from(schema.sandboxOperations)).length;
  const deny = () => expect(service.checkReadiness(input)).rejects.toMatchObject({ code: "QUALIFICATION_CLEANUP_UNVERIFIED" });
  const recoveryPatches: Partial<schema.SandboxCleanupRecovery>[] = [{ state: "STOP_REQUIRED" }, { state: "DESTROY_REQUIRED" },
    { generation: 2 }, { connectionRevision: 2 }, { releaseId: "foreign" }, { installationId: "foreign" },
    { connectionId: "foreign" }, { providerResourceId: "foreign" }, { providerGeneration: 1 },
    { stopOperationId: "foreign" }, { destroyOperationId: "foreign" }];
  for (const patch of recoveryPatches) {
    await db.update(schema.sandboxCleanupRecoveries).set(patch).where(eq(schema.sandboxCleanupRecoveries.id,completed.recovery.id));
    await deny();
    await db.update(schema.sandboxCleanupRecoveries).set(completed.recovery).where(eq(schema.sandboxCleanupRecoveries.id,completed.recovery.id));
  }
  for (const id of [completed.recovery.stopOperationId, completed.recovery.destroyOperationId]) {
    const saved = (await controller.getOperation(id))!;
    for (const patch of [{ state: "OUTCOME_UNKNOWN" as const }, { providerOperationId: null }, { kind: "START" as const }, { generation: 2 },
      { idempotencyScope: "unlinked" }, { idempotencyKey: "unlinked" }, { requestPayload: { expectedGeneration: 99 } },
      { requestPayload: { ...saved.requestPayload, extra: true } }]) {
      await db.update(schema.sandboxOperations).set(patch).where(eq(schema.sandboxOperations.id,id));
      await deny();
      await db.update(schema.sandboxOperations).set(saved).where(eq(schema.sandboxOperations.id,id));
    }
  }
  for (const patch of [{ state: "SUCCEEDED" as const }, { errorCode: "INTERNAL" }, { providerOperationId: "forged" },
    { idempotencyScope: "unlinked" }, { idempotencyKey: "unlinked" }, { requestPayload: { expectedGeneration: 99 } }]) {
    await db.update(schema.sandboxOperations).set(patch).where(eq(schema.sandboxOperations.id,failed.id));
    await deny();
    await db.update(schema.sandboxOperations).set(failed).where(eq(schema.sandboxOperations.id,failed.id));
  }
  const reservation = (await admission.getReservation(bindingId))!;
  for (const patch of [{ diskState: "RELEASE_REQUESTED" as const }, { computeState: "RELEASE_REQUESTED" as const },
    { cleanupIntentId: "unlinked" }, { generation: 2 }]) {
    await db.update(schema.sandboxReservations).set(patch).where(eq(schema.sandboxReservations.bindingId,bindingId));
    await deny();
    await db.update(schema.sandboxReservations).set(reservation).where(eq(schema.sandboxReservations.bindingId,bindingId));
  }
  connection.revokedAt = new Date();
  await expect(service.checkReadiness(input)).rejects.toThrow("connection changed");
  connection.revokedAt = null;
  const unrelated = { ...completed.operation, id: crypto.randomUUID(), idempotencyScope:"unlinked", idempotencyKey:"unlinked" };
  await db.insert(schema.sandboxOperations).values(unrelated);
  await deny();
  await db.delete(schema.sandboxOperations).where(eq(schema.sandboxOperations.id,unrelated.id));
  await db.update(schema.sandboxBindings).set({currentOperationId:completed.recovery.destroyOperationId}).where(eq(schema.sandboxBindings.id,bindingId));
  await service.checkReadiness(input);
  expect((await db.select().from(schema.sandboxOperations)).length).toBe(beforeDispatches);
  expect(await controller.getOperation(failed.id)).toEqual(failed);
}, DB_TEST_TIMEOUT_MS);

 test("terminal host proof requires all three exact cleaned fixtures and released accounting", async () => {
  const f = await fixture();
  const scope = { installationId: "installation", releaseId: "release", connectionId: "connection", presetId: f.preset.id };
  await f.configureAdmission();
  await expect(f.service.assertTerminalRunCleanup(scope, "terminal", 1)).rejects.toThrow();
  const ids: string[] = [];
  for (const kind of ["primary", "unrelated", "recovery"]) {
    const op = `qual-${kind}-terminal`; const bindingId = `terminal-${kind}`; ids.push(bindingId);
    await addQualificationFixture(f, op, bindingId);
    await f.admission.markCleanupIntent(bindingId, 1, `incus-qualification-destroy-${op}`);
    const destroy = await f.controller.requestAndDispatch({ bindingId, generation: 1, kind: "DESTROY",
      idempotencyScope: "incus-qualification", idempotencyKey: `${op}:destroy`, payload: { expectedGeneration: 1 } });
    await expect(f.service.assertTerminalRunCleanup(scope, "terminal", 1)).rejects.toThrow();
    await f.service.reconcile(100, kind === "recovery" ? destroy.id : undefined);
  }
  await f.service.assertTerminalRunCleanup(scope, "terminal", 1);
  await addQualificationRuns(f.db); await completeQualificationRuns(f.db);
  const keys = generateKeyPairSync("ed25519"); const process = currentProcessIdentity();
  const before = {} as Parameters<typeof observationDigest>[0];
  const payload = { version: 1 as const, runId: "terminal", nonce: "terminal-nonce", scope,
    fixtureOperationId: "qual-primary-terminal", bindingId: ids[0]!, generation: 1, connectionRevision: 1,
    deadlineMs: 1, lastOperationId: "saved-stop", oldProcess: { pid: 1, startTicks: "1" },
    newProcess: process, beforeDigest: observationDigest(before), afterDigest: "a".repeat(64) };
  const receipt = { payload, signature: sign(null, restartHandoffSigningBytes(payload), keys.privateKey).toString("base64") };
  await f.db.execute(sql`INSERT INTO incus_qualification_runs
    (run_id,nonce,scope,fixture_operation_id,binding_id,generation,connection_revision,last_operation_id,
     deadline_at,before_observation,before_digest,old_process_identity,state,receipt,claimed_at)
    VALUES (${payload.runId},${payload.nonce},${JSON.stringify(scope)}::jsonb,${payload.fixtureOperationId},
      ${payload.bindingId},1,1,${payload.lastOperationId},${new Date(1)},${JSON.stringify(before)}::jsonb,
      ${payload.beforeDigest},${JSON.stringify(payload.oldProcess)}::jsonb,'COMPLETED',${JSON.stringify(receipt)}::jsonb,NOW())`);
  const checkpoints = new IncusQualificationCheckpointStore(f.db, keys.publicKey.export({type:"spki",format:"pem"}).toString());
  const attestation = await checkpoints.terminalAttestation();
  if (!attestation) throw new Error("Expected the terminal host attestation");
  expect(attestation).toEqual({ runId: "terminal", nonce: "terminal-nonce", scope, connectionRevision: 1,
    state: "COMPLETED", process, claimedProcess: process });
  await f.db.execute(sql`UPDATE incus_qualification_runs SET state = 'CLAIMED'`);
  expect(await checkpoints.terminalAttestation()).toBeNull();
  await f.db.execute(sql`UPDATE incus_qualification_runs SET state = 'FAILED'`);
  expect((await checkpoints.terminalAttestation())?.state).toBe("FAILED");
  await f.db.execute(sql`UPDATE incus_qualification_runs SET nonce = 'forged'`);
  await expect(checkpoints.terminalAttestation()).rejects.toThrow("receipt changed");
  await f.db.execute(sql`UPDATE incus_qualification_runs SET nonce = 'terminal-nonce'`);
  await expect(f.service.assertTerminalRunCleanup({ ...scope, connectionId: "foreign" }, "terminal", 1)).rejects.toThrow();
  await expect(f.service.assertTerminalRunCleanup(scope, "terminal", 2)).rejects.toThrow();
  await f.db.update(schema.sandboxReservations).set({ diskState: "RELEASE_REQUESTED" }).where(eq(schema.sandboxReservations.bindingId, ids[0]!));
  await expect(f.service.assertTerminalRunCleanup(scope, "terminal", 1)).rejects.toThrow();
  await f.db.update(schema.sandboxReservations).set({ diskState: "RELEASED" }).where(eq(schema.sandboxReservations.bindingId, ids[0]!));
  await f.db.update(schema.sandboxBindings).set({ observedState: "RUNNING" }).where(eq(schema.sandboxBindings.id, ids[0]!));
  await expect(f.service.assertTerminalRunCleanup(scope, "terminal", 1)).rejects.toThrow();
  await f.db.update(schema.sandboxBindings).set({ observedState: "ABSENT" }).where(eq(schema.sandboxBindings.id, ids[0]!));
  const binding = (await f.controller.getBinding(ids[0]!))!;
  const original = (await f.controller.getOperation(binding.currentOperationId!))!;
  const outstandingId = crypto.randomUUID();
  await f.db.insert(schema.sandboxOperations).values({ ...original, id: outstandingId,
    idempotencyScope: "unsettled-terminal-test", idempotencyKey: outstandingId, state: "OUTCOME_UNKNOWN" });
  await expect(f.service.assertTerminalRunCleanup(scope, "terminal", 1)).rejects.toThrow();
  await f.db.delete(schema.sandboxOperations).where(eq(schema.sandboxOperations.id, outstandingId));
  const client = databases.pop()!; const saved = await client.dumpDataDir(); await client.close();
  const reopened = new PGlite({ loadDataDir: saved }); databases.push(reopened); await reopened.waitReady;
  const reopenedStore = new IncusQualificationCheckpointStore(drizzle(reopened, { schema }), keys.publicKey.export({type:"spki",format:"pem"}).toString());
  expect(await reopenedStore.terminalAttestation()).toEqual({ ...attestation, state: "FAILED" });
  const reopenedDb = drizzle(reopened, { schema });
  const root = await mkdtemp(join(tmpdir(), "incus-terminal-db-"));
  const socket = join(root, "control.sock");
  const frames: unknown[] = [];
  let released = true;
  const server = createServer(connection => {
    let data = "";
    connection.on("data", chunk => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      frames.push(JSON.parse(data));
      connection.end(`${JSON.stringify({ released })}\n`);
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(socket, resolve));
    const env = { EZCORP_INCUS_SUPERVISOR_SOCKET: socket,
      EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
    await releaseTerminalIncusQualification(reopenedDb, {});
    await reopenedDb.execute(sql`UPDATE incus_qualification_runs SET state = 'CLAIMED'`);
    await releaseTerminalIncusQualification(reopenedDb, env);
    expect(frames).toEqual([]);
    await reopenedDb.execute(sql`UPDATE incus_qualification_runs SET state = 'FAILED'`);
    await releaseTerminalIncusQualification(reopenedDb, env);
    expect(frames).toEqual([{ version: 1, action: "terminal", ...attestation, state: "FAILED" }]);
    expect(JSON.stringify(frames)).not.toContain("reconcileOrder");
    expect(JSON.stringify(frames)).not.toContain("requestPayload");
    released = false;
    await expect(releaseTerminalIncusQualification(reopenedDb, env)).rejects.toThrow("not released");
    expect(frames).toHaveLength(2);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, DB_TEST_TIMEOUT_MS);

test("daily admission uses unchanged baseline and read-only readiness after full receipt expiry", async () => {
  const f = await fixture(); await f.configureAdmission();
  const { IncusAdmissionReadinessService } = await import("./incus-admission-readiness");
  const { up: addReadiness } = await import("../db/migrations/add-incus-admission-readiness");
  const { admissionObservation } = await import("./__tests__/incus-admission-observation");
  await addReadiness(f.db);
  const scope = { installationId: "installation", releaseId: "release", connectionId: "connection", presetId: f.preset.id };
  const original = (await f.serviceDependencies.loadQualification(scope))!;
  f.connection.serverCertificatePem = await Bun.file(new URL("./incus-transport/test-server.pem", import.meta.url)).text();
  let now = f.serviceDependencies.now!();
  let reads = 0;
  const presetDigest = await sandboxPresetDigest(f.preset);
  const qualifications = { authorizeFixture: async () => ({ snapshot: { ...await f.serviceDependencies.activeRelease!("installation"),
    installation: { ...(await f.serviceDependencies.activeRelease!("installation")).installation, generation: 1 } },
    connection: f.connection, preset: f.preset, presetDigest,
    effectiveSettingsDigest: original.effectiveSettingsDigest, helperDigest: "a".repeat(64) }),
    loadBaselineProof: async () => original };
  const readiness = new IncusAdmissionReadinessService(f.db, qualifications, { now: () => now,
    assertCurrentScope: f.serviceDependencies.assertCurrentScope,
    read: async pin => { reads++; return admissionObservation(pin, now); } });
  await readiness.capture(scope, "daily-run");
  await readiness.recordBaseline(await readiness.prepareBaseline(scope, "daily-run", original));
  const service = new IncusFeatureService({ ...f.serviceDependencies, now: () => now,
    admissionReadiness: readiness, loadQualification: async () => null });
  now = Date.parse(original.validUntil) + 3_600_000;
  const before = reads;
  const binding = await service.prepare({ projectId: "project", ...scope });
  const effect = await service.create({ bindingId: binding.id, idempotencyScope: "daily", idempotencyKey: "create" });
  expect(effect.state).toBe("DISPATCHED");
  expect(f.dispatches).toHaveLength(1);
  expect(f.dispatches[0]!.kind).toBe("CREATE");
  expect(reads - before).toBe(2);
  await service.reconcile();
  expect((await service.start({ bindingId: binding.id, idempotencyScope: "daily", idempotencyKey: "start" })).state)
    .toBe("DISPATCHED");
  await service.reconcile();
  const second = await service.prepareProject({ name: "Second daily guest", ownerUserId: "admin",
    idempotencyKey: "second-daily-project", installationId: "installation",
    connectionId: "connection", presetId: f.preset.id });
  expect((await service.create({ bindingId: second.binding.id, idempotencyScope: "daily",
    idempotencyKey: "second-create" })).state).toBe("DISPATCHED");
  expect(f.dispatches.map(item => item.kind)).toEqual(["CREATE", "START", "CREATE"]);
  expect(original.validUntil).toBe("2026-09-23T11:00:00Z");
  const [baseline] = releaseRows<{ proofDigest: string }>(await f.db.execute(sql`SELECT proof_digest AS "proofDigest" FROM incus_admission_baselines`));
  expect(baseline!.proofDigest).toBe(digest(original));
  expect(await f.db.select().from(schema.incusQualificationFixtures)).toEqual([]);
}, DB_TEST_TIMEOUT_MS);
