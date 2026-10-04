import { IncusSandboxAdapter } from "../../extensions/incus-sandbox/adapter";
import { IncusTransportError } from "../../extensions/incus-sandbox/transport";
import { sandboxProviderMethodSchemas, SANDBOX_PROVIDER_OPERATIONS, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import { IncusSandboxProviderDispatcher } from "../sandboxes/incus-dispatcher";
import { ProviderRpcBroker, type ProviderConnectionResolver } from "./provider-rpc-broker";
import { HostIncusLifecycleTransport } from "./incus-transport/lifecycle";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { incusManifest, INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { makeTestCertificates } from "./incus-transport/test-certificates";
import { up as addReleaseTables } from "../db/migrations/add-extension-releases";
import { up as addConnections } from "../db/migrations/add-provider-connections";
import { eq, sql } from "drizzle-orm";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { hasUnfinishedProviderSandboxes } from "../db/queries/extension-releases";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { up as addController } from "../db/migrations/add-sandbox-controller";
import { up as addFixtures } from "../db/migrations/add-incus-qualification-fixtures";
import { up as addRecovery } from "../db/migrations/add-incus-noeffect-recoveries";
import { up as addRuns } from "../db/migrations/add-incus-qualification-runs";
import * as schema from "../db/schema";
import { SandboxController, operationPayloadHash } from "../sandboxes/controller";
import type { IncusTransportRequest } from "../../extensions/incus-sandbox/transport";
import { incusLifecycleOperationId, resourceName } from "./incus-transport/lifecycle";
import { canonicalRecoveryJson } from "./incus-create-noeffect-recovery";
import { applyFencedCleanupRecovery, verifyFencedCleanupReceipt, type FencedCleanupPayload, type FencedCleanupReceipt } from "./incus-fenced-cleanup-recovery";
const clients: PGlite[] = [];
const fixtureOperationId = "live-fixture-20260924";
const bindingId = "binding-recovery";
const operationId = "62633686-a1bc-4b93-b87a-54fdbc96c2fd";
const scope = { installationId: "installation", releaseId: "release",
  connectionId: "connection", presetId: "incus-compose-v1" };
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const now = Date.now();
const clock = spyOn(Date, "now").mockReturnValue(now);
afterAll(() => clock.mockRestore());
const certificates = makeTestCertificates();
afterAll(() => certificates.dispose());
const serverCertificatePem = certificates.read("server-cert.pem");
const serverCertificateSha256 = createHash("sha256").update(new X509Certificate(serverCertificatePem).raw).digest("hex");
const preset = { ...INCUS_PRESETS[1]!, imageDigest: "c".repeat(64) };
const presetDigest = await sandboxPresetDigest(preset);
const manifest = structuredClone(incusManifest);
manifest.version = "0.1.3";
manifest.sandboxProviders![0]!.minimumHostContract!.minor = 0;
for (const operation of SANDBOX_PROVIDER_OPERATIONS) Object.assign(manifest.methods!.find(method => method.name === `incus/${operation.replace(".", "/")}`)!, sandboxProviderMethodSchemas(operation, 0));
manifest.sandboxProviders![0]!.presets = [preset];
const releaseDigest = "a".repeat(64);


function receipt(overrides: Partial<FencedCleanupPayload> = {}): FencedCleanupReceipt {
  const payload: FencedCleanupPayload = { version: 1, action: "recover-fenced-cleanup",
    nonce: "nonce-one", reviewId: "review-one", scope, fixtureOperationId, bindingId,
    operationId, generation: 1, connectionRevision: 1, installationGeneration: 4, releaseDigest, grantsDigest: createHash("sha256").update("[]").digest("hex"),
    endpoint: "https://127.0.0.1:8443", project: "ezharness",
    resourceName: resourceName(scope.connectionId, bindingId),
    providerOperationId: "incus-setPower-11111111-1111-1111-1111-111111111111",
    nativeOperationId: "11111111-1111-1111-1111-111111111111", operationTag: incusLifecycleOperationId("setPower", { connectionId: scope.connectionId,
      sandboxName: resourceName(scope.connectionId, bindingId), tags: { managedBy: "ezharness-incus-sandbox", connectionId: scope.connectionId, sandboxId: bindingId },
      idempotency: { requestId: operationId, key: operationId } } as IncusTransportRequest),
    payloadHash: operationPayloadHash({ bindingId, kind: "START", generation: 1, idempotencyScope: "incus-qualification-power", idempotencyKey: `${fixtureOperationId}:start`, payload: { expectedGeneration: 1 } }),
    presetDigest: presetDigest, effectiveSettingsDigest: "b".repeat(64),
    imageFingerprint: "c".repeat(64), helperVersion: "0.1.3", serverCertificateSha256,
    oldProcess: { pid: 123, startTicks: "456" }, stoppedAtMs: now - 85_000,
    fenceUntilMs: now + 30_000, allClientsFenced: true,
    fenceEvidence: "operator stopped all app and runner clients",
    first: { observedAtMs: now - 15_000, instanceState: "stopped", nativeOperationAbsent: true, activeOperations: [], providerGeneration: 2 },
    second: { observedAtMs: now - 9_000, instanceState: "stopped", nativeOperationAbsent: true, activeOperations: [], providerGeneration: 2 },
    ...overrides };
  return { payload, signature: sign(null, Buffer.from(canonicalRecoveryJson(payload)), privateKey).toString("base64") };
}

async function setup() {
  const client = new PGlite();
  clients.push(client);
  await client.waitReady;
  await client.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
    icon TEXT, variables JSONB NOT NULL DEFAULT '{}',
    purpose TEXT NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.exec(`CREATE TABLE project_workspace_bindings (
    project_id TEXT PRIMARY KEY, kind TEXT, binding_id TEXT, revision INTEGER,
    state TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  const db = drizzle(client, { schema });
  await addController(db);
  await addReleaseTables(db);
  await db.execute(sql`INSERT INTO extension_release_installations (id,owner_id,scope,payload)
    VALUES (${scope.installationId}, 'owner', 'global', ${JSON.stringify({ id: scope.installationId, ownerId: "owner", scope: "global", activeReleaseId: scope.releaseId, generation: 4, enabled: true, uninstalled: false, status: "active", acknowledgedGeneration: 4, grants: [] })})`);
  await db.execute(sql`INSERT INTO extension_release_records (installation_id,kind,id,payload)
    VALUES (${scope.installationId}, 'releases', ${scope.releaseId}, ${JSON.stringify({ id: scope.releaseId, releaseDigest, manifest })})`);
  await db.execute(sql`INSERT INTO extension_release_records (installation_id,kind,id,payload) VALUES (${scope.installationId}, 'approvals', 'approval', ${JSON.stringify({ id: "approval", releaseId: scope.releaseId, releaseDigest, status: "consumed", expectedGeneration: 3, principalId: "owner", scope: "global", grants: [] })})`);
  await addConnections(db);
  await db.insert(schema.providerConnections).values({ id: scope.connectionId, revision: 1,
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    endpoint: "https://127.0.0.1:8443", serverCertificatePem, project: "ezharness",
    configuration: { kind: "incus", profile: "ezharness", helperVersion: "0.1.3", guestUser: "sandbox" },
    clientCertificatePem: certificates.read("client-cert.pem"), privateKeyCiphertext: "test-not-a-secret" });
  await addFixtures(db);
  await addRecovery(db);
  await addRuns(db);
  await db.insert(schema.projects).values({ id: "project", name: "fixture", path: "/fixture",
    purpose: "incus-qualification" });
  await db.insert(schema.sandboxBindings).values({ id: bindingId, projectId: "project",
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    connectionId: scope.connectionId, connectionRevision: 1, profile: preset.profile,
    presetId: scope.presetId, presetDigest: presetDigest,
    effectiveSettingsDigest: "b".repeat(64), resourceKey: bindingId,
    desiredState: "RUNNING", observedState: "UNKNOWN", currentOperationId: operationId });
  await db.insert(schema.incusQualificationFixtures).values({ operationId: fixtureOperationId,
    projectId: "project", bindingId, installationId: scope.installationId,
    releaseId: scope.releaseId, connectionId: scope.connectionId, connectionRevision: 1,
    presetId: scope.presetId, presetDigest: presetDigest,
    effectiveSettingsDigest: "b".repeat(64) });
  const createPayload = { expectedGeneration: 1 };
  await db.insert(schema.sandboxOperations).values({ id: operationId, bindingId,
    kind: "START", generation: 1, idempotencyScope: "incus-qualification-power",
    idempotencyKey: `${fixtureOperationId}:start`,
    payloadHash: operationPayloadHash({ bindingId, kind: "START", generation: 1,
      idempotencyScope: "incus-qualification-power", idempotencyKey: `${fixtureOperationId}:start`,
      payload: createPayload }), requestPayload: createPayload, state: "OUTCOME_UNKNOWN",
    providerOperationId: receipt().payload.providerOperationId, reconcileOrder: 1n });
  await db.insert(schema.sandboxHostCapacities).values({ providerInstallationId: scope.installationId,
    connectionId: scope.connectionId, allocatableMemoryBytes: 1024, allocatableCpuMillicores: 2000,
    allocatablePids: 128, allocatableDiskBytes: 2048, allocatableExecutionSlots: 2,
    safetyMemoryBytes: 0, safetyCpuMillicores: 0, safetyPids: 0,
    safetyDiskBytes: 0, safetyExecutionSlots: 0 });
  await db.insert(schema.sandboxProjectQuotas).values({ projectId: "project",
    providerInstallationId: scope.installationId, connectionId: scope.connectionId,
    memoryBytes: 1024, cpuMillicores: 2000, pids: 128, diskBytes: 2048, executionSlots: 2 });
  await db.insert(schema.sandboxReservations).values({ bindingId, projectId: "project",
    providerInstallationId: scope.installationId, connectionId: scope.connectionId,
    generation: 1, memoryBytes: 512, cpuMillicores: 1000, pids: 64, diskBytes: 1024,
    executionSlots: 1, computeState: "RESERVED", diskState: "RESERVED" });
  await db.insert(schema.sandboxAdmissionRequests).values({ id: "admission", bindingId,
    generation: 1, kind: "CREATE", idempotencyScope: "incus-qualification",
    idempotencyKey: fixtureOperationId, payloadHash: presetDigest, memoryBytes: 512,
    cpuMillicores: 1000, pids: 64, diskBytes: 1024, executionSlots: 1,
    state: "ADMITTED" });
  return { client, db };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => {})));
});

test("signed recovery journals one real DESTROY without changing the uncertain START", async () => {
  const { db } = await setup();
  const original = (await db.select().from(schema.sandboxOperations))[0]!;
  expect(await hasUnfinishedProviderSandboxes(db, scope.installationId)).toBe(true);
  const cleanupId = await applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now);
  const dispatches: string[] = [];
  const controller = new SandboxController(db, {
    dispatch: async request => { dispatches.push(request.operationId); expect(request.generation).toBe(1);
      expect(request.payload.expectedGeneration).toBe(2); return { outcome: "SUCCEEDED", observedState: "ABSENT" }; },
    inspectOperation: async () => { throw new Error("original uncertainty must not be polled"); },
  });
  expect((await db.select().from(schema.sandboxReservations))[0]?.diskState).toBe("RESERVED");
  expect((await controller.getOperation(cleanupId))?.state).toBe("JOURNALED");
  expect(await applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now)).toBe(cleanupId);
  await controller.executeOperation(cleanupId);
  expect(dispatches).toEqual([cleanupId]);
  expect(await controller.getOperation(operationId)).toEqual(original);
  expect((await controller.getBinding(bindingId))?.cleanupConfirmedAt).not.toBeNull();
  expect(await hasUnfinishedProviderSandboxes(db, scope.installationId)).toBe(true);
  await new SandboxAdmissionStore(db).recordObservedState(bindingId, 1, "ABSENT",
    `incus-qualification-destroy-${fixtureOperationId}`, cleanupId);
  expect(await hasUnfinishedProviderSandboxes(db, scope.installationId)).toBe(false);
  await controller.inspectOperation(operationId);
  await controller.reconcile();
  expect(await controller.getOperation(operationId)).toEqual(original);
  expect(dispatches).toEqual([cleanupId]);
}, 30000);

for (const [label, change] of Object.entries({
  signature: (r: FencedCleanupReceipt) => ({ ...r, signature: "invalid" }),
  expired: (r: FencedCleanupReceipt) => receipt({ fenceUntilMs: now }),
  future: (r: FencedCleanupReceipt) => receipt({ second: { ...r.payload.second, observedAtMs: now + 1 } }),
  unfenced: (r: FencedCleanupReceipt) => receipt({ allClientsFenced: false as true }),
  moving: (r: FencedCleanupReceipt) => receipt({ second: { ...r.payload.second, providerGeneration: 3 } }),
  nativePresent: (r: FencedCleanupReceipt) => receipt({ first: { ...r.payload.first, nativeOperationAbsent: false as true } }),
  running: (r: FencedCleanupReceipt) => receipt({ first: { ...r.payload.first, instanceState: "running" as "stopped" } }),
  activeOperation: (r: FencedCleanupReceipt) => receipt({ second: { ...r.payload.second, activeOperations: ["other"] as unknown as [] } }),
})) {
  test(`signed recovery refuses ${label} evidence`, () => {
    expect(() => verifyFencedCleanupReceipt(change(receipt()), publicKeyPem, now)).toThrow();
  });
}

test("changed signed scope, receipt replay, and payload cannot grant cleanup", async () => {
  const { db } = await setup();
  await expect(applyFencedCleanupRecovery(db, receipt({ scope: { ...scope, releaseId: "foreign" } }), publicKeyPem, now)).rejects.toThrow("Provider release is not active and approved");
  const cleanup = await applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now);
  await expect(applyFencedCleanupRecovery(db, receipt({ reviewId: "other-review" }), publicKeyPem, now)).rejects.toThrow("receipt changed");
  expect((await db.select().from(schema.sandboxOperations)).filter(o => o.kind === "DESTROY").map(o => o.id)).toEqual([cleanup]);
  expect((await db.select().from(schema.sandboxReservations))[0]?.diskState).toBe("RESERVED");
}, 30000);

test("a changed original payload blocks recovery before cleanup is journaled", async () => {
  const { db } = await setup();
  await db.update(schema.sandboxOperations).set({ requestPayload: { expectedGeneration: 99 } }).where(eq(schema.sandboxOperations.id, operationId));
  await expect(applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now)).rejects.toThrow("original uncertain power");
  expect(await db.select().from(schema.incusFencedCleanupRecoveries)).toEqual([]);
}, 30000);

test("an old inspection reply cannot rewrite uncertainty after signed compensation", async () => {
  const { db } = await setup();
  const original = (await db.select().from(schema.sandboxOperations))[0]!;
  let complete!: (outcome: { outcome: "SUCCEEDED"; observedState: "RUNNING" }) => void;
  let begun!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; });
  const reply = new Promise<{ outcome: "SUCCEEDED"; observedState: "RUNNING" }>(resolve => { complete = resolve; });
  const controller = new SandboxController(db, {
    dispatch: async () => ({ outcome: "UNKNOWN" }),
    inspectOperation: async () => { begun(); return reply; },
  });
  const late = controller.inspectOperation(operationId);
  await started;
  const cleanup = await applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now);
  complete({ outcome: "SUCCEEDED", observedState: "RUNNING" });
  expect(await late).toEqual(original);
  expect(await controller.getOperation(operationId)).toEqual(original);
  expect((await controller.getBinding(bindingId))?.currentOperationId).toBe(cleanup);
  expect((await controller.getBinding(bindingId))?.desiredState).toBe("ABSENT");
  expect((await controller.getBinding(bindingId))?.cleanupConfirmedAt).toBeNull();
}, 30000);

for (const [label, mutate] of Object.entries({
  userProject: async (db: Awaited<ReturnType<typeof setup>>["db"]) => db.update(schema.projects).set({ purpose: "user" }),
  staleBinding: async (db: Awaited<ReturnType<typeof setup>>["db"]) => db.update(schema.sandboxBindings).set({ generation: 2 }),
  superseded: async (db: Awaited<ReturnType<typeof setup>>["db"]) => db.update(schema.sandboxBindings).set({ currentOperationId: "other" }),
  releasedDisk: async (db: Awaited<ReturnType<typeof setup>>["db"]) => db.update(schema.sandboxReservations).set({ diskState: "RELEASED" }),
  workspace: async (db: Awaited<ReturnType<typeof setup>>["db"]) => db.insert(schema.projectWorkspaceBindings).values({ projectId: "project", kind: "sandbox", bindingId, revision: 1, state: "active" }),
  differentNative: async (db: Awaited<ReturnType<typeof setup>>["db"]) => db.update(schema.sandboxOperations).set({ providerOperationId: "incus-setPower-other" }),
})) {
  test(`signed cleanup refuses ${label} durable drift`, async () => {
    const { db } = await setup();
    await mutate(db);
    await expect(applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now)).rejects.toThrow("operator fenced cleanup denied");
    expect(await db.select().from(schema.incusFencedCleanupRecoveries)).toEqual([]);
    expect((await db.select().from(schema.sandboxOperations)).filter(o => o.kind === "DESTROY")).toEqual([]);
  }, 30000);
}

for (const [label, installationChange, approvalChange] of [
  ["disabled", { enabled: false }, {}],
  ["inactive", { status: "disabled" }, {}],
  ["unacknowledged", { acknowledgedGeneration: 3 }, {}],
  ["changed grants", { grants: ["sandbox-provider:incus"] }, {}],
  ["unconsumed approval", {}, { status: "pending" }],
  ["changed approval grants", {}, { grants: ["sandbox-provider:incus"] }],
] as const) {
  test(`current authority refuses ${label} before compensation`, async () => {
    const { db } = await setup();
    await db.execute(sql`UPDATE extension_release_installations SET payload = (payload::jsonb || ${JSON.stringify(installationChange)}::jsonb)::text WHERE id = ${scope.installationId}`);
    await db.execute(sql`UPDATE extension_release_records SET payload = (payload::jsonb || ${JSON.stringify(approvalChange)}::jsonb)::text WHERE installation_id = ${scope.installationId} AND kind = 'approvals'`);
    await expect(applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now)).rejects.toThrow("Provider release is not active and approved");
    expect(await db.select().from(schema.incusFencedCleanupRecoveries)).toEqual([]);
    expect((await db.select().from(schema.sandboxBindings))[0]?.currentOperationId).toBe(operationId);
  }, 30000);
}

test("signed compensation uses the actual broker with host generation one and provider generation two", async () => {
  const { db } = await setup();
  const cleanupId = await applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now);
  const snapshot = { installation: { id: scope.installationId, generation: 4 }, release: { id: scope.releaseId, releaseDigest, manifest } } as ActiveExtensionRelease;
  const configured = { id: scope.connectionId, revision: 1, providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId, revokedAt: null, endpoint: "https://127.0.0.1:8443", project: "ezharness", serverCertificatePem, clientCertificatePem: certificates.read("client-cert.pem"), privateKeyPem: certificates.read("client-key.pem"), configuration: { kind: "incus" as const, profile: "ezharness", helperVersion: "0.1.3", guestUser: "sandbox" } };
  const connections = { getMetadata: async () => configured, resolveForHost: async () => configured } as ProviderConnectionResolver;
  let present = true;
  let generation = "2";
  let operationTag = receipt().payload.operationTag;
  const writes: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const reply = (metadata: unknown, status = 200) => Response.json({ type: "sync", status_code: status, metadata }, { status, headers: { etag: '"generation-2"' } });
    if (init.method === "GET" && path.includes("/operations/")) return reply({ status: "Success", resources: { instances: [`/1.0/instances/${resourceName(scope.connectionId, bindingId)}`] } });
    if (init.method === "GET") return present ? reply({ name: resourceName(scope.connectionId, bindingId), type: "container", status: "Stopped", profiles: ["ezharness"], config: { "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": scope.connectionId, "user.ezharness.sandbox_id": bindingId, "user.ezharness.profile": preset.profile, "user.ezharness.preset_id": preset.id, "volatile.base_image": preset.imageDigest, "user.ezharness.generation": generation, "user.ezharness.operation_id": operationTag } }) : reply({}, 404);
    writes.push(`${init.method} ${path}`);
    if (init.method === "PATCH") { const body = JSON.parse(String(init.body)); expect(body.config["user.ezharness.generation"]).toBe("3"); generation = "3"; operationTag = body.config["user.ezharness.operation_id"]; return reply({}); }
    expect(init.method).toBe("DELETE");
    present = false;
    return reply({ id: "22222222-2222-2222-2222-222222222222" }, 202);
  };
  const broker = new ProviderRpcBroker(connections, undefined, db, (prepared, _signal, recordAcceptedOperation, recordTerminalObservation) => new HostIncusLifecycleTransport(connections, { providerInstallationId: prepared.installationId, providerReleaseId: prepared.releaseId, revision: prepared.revision, approvedPreset: prepared.approvedPreset, hostContractMinor: prepared.hostContractMinor, recordAcceptedOperation, recordTerminalObservation }, fetcher as never));
  const controller = new SandboxController(db, new IncusSandboxProviderDispatcher({ call: async (_scope, method, input) => {
    const operation: SandboxProtocolOperation = method.endsWith("inspectOperation") ? "lifecycle.inspectOperation" : "lifecycle.destroy";
    if (operation === "lifecycle.destroy") expect(input.expectedGeneration).toBe(2);
    const prepared = await broker.prepareAction(snapshot, bindingId, operation, input);
    return new IncusSandboxAdapter(prepared.expectedCommand.pins, { request: async command => {
      const result = await broker.request(prepared, { command }, Number(input.rpcDeadlineMs)) as { ok: boolean; result?: unknown; error?: { kind: ConstructorParameters<typeof IncusTransportError>[0]; effect: "none" | "unknown"; operationId?: string } };
      if (!result.ok) throw new IncusTransportError(result.error!.kind, "Host denied transport", { effect: result.error!.effect, operationId: result.error!.operationId });
      return result.result;
    } }).invoke(operation, input);
  } }));
  const outcome = await controller.executeOperation(cleanupId);
  expect(outcome.state).toBe("PROVIDER_PENDING");
  expect((await controller.inspectOperation(cleanupId)).state).toBe("SUCCEEDED");
  expect(writes).toEqual([`PATCH /1.0/instances/${resourceName(scope.connectionId, bindingId)}`, `DELETE /1.0/instances/${resourceName(scope.connectionId, bindingId)}`]);
  expect((await db.select().from(schema.sandboxOperations).where(eq(schema.sandboxOperations.id, operationId)))[0]?.state).toBe("OUTCOME_UNKNOWN");
  expect((await db.select().from(schema.sandboxBindings))[0]?.generation).toBe(1);
  expect((await db.select().from(schema.sandboxReservations))[0]?.diskState).toBe("RESERVED");
}, 30000);

for (const observed of [1, 2, 3]) test(`signed observed provider generation ${observed} is bounded by original intent`, async () => {
  const { db } = await setup(); const original = receipt();
  const selected = receipt({ first: { ...original.payload.first, providerGeneration: observed }, second: { ...original.payload.second, providerGeneration: observed } });
  if (observed === 3) { await expect(applyFencedCleanupRecovery(db, selected, publicKeyPem, now)).rejects.toThrow("original uncertain power operation changed"); expect(await db.select().from(schema.incusFencedCleanupRecoveries)).toEqual([]); }
  else { const id = await applyFencedCleanupRecovery(db, selected, publicKeyPem, now); expect((await db.select().from(schema.sandboxOperations).where(eq(schema.sandboxOperations.id, id)))[0]?.requestPayload.expectedGeneration).toBe(observed); }
}, 30000);
