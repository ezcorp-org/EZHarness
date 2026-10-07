import { up as addFencedCleanupRecoveries } from "../db/migrations/add-incus-fenced-cleanup-recoveries";
import { afterEach, expect, spyOn, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { sandboxPresetDigest, type SandboxPreset } from "@ezcorp/extension-contract";
import { incusOperatorFaultAuthority } from "../extensions/extension-lifecycle-service";
import { releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
import { incusManifest, INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { digest } from "../../scripts/incus/model";
import { up as addController } from "../db/migrations/add-sandbox-controller";
import { up as addQualificationFixtures } from "../db/migrations/add-incus-qualification-fixtures";
import * as schema from "../db/schema";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { SandboxController, type SandboxProviderRequest, type SandboxProviderOutcome } from "../sandboxes/controller";
import { IncusHostLiveWitness } from "./incus-host-live-witness";
import { resourceName } from "./incus-transport/lifecycle";
import { observeFailedCleanupRecovery } from "./incus-live-recovery-probes";
import { IncusLiveCleanupController } from "./incus-live-cleanup-controller";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { up as addQualificationRuns } from "../db/migrations/add-incus-qualification-runs";
import { IncusQualificationCheckpointStore, currentProcessIdentity, observationDigest, processIdentityKey, restartHandoffSigningBytes, type RestartHandoffPayload } from "./incus-qualification-checkpoint";
import { IncusFeatureService } from "./incus-feature-service";
import { HostIncusLostDestroyReplyFault } from "./incus-destroy-reply-fault";
import { IncusQualificationOperationUnsettledError, IncusQualificationFixtureService, type IncusQualificationScope, type IncusQualificationStore } from "./incus-qualification";

const opened: PGlite[] = [];
const scope: IncusQualificationScope = { installationId: "installation", releaseId: "release",
  connectionId: "connection", presetId: INCUS_PRESETS[0]!.id };
const assertCurrentScope = async () => {};

async function setup(configureHost = true, pendingCreate = false, providerGeneration = 1,
  inspectError: Error | null = null, hostSlots = 2,
  options: { destroyEffect?: (request: SandboxProviderRequest) => Promise<void> | Promise<SandboxProviderOutcome>; enforcePowerGeneration?: boolean; refuseRunningDestroy?: boolean; pendingKinds?: string[]; inspectOutcome?: "UNKNOWN" | "PENDING"; inspectUnknownCount?: number; inspectFailureCount?: number; inspectTerminalFailure?: boolean; missingStartReceipt?: boolean; missingStopReceipt?: boolean; now?: () => number; preset?: SandboxPreset; qualificationOwnerId?: string } = {}) {
  const client = new PGlite();
  opened.push(client);
  await client.waitReady;
  await client.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await client.exec("CREATE TABLE extension_release_installations (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
  await client.exec("CREATE TABLE project_workspace_bindings (project_id TEXT PRIMARY KEY, kind TEXT NOT NULL, binding_id TEXT, revision INTEGER NOT NULL, state TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await client.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), onboarded_at TIMESTAMPTZ)");
  await client.exec("CREATE TABLE project_members (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await client.exec("CREATE TABLE provider_connections (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, provider_installation_id TEXT NOT NULL, provider_release_id TEXT NOT NULL, endpoint TEXT NOT NULL, server_certificate_pem TEXT NOT NULL, project TEXT NOT NULL, configuration JSONB, client_certificate_pem TEXT NOT NULL, private_key_ciphertext TEXT NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const db = drizzle(client, { schema });
  await addController(db);
  await addFencedCleanupRecoveries(db);
  await addQualificationFixtures(db);
  await addQualificationFixtures(db);
  await db.insert(schema.providerConnections).values({ id: scope.connectionId, revision: 1,
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    endpoint: "https://127.0.0.1", serverCertificatePem: "cert", project: "sandbox",
    clientCertificatePem: "client", privateKeyCiphertext: "ciphertext" });
  const preset = options.preset ?? INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const effectiveSettingsDigest = digest({ presetDigest, connectionRevision: 1 });
  const qualifications = { authorizeFixture: async () => ({
    snapshot: { installation: { generation: 2 }, release: { releaseDigest: "fixture-release" } },
    connection: { revision: 1 }, preset,
    presetDigest, effectiveSettingsDigest }) } as unknown as IncusQualificationStore;
  const dispatches: SandboxProviderRequest[] = [];
  const inspections: Array<SandboxProviderRequest & { providerOperationId: string | null }> = [];
  let providerState: "running" | "stopped" = "stopped";
  const controller = new SandboxController(db, { dispatch: async request => {
    dispatches.push(request);
    if (request.kind === "DESTROY") {
      const injected = await options.destroyEffect?.(request);
      if (injected) return injected;
    }
    if (options.refuseRunningDestroy && request.kind === "DESTROY" && providerState === "running") {
      return { outcome: "FAILED", errorCode: "REVISION_CONFLICT" };
    }
    if (options.enforcePowerGeneration && (request.kind === "START" || request.kind === "STOP")) providerGeneration++;
    if (options.missingStartReceipt && request.kind === "START" || options.missingStopReceipt && request.kind === "STOP") return { outcome: "UNKNOWN" };
    if (pendingCreate && request.kind === "CREATE" || options.pendingKinds?.includes(request.kind)) {
      return { outcome: "PENDING", providerOperationId: `provider-${request.operationId}` };
    }
    providerState = request.kind === "START" ? "running" : "stopped";
    return { outcome: "SUCCEEDED", observedState: request.kind === "DESTROY" ? "ABSENT"
      : request.kind === "START" ? "RUNNING" : "STOPPED" };
  }, inspectOperation: async request => {
    inspections.push(request);
    if (options.inspectTerminalFailure) return { outcome: "FAILED", errorCode: "TERMINAL_TEST_FAILURE" };
    if (inspections.length <= (options.inspectFailureCount ?? 0)) throw new Error("readback response temporarily unavailable");
    if (options.inspectOutcome === "PENDING") {
      if (!request.providerOperationId) throw new Error("Pending test operation lacks its provider identity");
      return { outcome: "PENDING", providerOperationId: request.providerOperationId };
    }
    if (options.inspectOutcome === "UNKNOWN" || inspections.length <= (options.inspectUnknownCount ?? 0)) return { outcome: "UNKNOWN", providerOperationId: request.providerOperationId ?? undefined };
    providerState = request.kind === "START" ? "running" : "stopped";
    return { outcome: "SUCCEEDED", providerOperationId: request.providerOperationId ?? undefined,
      observedState: request.kind === "DESTROY" ? "ABSENT" : request.kind === "START" ? "RUNNING" : "STOPPED" };
  } });
  const admission = new SandboxAdmissionStore(db);
  if (configureHost) await admission.configureHostCapacity({ providerInstallationId: scope.installationId,
    connectionId: scope.connectionId,
    allocatable: { memoryBytes: hostSlots * preset.limits.memoryBytes,
      cpuMillicores: hostSlots * preset.limits.cpuMillis,
      pids: hostSlots * preset.limits.pids, diskBytes: hostSlots * preset.limits.diskBytes,
      executionSlots: hostSlots },
    safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 },
  });
  const fixtureServiceDeps = { db, qualifications, admission, controller, now: options.now,
    qualificationOwnerId: options.qualificationOwnerId,
    assertCurrentScope,
    inspect: async (_installationId: string, _bindingId: string, input: Record<string, unknown>) => {
      if (inspectError) throw inspectError;
      return { ok: true, sandbox: { sandboxId: input.sandboxId,
      profile: preset.profile,
      presetId: preset.id, desiredState: providerState, observedState: providerState,
      generation: providerGeneration, bootId: null, observedAt: new Date().toISOString() } };
    } };
  const service = new IncusQualificationFixtureService(fixtureServiceDeps);
  return { db, service, fixtureServiceDeps, dispatches, inspections, controller, admission, qualifications, presetDigest, effectiveSettingsDigest };
}

afterEach(async () => { await Promise.all(opened.splice(0).map(client => client.close())); });

test("the default scope guard denies create before any provider effect when approval is absent", async () => {
  const { db, admission, controller, qualifications, dispatches } = await setup();
  const guarded = new IncusQualificationFixtureService({ db, admission, controller, qualifications });
  await expect(guarded.create(scope, "guarded-create"))
    .rejects.toThrow("Provider release is not active and approved");
  expect(dispatches).toHaveLength(0);
  expect(await db.select().from(schema.projects)).toHaveLength(0);
  expect(await db.select().from(schema.sandboxBindings)).toHaveLength(0);
});

test("Compose fixture binds the initiating active admin through restart and rejects an owner swap", async () => {
  const compose = INCUS_PRESETS[1]!;
  const composeScope = { ...scope, presetId: compose.id };
  const missing = await setup(true, false, 1, null, 2, { preset: compose });
  await expect(missing.service.create(composeScope, "compose-without-owner"))
    .rejects.toThrow("Interactive qualification owner is unavailable");
  expect(missing.dispatches).toHaveLength(0);
  expect(await missing.db.select().from(schema.incusQualificationFixtures)).toHaveLength(0);

  const { db, service, dispatches } = await setup(true, false, 1, null, 2,
    { preset: compose, qualificationOwnerId: "admin-one" });
  await db.insert(schema.users).values({ id: "admin-one", email: "admin@example.test",
    passwordHash: "test", name: "Admin", role: "admin", status: "active" });
  const first = await service.create(composeScope, "compose-owned");
  expect(first.state).toBe("SUCCEEDED");
  const [fixture] = await db.select().from(schema.incusQualificationFixtures);
  expect(fixture?.ownerUserId).toBe("admin-one");
  const [member] = await db.select().from(schema.projectMembers);
  expect(member).toMatchObject({ projectId: fixture?.projectId, userId: "admin-one", role: "owner" });
  expect((await service.create(composeScope, "compose-owned")).id).toBe(first.id);
  await db.update(schema.users).set({ status: "inactive" }).where(eq(schema.users.id, "admin-one"));
  await expect(service.create(composeScope, "compose-owned"))
    .rejects.toThrow("not an active admin");
  await db.update(schema.users).set({ status: "active" }).where(eq(schema.users.id, "admin-one"));
  await db.delete(schema.projectMembers).where(eq(schema.projectMembers.projectId, fixture!.projectId));
  await db.insert(schema.projectMembers).values({ projectId: fixture!.projectId,
    userId: "admin-two", role: "owner" });
  await expect(service.create(composeScope, "compose-owned"))
    .rejects.toThrow("Interactive qualification owner changed");
  expect(dispatches).toHaveLength(1);
});

test("fixture migration adds the durable owner column to an existing table", async () => {
  const { db } = await setup();
  await db.execute(sql`ALTER TABLE incus_qualification_fixtures DROP COLUMN owner_user_id`);
  await addQualificationFixtures(db);
  await addQualificationFixtures(db);
  const rows = await db.execute(sql`SELECT owner_user_id FROM incus_qualification_fixtures`);
  expect(rows.rows).toEqual([]);
});

test("host fixture create and destroy use admission and durable controller without a user workspace binding", async () => {
  const { db, service, dispatches, controller, admission, presetDigest, effectiveSettingsDigest } = await setup();
  const created = await service.create(scope, "fixture-1");
  expect(created.state).toBe("SUCCEEDED");
  expect((await service.create(scope, "fixture-1")).id).toBe(created.id);
  expect(dispatches).toHaveLength(1);
  const [fixture] = await db.select().from(schema.incusQualificationFixtures);
  expect(fixture).toMatchObject({ operationId: "fixture-1", ...scope,
    connectionRevision: 1, presetDigest, effectiveSettingsDigest });
  const [project] = await db.select().from(schema.projects);
  expect(project).toMatchObject({ id: fixture!.projectId, purpose: "incus-qualification" });
  expect(dispatches[0]?.binding).toMatchObject({ id: fixture!.bindingId, projectId: fixture!.projectId,
    connectionRevision: 1, presetDigest, effectiveSettingsDigest });
  expect(await db.select().from(schema.projectWorkspaceBindings)).toEqual([]);
  expect((await admission.getReservation(fixture!.bindingId))?.diskState).toBe("RESERVED");
  expect((await controller.getBinding(fixture!.bindingId))?.observedState).toBe("STOPPED");
  const features = new IncusFeatureService({ db, controller, admission, loadQualification: async () => null });
  await expect(features.prepare({ projectId: fixture!.projectId, installationId: scope.installationId,
    connectionId: scope.connectionId, presetId: scope.presetId })).rejects.toThrow("feature project is unavailable");
  const featureRequest = { bindingId: fixture!.bindingId, idempotencyScope: "feature", idempotencyKey: "attempt" };
  for (const action of [() => features.create(featureRequest), () => features.start(featureRequest),
    () => features.stop(featureRequest), () => features.destroy(featureRequest),
    () => features.destroyRetired(featureRequest)]) {
    await expect(action()).rejects.toThrow("feature binding is unavailable");
  }

  const destroyed = await service.destroy(scope, "fixture-1");
  expect(destroyed.state).toBe("SUCCEEDED");
  expect((await service.destroy(scope, "fixture-1")).id).toBe(destroyed.id);
  expect(dispatches.map(item => item.kind)).toEqual(["CREATE", "DESTROY"]);
  expect((await admission.getReservation(fixture!.bindingId))?.diskState).toBe("RELEASED");
  expect((await controller.getBinding(fixture!.bindingId))?.observedState).toBe("ABSENT");
  await expect(db.delete(schema.projects).where(eq(schema.projects.id, fixture!.projectId)).execute())
    .rejects.toThrow();
});

test("host fault destroy journals and arms the exact operation before dispatch", async () => {
  const { db, service, dispatches } = await setup();
  await service.create(scope, "fixture-fault");
  const [fixture] = await db.select().from(schema.incusQualificationFixtures);
  const armed = { operationId: "" };
  const fault = { arm: async (input: { destroyOperationId: string; fixtureOperationId: string; bindingId: string }) => {
    const [journal] = await db.select().from(schema.sandboxOperations)
      .where(eq(schema.sandboxOperations.id, input.destroyOperationId)).limit(1);
    const [reservation] = await db.select().from(schema.sandboxReservations)
      .where(eq(schema.sandboxReservations.bindingId, input.bindingId)).limit(1);
    expect(input.fixtureOperationId).toBe("fixture-fault");
    expect(input.bindingId).toBe(fixture!.bindingId);
    expect(input.destroyOperationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(journal).toBeUndefined();
    expect(reservation?.cleanupIntentId).toBeNull();
    expect(dispatches).toHaveLength(1);
    armed.operationId = input.destroyOperationId;
  }, assertArmedFor: async (input: { destroyOperationId: string; bindingId: string }) => {
    const [reservation] = await db.select().from(schema.sandboxReservations)
      .where(eq(schema.sandboxReservations.bindingId, input.bindingId)).limit(1);
    expect(input.destroyOperationId).toBe(armed.operationId);
    expect(reservation?.cleanupIntentId).toBe("incus-qualification-destroy-fixture-fault");
    expect((await db.select().from(schema.sandboxOperations))
      .filter(operation => operation.kind === "DESTROY")).toEqual([]);
  } } as unknown as HostIncusLostDestroyReplyFault;
  const destroyed = await service.destroyWithLostReplyFault(scope, "fixture-fault",
    { runId: "run-a", nonce: "nonce-a", deadlineMs: Date.now() + 30_000 }, fault);
  expect(destroyed.id).toBe(armed.operationId);
  expect(dispatches[1]?.operationId).toBe(armed.operationId);
  await expect(service.destroyWithLostReplyFault(scope, "fixture-fault",
    { runId: "run-a", nonce: "nonce-b", deadlineMs: Date.now() + 30_000 }, fault)).rejects.toThrow("fresh operation");
});

test("denied or stale operator fault authority cannot leave a destroy for reconciliation", async () => {
  for (const denial of ["peer", "run", "revoked-connection"] as const) {
    const { db, service, controller, dispatches } = await setup();
    const fixtureOperationId = `fixture-denied-${denial}`;
    await service.create(scope, fixtureOperationId);
    const [fixture] = await db.select().from(schema.incusQualificationFixtures)
      .where(eq(schema.incusQualificationFixtures.operationId, fixtureOperationId)).limit(1);
    if (denial === "revoked-connection") await db.update(schema.providerConnections)
      .set({ revokedAt: new Date() }).where(eq(schema.providerConnections.id, scope.connectionId));
    const fault = new HostIncusLostDestroyReplyFault(db, {
      authenticateOperator: async () => { if (denial === "peer") throw new Error("operator peer denied"); },
      authorizeRun: async () => { if (denial === "run") throw new Error("operator run denied"); },
      authorizeReadback: async () => { throw new Error("unexpected readback"); },
    });
    await expect(service.destroyWithLostReplyFault(scope, fixtureOperationId,
      { runId: "run-a", nonce: "nonce-a", deadlineMs: Date.now() + 30_000 }, fault)).rejects.toThrow();
    const before = await controller.getBinding(fixture!.bindingId);
    expect(before).toMatchObject({ desiredState: "STOPPED", observedState: "STOPPED" });
    expect((await db.select().from(schema.sandboxOperations))
      .filter(operation => operation.bindingId === fixture!.bindingId && operation.kind === "DESTROY")).toEqual([]);
    const [reservation] = await db.select().from(schema.sandboxReservations)
      .where(eq(schema.sandboxReservations.bindingId, fixture!.bindingId)).limit(1);
    expect(reservation?.cleanupIntentId).toBeNull();
    await controller.reconcile();
    expect(await controller.getBinding(fixture!.bindingId)).toMatchObject({ desiredState: "STOPPED", observedState: "STOPPED" });
    expect(dispatches).toHaveLength(1);
  }
});

test("expiry after cleanup intent keeps the obligation but cannot journal or reconcile destroy", async () => {
  const { db, service, controller, admission, dispatches } = await setup();
  await service.create(scope, "fixture-late-expiry");
  await service.create(scope, "fixture-unrelated-stopped");
  const beforeUnrelated = await service.status(scope, "fixture-unrelated-stopped");
  const [fixture] = await db.select().from(schema.incusQualificationFixtures)
    .where(eq(schema.incusQualificationFixtures.operationId, "fixture-late-expiry")).limit(1);
  let clockNow = Date.now();
  const deadlineMs = clockNow + 30_000;
  const originalMark = admission.markCleanupIntent.bind(admission);
  admission.markCleanupIntent = async (...args) => {
    const result = await originalMark(...args);
    clockNow = deadlineMs + 1;
    return result;
  };
  const fault = new HostIncusLostDestroyReplyFault(db, {
    authenticateOperator: async () => {},
    authorizeRun: async () => { if (clockNow >= deadlineMs) throw new Error("operator run expired"); },
    authorizeReadback: async () => { throw new Error("unexpected readback"); },
  }, () => clockNow);
  await expect(service.destroyWithLostReplyFault(scope, "fixture-late-expiry",
    { runId: "run-a", nonce: "nonce-a", deadlineMs }, fault)).rejects.toThrow();
  const [reservation] = await db.select().from(schema.sandboxReservations)
    .where(eq(schema.sandboxReservations.bindingId, fixture!.bindingId)).limit(1);
  expect(reservation?.cleanupIntentId).toBe("incus-qualification-destroy-fixture-late-expiry");
  expect(reservation?.diskState).toBe("RELEASE_REQUESTED");
  expect((await db.select().from(schema.sandboxOperations))
    .filter(operation => operation.bindingId === fixture!.bindingId && operation.kind === "DESTROY")).toEqual([]);
  expect(await controller.getBinding(fixture!.bindingId))
    .toMatchObject({ desiredState: "STOPPED", observedState: "STOPPED" });
  await controller.reconcile();
  expect(await controller.getBinding(fixture!.bindingId))
    .toMatchObject({ desiredState: "STOPPED", observedState: "STOPPED" });
  expect(await service.status(scope, "fixture-unrelated-stopped")).toEqual(beforeUnrelated);
  expect(dispatches).toHaveLength(2);
});

test("missing host capacity and reused fixture identity fail closed", async () => {
  const { service, dispatches, db } = await setup(false);
  await expect(service.create(scope, "fixture-2")).rejects.toThrow("Host capacity must be configured first");
  expect(dispatches).toEqual([]);
  expect(await db.select().from(schema.incusQualificationFixtures)).toEqual([]);
  expect(await db.select().from(schema.sandboxBindings)).toEqual([]);
  expect(await db.select().from(schema.projects)).toEqual([]);
  await expect(service.create({ ...scope, connectionId: "other" }, "fixture-2"))
    .rejects.toThrow("Host capacity must be configured first");
  await expect(service.destroy({ ...scope, connectionId: "other" }, "fixture-2"))
    .rejects.toThrow("fixture is unavailable");
});

test("missing published setup and inactive release deny creation before provider dispatch", async () => {
  const { service, qualifications, dispatches, db } = await setup();
  qualifications.authorizeFixture = async () => { throw new Error("Incus qualification image is unpublished"); };
  await expect(service.create(scope, "fixture-no-setup")).rejects.toThrow("image is unpublished");
  qualifications.authorizeFixture = async () => { throw new Error("Incus qualification release is unavailable"); };
  await expect(service.create(scope, "fixture-inactive")).rejects.toThrow("release is unavailable");
  expect(dispatches).toEqual([]);
  expect(await db.select().from(schema.incusQualificationFixtures)).toEqual([]);
});

test("an uncertain create remains journaled and replays one provider operation", async () => {
  const { service, controller, dispatches, db } = await setup(true, true);
  const first = await service.create(scope, "fixture-pending");
  expect(first.state).toBe("PROVIDER_PENDING");
  expect((await service.create(scope, "fixture-pending")).id).toBe(first.id);
  expect(dispatches).toHaveLength(1);
  const [fixture] = await db.select().from(schema.incusQualificationFixtures);
  expect((await controller.getBinding(fixture!.bindingId))?.observedState).toBe("UNKNOWN");
  await controller.reconcile();
  expect((await controller.getOperation(first.id))?.state).toBe("SUCCEEDED");
  expect((await controller.getBinding(fixture!.bindingId))?.observedState).toBe("STOPPED");
});

test("destroy refuses a binding whose pinned provider scope changed", async () => {
  const { service, db, dispatches } = await setup();
  await service.create(scope, "fixture-tampered");
  const [fixture] = await db.select().from(schema.incusQualificationFixtures);
  await db.update(schema.sandboxBindings).set({ connectionId: "other" })
    .where(eq(schema.sandboxBindings.id, fixture!.bindingId));
  await expect(service.destroy(scope, "fixture-tampered"))
    .rejects.toThrow("fixture binding changed");
  expect(dispatches).toHaveLength(1);
});

test("concurrent create calls with one operation identity replay one fixture", async () => {
  const { service, db, dispatches } = await setup();
  const [first, replay] = await Promise.all([
    service.create(scope, "fixture-concurrent"), service.create(scope, "fixture-concurrent"),
  ]);
  expect(replay.id).toBe(first.id);
  expect(dispatches).toHaveLength(1);
  expect(await db.select().from(schema.incusQualificationFixtures)).toHaveLength(1);
});

test("two service instances replay one fixture after concurrent create", async () => {
  const { service, db, admission, qualifications, controller, dispatches } = await setup();
  const otherService = new IncusQualificationFixtureService({ db, admission, qualifications, controller,
    assertCurrentScope });
  const [first, replay] = await Promise.all([
    service.create(scope, "fixture-two-services"), otherService.create(scope, "fixture-two-services"),
  ]);
  expect(replay.id).toBe(first.id);
  expect(dispatches).toHaveLength(1);
  expect(await db.select().from(schema.incusQualificationFixtures)).toHaveLength(1);
});

test("destroy uses the inspected provider generation after guest power changes", async () => {
  const { service, dispatches } = await setup(true, false, 7);
  await service.create(scope, "fixture-power-generation");
  const destroyed = await service.destroy(scope, "fixture-power-generation");
  expect(destroyed.state).toBe("SUCCEEDED");
  expect(dispatches[1]?.generation).toBe(1);
  expect(dispatches[1]?.payload).toEqual({ expectedGeneration: 7 });
});

test("fixture status stays in exact scope and exposes safe durable state", async () => {
  const { service } = await setup();
  await service.create(scope, "fixture-status");
  const status = await service.status(scope, "fixture-status");
  expect(status.fixture).toMatchObject({ operationId: "fixture-status", ...scope });
  expect(status.binding).toMatchObject({ observedState: "STOPPED" });
  expect(status.operation).toMatchObject({ kind: "CREATE", state: "SUCCEEDED" });
  expect(JSON.stringify(status)).not.toContain("requestPayload");
  await expect(service.status({ ...scope, connectionId: "other" }, "fixture-status"))
    .rejects.toThrow("fixture is unavailable");
});

test("fixture status follows controller sequence when create, start, and stop share a timestamp", async () => {
  const { db, service } = await setup();
  const created = await service.create(scope, "fixture-order");
  const started = await service.setPower(scope, "fixture-order", "running", "order-start");
  const stopped = await service.setPower(scope, "fixture-order", "stopped", "order-stop");
  const sameTime = new Date("2026-09-23T00:00:00.000Z");
  for (const [id, replacement] of [[created.id, "z-create"], [started.id, "y-start"],
    [stopped.id, "a-stop"]] as const) {
    await db.update(schema.sandboxOperations).set({ id: replacement, createdAt: sameTime })
      .where(eq(schema.sandboxOperations.id, id));
  }
  expect((await service.status(scope, "fixture-order")).operation).toMatchObject({ id: "a-stop",
    kind: "STOP", state: "SUCCEEDED" });
}, 30_000);

test("fixture power uses inspected generation, durable idempotency, and exact ownership", async () => {
  const { service, dispatches, db } = await setup(true, false, 7);
  await service.create(scope, "fixture-power");
  const started = await service.setPower(scope, "fixture-power", "running", "power-start");
  expect(started.state).toBe("SUCCEEDED");
  expect((await service.setPower(scope, "fixture-power", "running", "power-start")).id).toBe(started.id);
  expect(dispatches[1]).toMatchObject({ kind: "START", payload: { expectedGeneration: 7 } });
  const stopped = await service.setPower(scope, "fixture-power", "stopped", "power-stop");
  expect(stopped.state).toBe("SUCCEEDED");
  expect((await service.status(scope, "fixture-power")).binding.observedState).toBe("STOPPED");
  expect(dispatches.map(item => item.kind)).toEqual(["CREATE", "START", "STOP"]);
  await expect(service.setPower({ ...scope, connectionId: "other" }, "fixture-power", "running", "other"))
    .rejects.toThrow("fixture is unavailable");
  await expect(service.setPower(scope, "fixture-power", "running", "power-stop"))
    .rejects.toThrow("power identity changed");
  const [fixture] = await db.select().from(schema.incusQualificationFixtures);
  await db.update(schema.sandboxBindings).set({ connectionId: "other" })
    .where(eq(schema.sandboxBindings.id, fixture!.bindingId));
  await expect(service.setPower(scope, "fixture-power", "stopped", "another-stop"))
    .rejects.toThrow("fixture binding changed");
  expect(dispatches).toHaveLength(3);
});

test("non-unique database errors are not treated as concurrent create replay", async () => {
  const { service, db, dispatches } = await setup();
  const databaseFailure = Object.assign(new Error("storage unavailable"), { code: "XX000" });
  Object.defineProperty(db, "transaction", { value: async () => { throw databaseFailure; } });
  await expect(service.create(scope, "fixture-db-error")).rejects.toBe(databaseFailure);
  expect(dispatches).toEqual([]);
});

test("destroy denies cleanup when provider generation cannot be read", async () => {
  const { service, dispatches } = await setup(true, false, 1, new Error("provider readback unavailable"));
  await service.create(scope, "fixture-no-readback");
  await expect(service.destroy(scope, "fixture-no-readback"))
    .rejects.toThrow("provider readback unavailable");
  expect(dispatches.map(item => item.kind)).toEqual(["CREATE"]);
});

test("queued admission removes only the never-admitted fixture", async () => {
  const { service, db, dispatches } = await setup(true, false, 1, null, 1);
  await service.create(scope, "fixture-reserved");
  await expect(service.create(scope, "fixture-queued"))
    .rejects.toThrow("admission QUEUED");
  const fixtures = await db.select().from(schema.incusQualificationFixtures);
  expect(fixtures.map(item => item.operationId)).toEqual(["fixture-reserved"]);
  expect(await db.select().from(schema.sandboxAdmissionRequests)).toHaveLength(1);
  expect(await db.select().from(schema.projects)).toHaveLength(1);
  expect(dispatches).toHaveLength(1);
});

test("recovery cannot delete an admitted fixture or race an active create", async () => {
  const { service, db } = await setup();
  const [create, cancel] = await Promise.allSettled([
    service.create(scope, "fixture-cancel-race"),
    service.cancelNeverAdmitted(scope, "fixture-cancel-race"),
  ]);
  expect(create.status).toBe("fulfilled");
  expect(cancel.status).toBe("rejected");
  expect(await db.select().from(schema.incusQualificationFixtures)).toHaveLength(1);
  await expect(service.cancelNeverAdmitted(scope, "fixture-cancel-race"))
    .rejects.toThrow("may have a provider effect");
});

test("a second service can cancel before admission without allowing a provider effect", async () => {
  const { db, admission, qualifications, controller, dispatches } = await setup();
  let entered!: () => void;
  let resume!: () => void;
  const atAdmission = new Promise<void>(resolve => { entered = resolve; });
  const continueAdmission = new Promise<void>(resolve => { resume = resolve; });
  const delayedAdmission = new SandboxAdmissionStore(db);
  const requestAdmission = delayedAdmission.requestAdmission.bind(delayedAdmission);
  delayedAdmission.requestAdmission = async input => {
    entered();
    await continueAdmission;
    return requestAdmission(input);
  };
  const creatingService = new IncusQualificationFixtureService({ db, admission: delayedAdmission,
    assertCurrentScope,
    qualifications, controller });
  const recoveringService = new IncusQualificationFixtureService({ db, admission,
    assertCurrentScope,
    qualifications, controller });
  const creation = creatingService.create(scope, "fixture-cross-process-cancel");
  await atAdmission;
  let cancelledBeforeResume = false;
  try {
    cancelledBeforeResume = await Promise.race([
      recoveringService.cancelNeverAdmitted(scope, "fixture-cross-process-cancel"),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 1_000)),
    ]);
  } finally {
    resume();
  }
  await expect(creation).rejects.toThrow("does not exist");
  expect(cancelledBeforeResume).toBe(true);
  expect(dispatches).toEqual([]);
  expect(await db.select().from(schema.incusQualificationFixtures)).toEqual([]);
  expect(await db.select().from(schema.sandboxBindings)).toEqual([]);
  expect(await db.select().from(schema.projects)).toEqual([]);
});

test("a second service cannot cancel after admission commits but before create dispatches", async () => {
  const { db, admission, qualifications, controller, dispatches } = await setup();
  let entered!: () => void;
  let resume!: () => void;
  const afterAdmission = new Promise<void>(resolve => { entered = resolve; });
  const continueCreate = new Promise<void>(resolve => { resume = resolve; });
  const delayedAdmission = new SandboxAdmissionStore(db);
  const requestAdmission = delayedAdmission.requestAdmission.bind(delayedAdmission);
  delayedAdmission.requestAdmission = async input => {
    const result = await requestAdmission(input);
    entered();
    await continueCreate;
    return result;
  };
  const creatingService = new IncusQualificationFixtureService({ db, admission: delayedAdmission,
    assertCurrentScope,
    qualifications, controller });
  const recoveringService = new IncusQualificationFixtureService({ db, admission,
    assertCurrentScope,
    qualifications, controller });
  const creation = creatingService.create(scope, "fixture-cross-process-admitted");
  await afterAdmission;
  let cancellationError: unknown;
  try {
    cancellationError = await Promise.race([
      recoveringService.cancelNeverAdmitted(scope, "fixture-cross-process-admitted")
        .then(() => null, error => error),
      new Promise<Error>(resolve => setTimeout(() => resolve(new Error("cancellation blocked")), 1_000)),
    ]);
  } finally {
    resume();
  }
  expect(cancellationError).toBeInstanceOf(Error);
  expect((cancellationError as Error).message).toContain("may have a provider effect");
  expect((await creation).state).toBe("SUCCEEDED");
  expect(dispatches).toHaveLength(1);
  expect(await db.select().from(schema.incusQualificationFixtures)).toHaveLength(1);
  expect(await db.select().from(schema.sandboxReservations)).toHaveLength(1);
});

test("a lost admission reply retains possible provider effects for recovery", async () => {
  const { db, admission, qualifications, controller, dispatches } = await setup();
  const lostReply = Object.create(admission) as SandboxAdmissionStore;
  lostReply.requestAdmission = async input => {
    await admission.requestAdmission(input);
    throw new Error("admission reply lost");
  };
  const service = new IncusQualificationFixtureService({ db, admission: lostReply, qualifications, controller,
    assertCurrentScope });
  await expect(service.create(scope, "fixture-unknown-admission"))
    .rejects.toThrow("admission and cleanup failed");
  expect(await db.select().from(schema.incusQualificationFixtures)).toHaveLength(1);
  expect(await db.select().from(schema.sandboxReservations)).toHaveLength(1);
  expect(dispatches).toEqual([]);
});

test("operator recovery removes an old never-admitted fixture with exact scope", async () => {
  const { db, service, presetDigest, effectiveSettingsDigest } = await setup(false);
  await db.insert(schema.projects).values({ id: "orphan-project", name: "orphan",
    path: "/__incus_qualification__/orphan", purpose: "incus-qualification" });
  await db.insert(schema.sandboxBindings).values({ id: "orphan-binding", projectId: "orphan-project",
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    connectionId: scope.connectionId, connectionRevision: 1, resourceKey: "orphan-binding",
    profile: INCUS_PRESETS[0]!.profile, presetId: scope.presetId, presetDigest,
    effectiveSettingsDigest, desiredState: "STOPPED", observedState: "UNKNOWN" });
  await db.insert(schema.incusQualificationFixtures).values({ operationId: "fixture-old",
    projectId: "orphan-project", bindingId: "orphan-binding", installationId: scope.installationId,
    releaseId: scope.releaseId, connectionId: scope.connectionId, connectionRevision: 1,
    presetId: scope.presetId, presetDigest, effectiveSettingsDigest });
  await expect(service.cancelNeverAdmitted({ ...scope, connectionId: "other" }, "fixture-old"))
    .rejects.toThrow("changed scope");
  expect(await service.cancelNeverAdmitted(scope, "fixture-old")).toBe(true);
  expect(await service.cancelNeverAdmitted(scope, "fixture-old")).toBe(false);
  expect(await db.select().from(schema.projects)).toEqual([]);
  expect(await db.select().from(schema.sandboxBindings)).toEqual([]);
  expect(await db.select().from(schema.incusQualificationFixtures)).toEqual([]);
});


test("live witness reconciles the same pending CREATE before treating its dropped reply as failure", async () => {
  const { db, service, qualifications, dispatches } = await setup(true, true);
  const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
  const handle = await witness.createFixture(scope, INCUS_PRESETS[0]!, "live-pending-create", true);
  expect(handle.operationId).toBe("live-pending-create");
  expect(dispatches.map(request => request.kind)).toEqual(["CREATE"]);
  const saved = await service.status(scope, "live-pending-create");
  expect(saved.operation).toMatchObject({ kind: "CREATE", state: "SUCCEEDED" });
  expect(saved.binding).toMatchObject({ desiredState: "STOPPED", observedState: "STOPPED" });
});


test("pending native fixture power and destroy settle their exact saved operations", async () => {
  const { db, service, qualifications, dispatches, admission } = await setup(true, false, 1, null, 2,
    { pendingKinds: ["START", "STOP", "DESTROY"] });
  const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
  const handle = await witness.createFixture(scope, INCUS_PRESETS[0]!, "pending-power", false);
  await witness.setPower(handle, "running");
  expect((await service.status(scope, handle.operationId)).binding.observedState).toBe("RUNNING");
  await witness.setPower(handle, "stopped");
  expect((await admission.getReservation(handle.sandboxId))?.computeState).toBe("RELEASED");
  await witness.destroyFixture(handle);
  expect(dispatches.map(request => request.kind)).toEqual(["CREATE", "START", "STOP", "DESTROY"]);
  expect(await admission.getReservation(handle.sandboxId)).toMatchObject({ computeState: "RELEASED", diskState: "RELEASED" });
});

test("unknown CREATE preserves its original effect and never queues cleanup or recreation", async () => {
  const { db, service, qualifications, dispatches, admission } = await setup(true, true, 1, null, 2,
    { inspectOutcome: "UNKNOWN", now: (() => { const times = [0, 0, 0, 30_000]; return () => times.shift() ?? 30_000; })() });
  const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
  await expect(witness.createFixture(scope, INCUS_PRESETS[0]!, "unknown-create", true))
    .rejects.toBeInstanceOf(IncusQualificationOperationUnsettledError);
  expect(dispatches.map(request => request.kind)).toEqual(["CREATE"]);
  const saved = await service.status(scope, "unknown-create");
  expect(saved.operation).toMatchObject({ kind: "CREATE", state: "OUTCOME_UNKNOWN" });
  expect(await db.select().from(schema.sandboxOperations)).toHaveLength(1);
  expect(await admission.getReservation(saved.fixture.bindingId)).toMatchObject({ computeState: "RESERVED", diskState: "RESERVED" });
});

test("bounded pending observation preserves receipt, scope and reservations", async () => {
  const clockSamples = [0, 0, 0, 30_000];
  const { db, service, qualifications, dispatches, inspections } = await setup(true, true, 1, null, 2,
    { inspectOutcome: "PENDING", now: () => clockSamples.shift() ?? 30_000 });
  const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
  await expect(witness.createFixture(scope, INCUS_PRESETS[0]!, "bounded-pending", false))
    .rejects.toBeInstanceOf(IncusQualificationOperationUnsettledError);
  const saved = await service.status(scope, "bounded-pending");
  expect(saved.operation?.state).toBe("PROVIDER_PENDING");
  expect(inspections).toHaveLength(1);
  expect(dispatches.map(request => request.kind)).toEqual(["CREATE"]);
  await expect(service.waitForOperation({ ...scope, connectionId: "foreign" }, "bounded-pending", saved.operation!.id))
    .rejects.toMatchObject({ reason: "authority_changed", operationId: saved.operation!.id,
      cause: expect.objectContaining({ message: expect.stringContaining("fixture is unavailable") }) });
  await expect(service.waitForOperation(scope, "bounded-pending", "foreign-operation"))
    .rejects.toThrow("saved operation changed scope");
});

test("settling prior CREATE preserves newer queued destroy and unrelated work until absence is proven", async () => {
  const { db, service, controller, admission, dispatches } = await setup(true, true);
  const created = await service.create(scope, "paired-create");
  const unrelated = await service.create(scope, "unrelated-pending");
  const original = (await service.status(scope, "paired-create")).fixture;
  expect((await service.destroy(scope, "paired-create")).state).toBe("JOURNALED");
  const [destroy] = await db.select().from(schema.sandboxOperations).where(eq(schema.sandboxOperations.kind, "DESTROY"));
  const beforeBinding = await controller.getBinding(original.bindingId);
  const beforeReservation = await admission.getReservation(original.bindingId);
  const beforeUnrelated = await controller.getOperation(unrelated.id);
  expect(beforeBinding).toMatchObject({ currentOperationId: destroy!.id, desiredState: "ABSENT" });
  expect(beforeBinding?.tombstonedAt).not.toBeNull();
  expect(beforeReservation).toMatchObject({ computeState: "RELEASE_REQUESTED", diskState: "RELEASE_REQUESTED" });
  expect((await service.waitForOperation(scope, "paired-create", created.id)).state).toBe("SUCCEEDED");
  expect(await controller.getBinding(original.bindingId)).toEqual(beforeBinding);
  expect(await admission.getReservation(original.bindingId)).toEqual(beforeReservation);
  expect(await controller.getOperation(unrelated.id)).toEqual(beforeUnrelated);
  expect(dispatches.map(request => request.kind)).toEqual(["CREATE", "CREATE"]);
  await controller.executeOperation(destroy!.id);
  expect((await service.waitForOperation(scope, "paired-create", destroy!.id)).state).toBe("SUCCEEDED");
  expect(await admission.getReservation(original.bindingId)).toMatchObject({ computeState: "RELEASED", diskState: "RELEASED" });
  expect((await controller.getOperation(unrelated.id))?.state).toBe("PROVIDER_PENDING");
  expect(dispatches.map(request => request.kind)).toEqual(["CREATE", "CREATE", "DESTROY"]);
});


test("a cleanup admitted during create observation preserves the exact receipt and cause without automatic cleanup", async () => {
  const { db, qualifications, service, controller, admission, dispatches } = await setup(true, true);
  let cleanupId = "";
  const original = admission.markStopIntent.bind(admission);
  const spy = spyOn(admission, "markStopIntent").mockImplementation(async (bindingId, generation, intent, operationId) => {
    const cleanup = await controller.journalOperation({ bindingId, generation, kind: "DESTROY",
      idempotencyScope: "concurrent-cleanup", idempotencyKey: "destroy", payload: { expectedGeneration: generation } });
    cleanupId = cleanup.id;
    await admission.markCleanupIntent(bindingId, generation, "concurrent-cleanup");
    return original(bindingId, generation, intent, operationId);
  });
  const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
  try {
    await expect(witness.createFixture(scope, INCUS_PRESETS[0]!, "create-observation-race", false))
      .rejects.toMatchObject({ name: "IncusQualificationOperationUnsettledError", state: "SUCCEEDED",
        cause: { code: "OPERATION_SUPERSEDED" } });
    const saved = await service.status(scope, "create-observation-race");
    expect(saved.operation).toMatchObject({ id: cleanupId, kind: "DESTROY", state: "JOURNALED" });
    expect(await controller.getBinding(saved.fixture.bindingId)).toMatchObject({ currentOperationId: cleanupId, desiredState: "ABSENT" });
    expect(await admission.getReservation(saved.fixture.bindingId)).toMatchObject({ computeState: "RELEASE_REQUESTED", diskState: "RELEASE_REQUESTED" });
    expect(dispatches.map(request => request.kind)).toEqual(["CREATE"]);
  } finally { spy.mockRestore(); }
});


test("a service error after admitting CREATE but before returning its receipt cannot trigger cleanup", async () => {
  const { db, qualifications, service, dispatches } = await setup(true, true);
  const original = service.create.bind(service);
  const spy = spyOn(service, "create").mockImplementation(async (scope, operationId) => {
    await original(scope, operationId);
    throw new Error("receipt delivery failed after admission");
  });
  try {
    const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
    await expect(witness.createFixture(scope, INCUS_PRESETS[0]!, "lost-receipt-error", false))
      .rejects.toThrow("receipt delivery failed after admission");
    expect((await service.status(scope, "lost-receipt-error")).operation)
      .toMatchObject({ kind: "CREATE", state: "PROVIDER_PENDING" });
    expect(dispatches.map(request => request.kind)).toEqual(["CREATE"]);
    const operations = await db.select().from(schema.sandboxOperations);
    expect(operations.map(operation => operation.kind)).toEqual(["CREATE"]);
  } finally { spy.mockRestore(); }
});


test("a replay error preserves the known first admitted CREATE receipt", async () => {
  const { db, qualifications, service, dispatches } = await setup(true, true);
  const original = service.create.bind(service);
  let calls = 0;
  let savedId = "";
  const spy = spyOn(service, "create").mockImplementation(async (scope, operationId) => {
    if (++calls === 2) throw new Error("replay receipt delivery failed");
    const operation = await original(scope, operationId);
    savedId = operation.id;
    return operation;
  });
  try {
    const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
    const promise = witness.createFixture(scope, INCUS_PRESETS[0]!, "lost-replay-receipt", true);
    await expect(promise)
      .rejects.toMatchObject({ reason: "authority_changed", state: "PROVIDER_PENDING",
        cause: expect.objectContaining({ message: "replay receipt delivery failed" }) });
    expect((await service.status(scope, "lost-replay-receipt")).operation)
      .toMatchObject({ id: savedId, kind: "CREATE", state: "PROVIDER_PENDING" });
    expect(dispatches.map(request => request.kind)).toEqual(["CREATE"]);
    expect((await db.select().from(schema.sandboxOperations)).map(operation => operation.kind)).toEqual(["CREATE"]);
    await expect(promise).rejects.toMatchObject({ operationId: savedId });
    expect(calls).toBe(2);
  } finally { spy.mockRestore(); }
});


test("native qualification rechecks the same unknown START receipt until a known outcome", async () => {
  const { db, qualifications, service, dispatches, inspections } = await setup(true, false, 1, null, 2,
    { pendingKinds: ["START"], inspectUnknownCount: 1 });
  const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
  const handle = await witness.createFixture(scope, INCUS_PRESETS[0]!, "start-unknown-readback", false);
  await witness.setPower(handle, "running");
  const saved = await service.status(scope, handle.operationId);
  expect(saved.operation).toMatchObject({ kind: "START", state: "SUCCEEDED", errorCode: null });
  expect(inspections).toHaveLength(2);
  expect(new Set(inspections.map(request => request.operationId)).size).toBe(1);
  expect(new Set(inspections.map(request => request.providerOperationId)).size).toBe(1);
  expect(saved.operation?.id).toBe(inspections[0]!.operationId);
  expect(saved.binding).toMatchObject({ desiredState: "RUNNING", observedState: "RUNNING" });
  expect(dispatches.map(request => request.kind)).toEqual(["CREATE", "START"]);
});


test("thrown START readback converges through the same saved receipt without redispatch", async () => {
  const { db, qualifications, service, controller, dispatches, inspections } = await setup(true, false, 1, null, 2,
    { pendingKinds: ["START"], inspectFailureCount: 1 });
  const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
  const handle = await witness.createFixture(scope, INCUS_PRESETS[0]!, "start-thrown-readback", false);
  const observed: Array<{ state: string; errorCode: string | null }> = [];
  const original = controller.inspectOperation.bind(controller);
  const spy = spyOn(controller, "inspectOperation").mockImplementation(async id => {
    const operation = await original(id);
    observed.push({ state: operation.state, errorCode: operation.errorCode });
    return operation;
  });
  try { await witness.setPower(handle, "running"); } finally { spy.mockRestore(); }
  expect(observed).toEqual([{ state: "OUTCOME_UNKNOWN", errorCode: "PROVIDER_OUTCOME_UNKNOWN" },
    { state: "SUCCEEDED", errorCode: null }]);
  expect((await service.status(scope, handle.operationId)).operation).toMatchObject({ kind: "START", state: "SUCCEEDED", errorCode: null });
  expect(inspections).toHaveLength(2);
  expect(inspections[1]!.operationId).toBe(inspections[0]!.operationId);
  expect(inspections[1]!.providerOperationId).toBe(inspections[0]!.providerOperationId);
  expect(dispatches.map(request => request.kind)).toEqual(["CREATE", "START"]);
});

test("repeated unknown START reads stop at the same deadline and preserve the saved receipt", async () => {
  const times = [0, 0, 0, 0, 0, 30_000];
  const { db, qualifications, service, dispatches, inspections } = await setup(true, false, 1, null, 2,
    { pendingKinds: ["START"], inspectOutcome: "UNKNOWN", now: () => times.shift() ?? 30_000 });
  const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
  const handle = await witness.createFixture(scope, INCUS_PRESETS[0]!, "start-deadline", false);
  await expect(witness.setPower(handle, "running")).rejects.toMatchObject({ reason: "outcome_unsettled", state: "OUTCOME_UNKNOWN" });
  const saved = (await service.status(scope, handle.operationId)).operation!;
  expect(saved).toMatchObject({ kind: "START", state: "OUTCOME_UNKNOWN", providerOperationId: `provider-${saved.id}` });
  expect(inspections).toHaveLength(2);
  expect(new Set(inspections.map(request => request.operationId)).size).toBe(1);
  expect(dispatches.map(request => request.kind)).toEqual(["CREATE", "START"]);
});

test("unknown START without a provider receipt is preserved without an inspection or redispatch", async () => {
  const { db, qualifications, service, dispatches, inspections } = await setup(true, false, 1, null, 2,
    { missingStartReceipt: true });
  const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
  const handle = await witness.createFixture(scope, INCUS_PRESETS[0]!, "start-no-receipt", false);
  await expect(witness.setPower(handle, "running")).rejects.toMatchObject({ reason: "outcome_unsettled", state: "OUTCOME_UNKNOWN" });
  expect((await service.status(scope, handle.operationId)).operation).toMatchObject({ kind: "START", state: "OUTCOME_UNKNOWN", providerOperationId: null });
  expect(inspections).toEqual([]);
  expect(dispatches.map(request => request.kind)).toEqual(["CREATE", "START"]);
});

test("changed release authority between unknown reads preserves START and stops further inspection", async () => {
  const { db, qualifications, service, controller, dispatches, inspections } = await setup(true, false, 1, null, 2,
    { pendingKinds: ["START"], inspectOutcome: "UNKNOWN" });
  const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
  const handle = await witness.createFixture(scope, INCUS_PRESETS[0]!, "start-authority-change", false);
  const original = controller.inspectOperation.bind(controller);
  const spy = spyOn(controller, "inspectOperation").mockImplementation(async id => {
    const operation = await original(id);
    qualifications.authorizeFixture = async () => { throw new Error("released authority revoked"); };
    return operation;
  });
  try {
    await expect(witness.setPower(handle, "running")).rejects.toMatchObject({ reason: "authority_changed", state: "OUTCOME_UNKNOWN",
      cause: expect.objectContaining({ message: "released authority revoked" }) });
    expect((await service.status(scope, handle.operationId)).operation).toMatchObject({ kind: "START", state: "OUTCOME_UNKNOWN" });
    expect(inspections).toHaveLength(1);
    expect(dispatches.map(request => request.kind)).toEqual(["CREATE", "START"]);
  } finally { spy.mockRestore(); }
});

test("a newer cleanup intent between unknown reads preserves START and refuses further inspection", async () => {
  const { db, qualifications, service, controller, admission, dispatches, inspections } = await setup(true, false, 1, null, 2,
    { pendingKinds: ["START"], inspectOutcome: "UNKNOWN" });
  const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
  const handle = await witness.createFixture(scope, INCUS_PRESETS[0]!, "start-newer-intent", false);
  const original = controller.inspectOperation.bind(controller);
  const spy = spyOn(controller, "inspectOperation").mockImplementation(async id => {
    const operation = await original(id);
    expect((await service.destroy(scope, handle.operationId)).state).toBe("JOURNALED");
    return operation;
  });
  try {
    await expect(witness.setPower(handle, "running")).rejects.toMatchObject({ reason: "newer_intent", state: "OUTCOME_UNKNOWN" });
    expect((await service.status(scope, handle.operationId)).operation).toMatchObject({ kind: "DESTROY", state: "JOURNALED" });
    expect(await admission.getReservation(handle.sandboxId)).toMatchObject({ computeState: "RELEASE_REQUESTED", diskState: "RELEASE_REQUESTED" });
    expect(inspections).toHaveLength(1);
    expect(dispatches.map(request => request.kind)).toEqual(["CREATE", "START"]);
  } finally { spy.mockRestore(); }
});


test("a terminal failed START readback is not polled or dispatched again", async () => {
  const { db, qualifications, service, dispatches, inspections } = await setup(true, false, 1, null, 2,
    { pendingKinds: ["START"], inspectTerminalFailure: true });
  const witness = new IncusHostLiveWitness({ db, fixtures: service, qualifications });
  const handle = await witness.createFixture(scope, INCUS_PRESETS[0]!, "start-terminal-failure", false);
  await expect(witness.setPower(handle, "running")).rejects.toThrow();
  expect((await service.status(scope, handle.operationId)).operation).toMatchObject({ kind: "START", state: "FAILED", errorCode: "TERMINAL_TEST_FAILURE" });
  expect(inspections).toHaveLength(1);
  expect(dispatches.map(request => request.kind)).toEqual(["CREATE", "START"]);
});


test("running fixture dispose refuses before tombstone or cleanup accounting", async () => {
  const { db, service, controller, dispatches, admission } = await setup();
  await service.create(scope, "running-dispose");
  await service.setPower(scope, "running-dispose", "running", "start");
  const [fixture] = await db.select().from(schema.incusQualificationFixtures);
  const before = await controller.getBinding(fixture!.bindingId);
  await expect(service.destroy(scope, "running-dispose")).rejects.toThrow();
  expect(await controller.getBinding(fixture!.bindingId)).toEqual(before);
  expect(dispatches.map(item => item.kind)).toEqual(["CREATE", "START"]);
  expect((await admission.getReservation(fixture!.bindingId))?.diskState).toBe("RESERVED");
});


async function failedRunningCleanup(options: Parameters<typeof setup>[5] = {}) {
  const fixture = await setup(true, false, 1, null, 2,
    { ...options, enforcePowerGeneration: true, refuseRunningDestroy: true });
  await fixture.service.create(scope, "failed-running-cleanup");
  await fixture.service.setPower(scope, "failed-running-cleanup", "running", "start");
  const [owned] = await fixture.db.select().from(schema.incusQualificationFixtures);
  await fixture.admission.markCleanupIntent(owned!.bindingId, 1, "legacy-running-cleanup");
  const failed = await fixture.controller.requestAndDispatch({ bindingId: owned!.bindingId, generation: 1,
    kind: "DESTROY", idempotencyScope: "legacy-cleanup", idempotencyKey: "failed-running-cleanup",
    payload: { expectedGeneration: 2 } });
  expect(failed).toMatchObject({ state: "FAILED", errorCode: "REVISION_CONFLICT", providerOperationId: null });
  return { ...fixture, owned: owned!, failed };
}

test("shared recovery stops then destroys while preserving failed receipt, tombstone and charges", async () => {
  const { db, service, controller, admission, dispatches, owned, failed } = await failedRunningCleanup();
  const before = await controller.getBinding(owned.bindingId);
  const result = await service.recoverCleanup(scope, owned.operationId, failed.id);
  expect(result.recovery.state).toBe("COMPLETED");
  expect(result.operation).toMatchObject({ kind: "DESTROY", state: "SUCCEEDED", requestPayload: { expectedGeneration: 3 } });
  expect(await controller.getOperation(failed.id)).toEqual(failed);
  expect(await controller.getBinding(owned.bindingId)).toMatchObject({ desiredState: "ABSENT", observedState: "ABSENT",
    generation: 1, tombstonedAt: before!.tombstonedAt, currentOperationId: result.recovery.destroyOperationId });
  expect(await admission.getReservation(owned.bindingId)).toMatchObject({ computeState: "RELEASED", diskState: "RELEASED" });
  expect(dispatches.map(item => item.kind)).toEqual(["CREATE", "START", "DESTROY", "STOP", "DESTROY"]);
  const replay = await service.recoverCleanup(scope, owned.operationId, failed.id);
  expect(replay.recovery).toEqual(result.recovery);
  expect(dispatches).toHaveLength(5);
  expect(await db.select().from(schema.sandboxCleanupRecoveries)).toHaveLength(1);
});

test("unknown linked stop preserves exact receipts, accounting, and restart continuation", async () => {
  const { db, service, fixtureServiceDeps, controller, admission, dispatches, owned, failed } = await failedRunningCleanup({ pendingKinds: ["STOP"], inspectOutcome: "UNKNOWN" });
  const first = await service.recoverCleanup(scope, owned.operationId, failed.id);
  expect(first.recovery.state).toBe("STOP_REQUIRED");
  expect(first.operation.state).toBe("PROVIDER_PENDING");
  const restarted = new IncusQualificationFixtureService(fixtureServiceDeps);
  const repeated = await restarted.recoverCleanup(scope, owned.operationId, failed.id);
  expect(repeated.recovery.id).toBe(first.recovery.id);
  expect(repeated.operation.id).toBe(first.operation.id);
  expect(repeated.operation.state).toBe("OUTCOME_UNKNOWN");
  expect(dispatches.map(item => item.kind)).toEqual(["CREATE", "START", "DESTROY", "STOP"]);
  expect(await admission.getReservation(owned.bindingId)).toMatchObject({ computeState: "RELEASE_REQUESTED", diskState: "RELEASE_REQUESTED" });
  expect(await controller.getOperation(failed.id)).toEqual(failed);
  expect(await db.select().from(schema.sandboxCleanupRecoveries)).toHaveLength(1);
});


test("two concurrent recovery admissions share one durable pair and preserve unrelated bindings", async () => {
  const { db, controller, owned, failed } = await failedRunningCleanup();
  await db.insert(schema.projects).values({ id: "unrelated-project", name: "unrelated", path: "/unused" });
  const unrelated = await controller.createBinding({ id: "unrelated", projectId: "unrelated-project",
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    connectionId: scope.connectionId });
  const input = { bindingId: owned.bindingId, generation: 1, failedDestroyOperationId: failed.id,
    installationId: scope.installationId, releaseId: scope.releaseId, connectionId: scope.connectionId,
    connectionRevision: 1, providerResourceId: resourceName(scope.connectionId, owned.bindingId), providerGeneration: 2 };
  const results = await Promise.all([1, 2].map(() => controller.admitCleanupRecovery({ ...input,
    stopOperationId: crypto.randomUUID(), destroyOperationId: crypto.randomUUID() })));
  expect(results[0]).toEqual(results[1]);
  expect(await db.select().from(schema.sandboxCleanupRecoveries)).toHaveLength(1);
  expect(await controller.getBinding(unrelated.id)).toEqual(unrelated);
  expect(await controller.getOperation(failed.id)).toEqual(failed);
});


function restartedBackground(fixture: Awaited<ReturnType<typeof setup>>) {
  const snapshot = releaseRuntimeFixture(scope.installationId, incusManifest).snapshot;
  snapshot.release.id = scope.releaseId;
  snapshot.installation.activeReleaseId = scope.releaseId;
  return new IncusFeatureService({ db: fixture.db, controller: fixture.controller, admission: fixture.admission,
    activeRelease: async () => snapshot, loadQualification: async () => null,
    resolveConnection: async requested => {
      const [saved] = await fixture.db.select().from(schema.providerConnections).where(eq(schema.providerConnections.id, requested.connectionId));
      if (!saved || saved.revokedAt || saved.revision !== requested.revision) throw new Error("Connection authority changed");
      return { ...saved, configuration: { kind: "incus", profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" }, privateKeyPem: "private-test-key" };
    }, inspect: fixture.fixtureServiceDeps.inspect });
}

test("failure after stop preserves restartable linked steps without early release", async () => {
  const fixture = await failedRunningCleanup();
  const { service, controller, admission, dispatches, owned, failed } = fixture;
  const interruption = spyOn(controller, "advanceCleanupRecovery").mockRejectedValueOnce(new Error("host interrupted after stop"));
  await expect(service.recoverCleanup(scope, owned.operationId, failed.id)).rejects.toThrow("host interrupted after stop");
  interruption.mockRestore();
  const [saved] = await fixture.db.select().from(schema.sandboxCleanupRecoveries);
  expect(saved!.state).toBe("STOP_REQUIRED");
  expect((await controller.getOperation(saved!.stopOperationId))?.state).toBe("SUCCEEDED");
  expect(await controller.getOperation(saved!.destroyOperationId)).toBeNull();
  expect(await admission.getReservation(owned.bindingId)).toMatchObject({ computeState: "RELEASE_REQUESTED", diskState: "RELEASE_REQUESTED" });
  const restarted = restartedBackground(fixture);
  await restarted.reconcile();
  const [result] = await fixture.db.select().from(schema.sandboxCleanupRecoveries);
  expect(result!.id).toBe(saved!.id);
  expect(result!.state).toBe("COMPLETED");
  expect(dispatches.filter(item => item.kind === "STOP")).toHaveLength(1);
  expect(await controller.getOperation(failed.id)).toEqual(failed);
});

test("cleanup recovery denies changed authority before effect and leaves saved failure intact", async () => {
  const { service, qualifications, controller, dispatches, db, owned, failed } = await failedRunningCleanup();
  const denied = spyOn(qualifications, "authorizeFixture").mockRejectedValue(new Error("release retired"));
  await expect(service.recoverCleanup(scope, owned.operationId, failed.id)).rejects.toThrow("release retired");
  denied.mockRestore();
  expect(await db.select().from(schema.sandboxCleanupRecoveries)).toEqual([]);
  expect(dispatches.map(item => item.kind)).toEqual(["CREATE", "START", "DESTROY"]);
  expect(await controller.getOperation(failed.id)).toEqual(failed);
});

test("recovery admission refuses wrong resource, revision and unsettled effects without new journals", async () => {
  const { db, controller, owned, failed } = await failedRunningCleanup();
  const input = { bindingId: owned.bindingId, generation: 1, failedDestroyOperationId: failed.id,
    stopOperationId: crypto.randomUUID(), destroyOperationId: crypto.randomUUID(),
    installationId: scope.installationId, releaseId: scope.releaseId, connectionId: scope.connectionId,
    connectionRevision: 1, providerResourceId: resourceName(scope.connectionId, owned.bindingId), providerGeneration: 2 };
  for (const changed of [{ providerResourceId: "foreign-resource" }, { generation: 2 },
    { connectionRevision: 2 }, { releaseId: "retired" }, { providerGeneration: 3 },
    { stopOperationId: failed.id }]) {
    await expect(controller.admitCleanupRecovery({ ...input, ...changed })).rejects.toThrow("authority changed");
  }
  await db.insert(schema.sandboxOperations).values({ id: "uncertain-effect", bindingId: owned.bindingId,
    kind: "START", generation: 1, idempotencyScope: "earlier", idempotencyKey: "uncertain", payloadHash: "hash",
    requestPayload: { expectedGeneration: 1 }, state: "OUTCOME_UNKNOWN", providerOperationId: "saved-provider" });
  await expect(controller.admitCleanupRecovery(input)).rejects.toThrow("authority changed");
  expect(await db.select().from(schema.sandboxCleanupRecoveries)).toEqual([]);
  expect(await controller.getOperation(input.stopOperationId)).toBeNull();
  expect(await controller.getOperation(failed.id)).toEqual(failed);
});


test("interruption before linked stop dispatch resumes from durable admission in background", async () => {
  const fixture = await failedRunningCleanup();
  const interrupted = spyOn(fixture.controller, "executeOperation").mockRejectedValueOnce(new Error("host stopped before dispatch"));
  await expect(fixture.service.recoverCleanup(scope, fixture.owned.operationId, fixture.failed.id)).rejects.toThrow("host stopped before dispatch");
  interrupted.mockRestore();
  const [saved] = await fixture.db.select().from(schema.sandboxCleanupRecoveries);
  expect((await fixture.controller.getOperation(saved!.stopOperationId))?.state).toBe("JOURNALED");
  await restartedBackground(fixture).reconcile();
  expect((await fixture.db.select().from(schema.sandboxCleanupRecoveries))[0]).toMatchObject({ id: saved!.id, state: "COMPLETED" });
  expect(fixture.dispatches.filter(operation => operation.kind === "STOP")).toHaveLength(1);
  expect(await fixture.controller.getOperation(fixture.failed.id)).toEqual(fixture.failed);
});

test("destroy success before accounting failure settles exact recovery in background", async () => {
  const fixture = await failedRunningCleanup();
  const interrupted = spyOn(fixture.admission, "recordObservedState").mockRejectedValueOnce(new Error("accounting interrupted"));
  await expect(fixture.service.recoverCleanup(scope, fixture.owned.operationId, fixture.failed.id)).rejects.toThrow("accounting interrupted");
  interrupted.mockRestore();
  const [saved] = await fixture.db.select().from(schema.sandboxCleanupRecoveries);
  expect(saved!.state).toBe("DESTROY_REQUIRED");
  expect((await fixture.controller.getOperation(saved!.destroyOperationId))?.state).toBe("SUCCEEDED");
  expect(await fixture.admission.getReservation(fixture.owned.bindingId)).toMatchObject({ computeState: "RELEASE_REQUESTED", diskState: "RELEASE_REQUESTED" });
  await restartedBackground(fixture).reconcile();
  expect((await fixture.db.select().from(schema.sandboxCleanupRecoveries))[0]).toMatchObject({ id: saved!.id, state: "COMPLETED" });
  expect(await fixture.admission.getReservation(fixture.owned.bindingId)).toMatchObject({ computeState: "RELEASED", diskState: "RELEASED" });
  expect(fixture.dispatches.filter(operation => operation.kind === "DESTROY")).toHaveLength(2);
});


test("qualification failure cleanup durably stops a running fixture before stopped-only destroy", async () => {
  const fixture = await setup(true, false, 1, null, 2, { enforcePowerGeneration: true, refuseRunningDestroy: true });
  await fixture.service.create(scope, "failure-cleanup");
  await fixture.service.setPower(scope, "failure-cleanup", "running", "start");
  const [owned] = await fixture.db.select().from(schema.incusQualificationFixtures);
  const witness = new IncusHostLiveWitness({ db: fixture.db, fixtures: fixture.service, qualifications: fixture.qualifications });
  await witness.destroyFixture({ sandboxId: owned!.bindingId, operationId: owned!.operationId });
  expect(fixture.dispatches.map(operation => operation.kind)).toEqual(["CREATE", "START", "STOP", "DESTROY"]);
  expect(fixture.dispatches.at(-1)?.payload.expectedGeneration).toBe(3);
  expect(await fixture.controller.getBinding(owned!.bindingId)).toMatchObject({ desiredState: "ABSENT", observedState: "ABSENT" });
  expect(await fixture.admission.getReservation(owned!.bindingId)).toMatchObject({ computeState: "RELEASED", diskState: "RELEASED" });
});


test("unknown linked stop without provider receipt cannot inspect or admit another effect", async () => {
  const fixture = await failedRunningCleanup({ missingStopReceipt: true });
  const first = await fixture.service.recoverCleanup(scope, fixture.owned.operationId, fixture.failed.id);
  expect(first.operation).toMatchObject({ state: "OUTCOME_UNKNOWN", providerOperationId: null });
  const repeated = await new IncusQualificationFixtureService(fixture.fixtureServiceDeps)
    .recoverCleanup(scope, fixture.owned.operationId, fixture.failed.id);
  expect(repeated.recovery.id).toBe(first.recovery.id);
  expect(repeated.operation.id).toBe(first.operation.id);
  expect(fixture.inspections).toEqual([]);
  expect(fixture.dispatches.map(operation => operation.kind)).toEqual(["CREATE", "START", "DESTROY", "STOP"]);
  expect(await fixture.controller.getOperation(first.recovery.destroyOperationId)).toBeNull();
  expect(await fixture.admission.getReservation(fixture.owned.bindingId)).toMatchObject({ computeState: "RELEASE_REQUESTED", diskState: "RELEASE_REQUESTED" });
});

test("JSONB-reordered scope replays the legacy CREATE binding and accounting intent", async () => {
  const { service, db, dispatches, admission } = await setup();
  const observed = spyOn(admission, "recordObservedState");
  const first = await service.create(scope, "fixture-jsonb");
  const [fixture] = await db.select().from(schema.incusQualificationFixtures);
  const reordered = { presetId: scope.presetId, connectionId: scope.connectionId,
    releaseId: scope.releaseId, installationId: scope.installationId };
  const replay = await service.create(reordered, "fixture-jsonb");
  expect(replay.id).toBe(first.id);
  expect(await db.select().from(schema.incusQualificationFixtures)).toEqual([fixture]);
  expect(dispatches).toHaveLength(1);
  const intents = observed.mock.calls.map(call => call[3]);
  expect(intents.length).toBeGreaterThan(0);
  expect(new Set(intents).size).toBe(1);
  observed.mockRestore();
});

async function signedRecoveryCheckpoint(db: Awaited<ReturnType<typeof setup>>["db"], service: IncusQualificationFixtureService) {
  await addQualificationRuns(db);
  await service.create(scope, "qual-primary-run-one");
  const durable = await service.status(scope, "qual-primary-run-one");
  const writer = Bun.spawn([process.execPath, "-e", `import { currentProcessIdentity } from ${JSON.stringify(join(import.meta.dir, "incus-qualification-checkpoint.ts"))}; console.log(JSON.stringify(currentProcessIdentity()));`], { stdout: "pipe", stderr: "pipe" });
  const oldProcess = JSON.parse(await new Response(writer.stdout).text());
  expect(await writer.exited).toBe(0);
  const newProcess = currentProcessIdentity();
  const backend = { sandboxId: durable.binding.id, state: "stopped", bootId: null,
    imageDigest: INCUS_PRESETS[0]!.imageDigest, helperDigest: INCUS_PRESETS[0]!.helperDigests[0]!,
    profile: INCUS_PRESETS[0]!.profile, workspaceRoot: "/workspace", guestUser: "sandbox",
    memoryBytes: INCUS_PRESETS[0]!.limits.memoryBytes, cpuMillis: INCUS_PRESETS[0]!.limits.cpuMillis,
    pids: INCUS_PRESETS[0]!.limits.pids, diskBytes: INCUS_PRESETS[0]!.limits.diskBytes,
    storageDriver: "btrfs", privateNetwork: true, restrictedProject: true, unprivileged: true } as const;
  const before = { durable, backend, processId: processIdentityKey(oldProcess) };
  const after = { ...before, processId: processIdentityKey(newProcess) };
  const deadlineMs = Date.now() + 110000;
  await db.execute(sql`INSERT INTO incus_qualification_runs (run_id, fixture_operation_id, scope, binding_id,
    generation, connection_revision, last_operation_id, nonce, deadline_at, before_observation, before_digest, old_process_identity)
    VALUES ('run-one', ${durable.fixture.operationId}, ${JSON.stringify(scope)}::jsonb, ${durable.binding.id},
    ${durable.binding.generation}, ${durable.fixture.connectionRevision}, ${durable.operation!.id}, 'nonce', ${new Date(deadlineMs)},
    ${JSON.stringify(before)}::jsonb, ${observationDigest(before)}, ${JSON.stringify(oldProcess)}::jsonb)`);
  const keys = generateKeyPairSync("ed25519");
  const store = new IncusQualificationCheckpointStore(db, keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  const payload: RestartHandoffPayload = { version: 1, runId: "run-one", nonce: "nonce", deadlineMs, scope,
    fixtureOperationId: durable.fixture.operationId, bindingId: durable.binding.id,
    generation: durable.binding.generation, connectionRevision: durable.fixture.connectionRevision,
    lastOperationId: durable.operation!.id, oldProcess, newProcess,
    beforeDigest: observationDigest(before), afterDigest: observationDigest(after) };
  await store.claim({ runId: "run-one", nonce: "nonce", after,
    receipt: { payload, signature: sign(null, restartHandoffSigningBytes(payload), keys.privateKey).toString("base64") } });
  const restored = await store.get("run-one");
  expect(restored!.scope).toEqual(scope);
  expect(JSON.stringify(restored!.scope)).not.toBe(JSON.stringify(scope));
  expect(restored!.state).toBe("CLAIMED");
  return { store, scope: restored!.scope };
}

test("real fixture/controller durable UNKNOWN confirms the consumed operator fault without a thrown service reply", async () => {
  let fault!: HostIncusLostDestroyReplyFault;
  const fixtureSetup = await setup(true, false, 1, null, 3, {
    inspectUnknownCount: 1,
    destroyEffect: async request => {
      expect(fault.consume({ action: "instance.destroy", connectionId: scope.connectionId,
        tags: { sandboxId: request.binding.id }, idempotency: { requestId: request.operationId, key: request.operationId },
        payload: { expectedGeneration: 1 } } as never,
      { providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId, revision: 1 })).toBe(true);
      return { outcome: "UNKNOWN", providerOperationId: `provider-${request.operationId}` };
    },
  });
  const { db, service, dispatches, controller, admission, qualifications } = fixtureSetup;
  await db.update(schema.providerConnections).set({ configuration: { kind: "incus", profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" } }).where(eq(schema.providerConnections.id, scope.connectionId));
  await db.insert(schema.projects).values({ id: "user-project", name: "User project", path: "/workspace", purpose: "user" });
  const checkpoint = await signedRecoveryCheckpoint(db, service);
  await service.create(checkpoint.scope, "qual-unrelated-run-one");
  await service.create(checkpoint.scope, "qual-recovery-run-one");
  const fixture = (await service.status(scope, "qual-recovery-run-one")).fixture;
  const handle = { operationId: fixture.operationId, sandboxId: fixture.bindingId };
  const commands: string[] = [];
  fault = new HostIncusLostDestroyReplyFault(db, incusOperatorFaultAuthority(checkpoint.store,
    "/private/supervisor.sock", async (socket, phase, arm) => {
      expect(socket).toBe("/private/supervisor.sock");
      commands.push(phase);
      if (arm) {
        expect(arm.fixtureOperationId).toBe("qual-recovery-run-one");
        expect(arm.bindingId).toBe(handle.sandboxId);
        expect(arm.scope).toEqual(checkpoint.scope);
        expect(arm.bindingId).not.toBe((await checkpoint.store.get("run-one"))!.bindingId);
      }
    }));
  const cleanup = new IncusLiveCleanupController({ db, fixtures: service, qualifications,
    readinessProjectId: "user-project", fault: async () => fault,
    checkpoints: checkpoint.store, freshFeatureGate: () => restartedBackground(fixtureSetup) });
  const unrelatedFixture = (await service.status(scope, "qual-unrelated-run-one")).fixture;
  const unrelated = { operationId: unrelatedFixture.operationId, sandboxId: unrelatedFixture.bindingId };
  const result = await observeFailedCleanupRecovery(checkpoint.scope, handle, unrelated, {
    readDurable: value => service.status(checkpoint.scope, value.operationId),
    readBackend: async value => {
      const status = await service.status(checkpoint.scope, value.operationId);
      const preset = INCUS_PRESETS[0]!;
      return { sandboxId: value.sandboxId, state: status.binding.observedState.toLowerCase() as "absent" | "stopped",
        bootId: null, imageDigest: preset.imageDigest, helperDigest: preset.helperDigests[0]!,
        profile: preset.profile, workspaceRoot: "/workspace", guestUser: "sandbox", memoryBytes: preset.limits.memoryBytes,
        cpuMillis: preset.limits.cpuMillis, pids: preset.limits.pids, diskBytes: preset.limits.diskBytes,
        storageDriver: "btrfs", privateNetwork: true, restrictedProject: true, unprivileged: true };
    },
    injectLostDestroyReply: async () => {
      await cleanup.injectLostDestroyReply(checkpoint.scope, handle);
      const saved = await service.status(scope, handle.operationId);
      expect(saved.operation?.state).toBe("OUTCOME_UNKNOWN");
      expect(saved.binding.desiredState).toBe("ABSENT");
      expect((await admission.getReservation(handle.sandboxId))?.diskState).toBe("RELEASE_REQUESTED");
      expect((await controller.reconcile()).examined).toBe(0);
    },
    attemptReadiness: () => cleanup.attemptReadiness(checkpoint.scope, handle),
    reconcileFromReopenedController: () => cleanup.reconcileFromReopenedController(checkpoint.scope, handle),
  });
  expect(result.recovered.operation).toMatchObject({ id: result.failed.operation!.id, state: "SUCCEEDED" });
  expect(result.unrelated.binding).toMatchObject({ observedState: "STOPPED", desiredState: "STOPPED" });
  expect(await admission.getReservation(handle.sandboxId)).toMatchObject({ computeState: "RELEASED", diskState: "RELEASED" });
  expect(dispatches.map(request => request.kind)).toEqual(["CREATE", "CREATE", "CREATE", "DESTROY"]);
  expect(fixtureSetup.inspections).toHaveLength(2);
  expect(new Set(fixtureSetup.inspections.map(request => request.operationId)).size).toBe(1);
  expect(new Set(fixtureSetup.inspections.map(request => request.providerOperationId)).size).toBe(1);
  expect(commands).toEqual(["presence", "arm", "arm", "presence", "readback"]);
});

for (const mode of ["pending", "unconsumed_unknown", "expired_arm", "permission_denied"] as const) {
  test(`signed cleanup refuses ${mode} without treating it as an injected loss`, async () => {
    let fault!: HostIncusLostDestroyReplyFault;
    let clock = Date.now();
    const canary = "PRIVATE_BACKEND_ERROR_CANARY";
    const fixture = await setup(true, false, 1, null, 2, {
      pendingKinds: ["DESTROY"], destroyEffect: async request => {
        if (mode === "unconsumed_unknown") throw new Error(canary);
        if (mode === "expired_arm") {
          clock += 30000;
          expect(fault.matches({ action: "instance.destroy", connectionId: scope.connectionId,
            tags: { sandboxId: request.binding.id }, idempotency: { requestId: request.operationId, key: request.operationId },
            payload: { expectedGeneration: 1 } } as never,
          { providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId, revision: 1 })).toBe(false);
        }
      },
    });
    const checkpoint = await signedRecoveryCheckpoint(fixture.db, fixture.service);
    await fixture.service.create(checkpoint.scope, "qual-recovery-run-one");
    const saved = await fixture.service.status(checkpoint.scope, "qual-recovery-run-one");
    const handle = { operationId: saved.fixture.operationId, sandboxId: saved.fixture.bindingId };
    fault = new HostIncusLostDestroyReplyFault(fixture.db, { authenticateOperator: async () => {},
      authorizeRun: async arm => { await checkpoint.store.authorizeRecoveryFixtureForRun(arm);
        if (mode === "permission_denied") throw new Error(canary); },
      authorizeReadback: arm => checkpoint.store.authorizeRecoveryReadbackForRun(arm) }, () => clock);
    const cleanup = new IncusLiveCleanupController({ db: fixture.db, fixtures: fixture.service,
      qualifications: fixture.qualifications, readinessProjectId: "user-project",
      fault: async () => fault, checkpoints: checkpoint.store });
    let failure: unknown;
    try { await cleanup.injectLostDestroyReply(checkpoint.scope, handle); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ stage: mode === "permission_denied" ? "dispatch"
      : mode === "unconsumed_unknown" ? "operator_readback" : "durable_state" });
    expect(String(failure)).not.toContain(canary);
    expect(JSON.stringify(failure)).not.toContain(canary);
    const current = await fixture.service.status(checkpoint.scope, handle.operationId);
    expect(current.operation?.state).toBe(mode === "permission_denied" ? "SUCCEEDED"
      : mode === "unconsumed_unknown" ? "OUTCOME_UNKNOWN" : "PROVIDER_PENDING");
    expect(fixture.dispatches.filter(request => request.kind === "DESTROY")).toHaveLength(mode === "permission_denied" ? 0 : 1);
    expect((await fixture.admission.getReservation(handle.sandboxId))?.diskState).not.toBe("RELEASED");
  });
}
