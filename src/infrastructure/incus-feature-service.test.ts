import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import { up as addQualificationFixtures } from "../db/migrations/add-incus-qualification-fixtures";
import * as schema from "../db/schema";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { SandboxController, type SandboxProviderDispatcher, type SandboxProviderRequest, type SandboxProviderOutcome } from "../sandboxes/controller";
import { incusManifest, INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { digest } from "../../scripts/incus/model";
import type { ProviderConnectionCredentials } from "./provider-connections/store";
import { IncusFeatureService } from "./incus-feature-service";

const databases: PGlite[] = [];
// Each case starts and migrates a fresh PGlite database. In the combined
// Incus suite that work can exceed Bun's five-second default before assertions run.
const DB_TEST_TIMEOUT_MS = 30_000;

async function fixture() {
  const pglite = new PGlite();
  databases.push(pglite);
  await pglite.waitReady;
  await pglite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const db = drizzle(pglite, { schema });
  await addSandboxController(db);
  await addQualificationFixtures(db);
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
  const service = new IncusFeatureService({
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
  });
  const configureAdmission = async () => {
    await admission.configureHostCapacity({ providerInstallationId: "installation", connectionId: "connection",
      allocatable: { memoryBytes: 2 * preset.limits.memoryBytes, cpuMillicores: 2 * preset.limits.cpuMillis,
        pids: 2 * preset.limits.pids, diskBytes: 2 * preset.limits.diskBytes, executionSlots: 2 },
      safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 } });
    await admission.configureProjectQuota({ projectId: "project", providerInstallationId: "installation", connectionId: "connection",
      limit: { memoryBytes: preset.limits.memoryBytes, cpuMillicores: preset.limits.cpuMillis,
        pids: preset.limits.pids, diskBytes: preset.limits.diskBytes, executionSlots: 1 } });
  };
  return { db, service, controller, admission, dispatches, connection, setQualification: (value: boolean) => { qualificationAvailable = value; },
    setProvider: (state: "running" | "stopped", generation: number) => { providerState = state; providerGeneration = generation; },
    setInspectUnavailable: (value: boolean) => { inspectUnavailable = value; }, configureAdmission, preset, retiredCalls };
}

afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.close())); });

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

test("prepare, create, start, stop and destroy use durable admission and provider receipts", async () => {
  const { service, controller, admission, dispatches, setProvider, preset, configureAdmission } = await fixture();
  const binding = await service.prepare({ projectId: "project", installationId: "installation", connectionId: "connection", presetId: preset.id });
  expect(binding.resourceKey).toBe(binding.id);
  await configureAdmission();
  const request = (key: string) => ({ bindingId: binding.id, idempotencyScope: "feature", idempotencyKey: key });
  const created = await service.create(request("create"));
  expect(created.state).toBe("DISPATCHED");
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

test("uncertain fixture destroy denies Ready until the original operation confirms absence and cleanup settles", async () => {
  const { db, service, controller, admission, preset, configureAdmission } = await fixture();
  await configureAdmission();
  const presetDigest = await sandboxPresetDigest(preset);
  const effectiveSettingsDigest = digest({ presetDigest, connectionRevision: 1 });
  const fixtureOperationId = "qualification-fixture";
  const bindingId = "qualification-binding";
  const fixtureProjectId = "qualification-project";
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
  const input = { projectId: "project", installationId: "installation", connectionId: "connection",
    presetId: preset.id };
  await service.prepare(input);
  await admission.markCleanupIntent(bindingId, 1, `incus-qualification-destroy-${fixtureOperationId}`);
  const destroy = await controller.requestAndDispatch({ bindingId, generation: 1,
    idempotencyScope: "incus-qualification", idempotencyKey: `${fixtureOperationId}:destroy`,
    kind: "DESTROY", payload: { expectedGeneration: 1 } });
  expect(destroy.state).toBe("PROVIDER_PENDING");
  await db.update(schema.sandboxOperations).set({ state: "OUTCOME_UNKNOWN" })
    .where(eq(schema.sandboxOperations.id, destroy.id));
  await expect(service.prepare(input)).rejects.toMatchObject({ code: "QUALIFICATION_CLEANUP_UNVERIFIED" });

  // Reconciliation inspects the same operation. A provider absence receipt by
  // itself is insufficient: the retained disk still needs its cleanup intent.
  await controller.reconcile();
  expect((await controller.getOperation(destroy.id))?.state).toBe("SUCCEEDED");
  expect((await controller.getBinding(bindingId))?.cleanupConfirmedAt).toBeInstanceOf(Date);
  expect((await admission.getReservation(bindingId))?.diskState).toBe("RELEASE_REQUESTED");
  await expect(service.prepare(input)).rejects.toMatchObject({ code: "QUALIFICATION_CLEANUP_UNVERIFIED" });
  await service.reconcile();
  expect((await admission.getReservation(bindingId))?.diskState).toBe("RELEASED");
  expect((await controller.getOperation(destroy.id))?.id).toBe(destroy.id);
  await db.update(schema.sandboxBindings).set({ cleanupConfirmedAt: null })
    .where(eq(schema.sandboxBindings.id, bindingId));
  await expect(service.prepare(input)).rejects.toMatchObject({ code: "QUALIFICATION_CLEANUP_UNVERIFIED" });
  await db.update(schema.sandboxBindings).set({ cleanupConfirmedAt: new Date() })
    .where(eq(schema.sandboxBindings.id, bindingId));
  expect(await service.prepare(input)).toMatchObject({ projectId: "project" });
}, DB_TEST_TIMEOUT_MS);
