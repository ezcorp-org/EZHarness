import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { digest } from "../../scripts/incus/model";
import { up as addController } from "../db/migrations/add-sandbox-controller";
import { up as addQualificationFixtures } from "../db/migrations/add-incus-qualification-fixtures";
import * as schema from "../db/schema";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { SandboxController, type SandboxProviderRequest } from "../sandboxes/controller";
import { IncusFeatureService } from "./incus-feature-service";
import { HostIncusLostDestroyReplyFault } from "./incus-destroy-reply-fault";
import { IncusQualificationFixtureService, type IncusQualificationScope, type IncusQualificationStore } from "./incus-qualification";

const opened: PGlite[] = [];
const scope: IncusQualificationScope = { installationId: "installation", releaseId: "release",
  connectionId: "connection", presetId: INCUS_PRESETS[0]!.id };
const assertCurrentScope = async () => {};

async function setup(configureHost = true, pendingCreate = false, providerGeneration = 1,
  inspectError: Error | null = null, hostSlots = 2) {
  const client = new PGlite();
  opened.push(client);
  await client.waitReady;
  await client.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await client.exec("CREATE TABLE project_workspace_bindings (project_id TEXT PRIMARY KEY, kind TEXT NOT NULL, binding_id TEXT, revision INTEGER NOT NULL, state TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await client.exec("CREATE TABLE provider_connections (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, provider_installation_id TEXT NOT NULL, provider_release_id TEXT NOT NULL, endpoint TEXT NOT NULL, server_certificate_pem TEXT NOT NULL, project TEXT NOT NULL, configuration JSONB, client_certificate_pem TEXT NOT NULL, private_key_ciphertext TEXT NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const db = drizzle(client, { schema });
  await addController(db);
  await addQualificationFixtures(db);
  await addQualificationFixtures(db);
  await db.insert(schema.providerConnections).values({ id: scope.connectionId, revision: 1,
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    endpoint: "https://127.0.0.1", serverCertificatePem: "cert", project: "sandbox",
    clientCertificatePem: "client", privateKeyCiphertext: "ciphertext" });
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const effectiveSettingsDigest = digest({ presetDigest, connectionRevision: 1 });
  const qualifications = { authorizeFixture: async () => ({
    snapshot: { installation: { generation: 2 }, release: { releaseDigest: "fixture-release" } },
    connection: { revision: 1 }, preset,
    presetDigest, effectiveSettingsDigest }) } as unknown as IncusQualificationStore;
  const dispatches: SandboxProviderRequest[] = [];
  let providerState: "running" | "stopped" = "stopped";
  const controller = new SandboxController(db, { dispatch: async request => {
    dispatches.push(request);
    if (pendingCreate && request.kind === "CREATE") {
      return { outcome: "PENDING", providerOperationId: `provider-${request.operationId}` };
    }
    providerState = request.kind === "START" ? "running" : "stopped";
    return { outcome: "SUCCEEDED", observedState: request.kind === "DESTROY" ? "ABSENT"
      : request.kind === "START" ? "RUNNING" : "STOPPED" };
  }, inspectOperation: async request => ({ outcome: "SUCCEEDED",
    providerOperationId: request.providerOperationId ?? undefined, observedState: "STOPPED" }) });
  const admission = new SandboxAdmissionStore(db);
  if (configureHost) await admission.configureHostCapacity({ providerInstallationId: scope.installationId,
    connectionId: scope.connectionId,
    allocatable: { memoryBytes: hostSlots * preset.limits.memoryBytes,
      cpuMillicores: hostSlots * preset.limits.cpuMillis,
      pids: hostSlots * preset.limits.pids, diskBytes: hostSlots * preset.limits.diskBytes,
      executionSlots: hostSlots },
    safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 },
  });
  const service = new IncusQualificationFixtureService({ db, qualifications, admission, controller,
    assertCurrentScope,
    inspect: async (_installationId, _bindingId, input) => {
      if (inspectError) throw inspectError;
      return { ok: true, sandbox: { sandboxId: input.sandboxId,
      profile: preset.profile,
      presetId: preset.id, desiredState: providerState, observedState: providerState,
      generation: providerGeneration, bootId: null, observedAt: new Date().toISOString() } };
    } });
  return { db, service, dispatches, controller, admission, qualifications, presetDigest, effectiveSettingsDigest };
}

afterEach(async () => { await Promise.all(opened.splice(0).map(client => client.close())); });

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
