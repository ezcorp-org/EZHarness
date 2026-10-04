import { IncusSandboxAdapter } from "../../extensions/incus-sandbox/adapter";
import { IncusTransportError } from "../../extensions/incus-sandbox/transport";
import { sandboxProviderMethodSchemas, SANDBOX_PROVIDER_OPERATIONS, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import { IncusSandboxProviderDispatcher } from "../sandboxes/incus-dispatcher";
import { ProviderRpcBroker, type ProviderConnectionResolver } from "./provider-rpc-broker";
import { HostIncusLifecycleTransport } from "./incus-transport/lifecycle";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFencedCleanupPhase } from "../../scripts/incus/incus-create-noeffect-recovery";
import { up as migrateFencedCleanup } from "../db/migrations/add-incus-fenced-cleanup-recoveries";
import { createHash, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { incusManifest, INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { makeTestCertificates } from "./incus-transport/test-certificates";
import { up as addReleaseTables } from "../db/migrations/add-extension-releases";
import { up as addConnections } from "../db/migrations/add-provider-connections";
import { eq, sql, not } from "drizzle-orm";
import { compensatedCleanupOriginal } from "./incus-fenced-cleanup-policy";
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
import { applyFencedCleanupRecovery, applyFencedCleanupAbort, inspectFencedCleanupAbort, verifyFencedCleanupReceipt, type FencedCleanupAbortPayload, type FencedCleanupAbortReceipt, type FencedCleanupPayload, type FencedCleanupReceipt } from "./incus-fenced-cleanup-recovery";
const clients: PGlite[] = [];
const fixtureOperationId = "live-fixture-20260924";
const bindingId = "binding-recovery";
const operationId = "62633686-a1bc-4b93-b87a-54fdbc96c2fd";
const scope = { installationId: "installation", releaseId: "release",
  connectionId: "connection", presetId: "incus-compose-v1" };
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const realNow = Date.now.bind(Date);
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

async function setup(path?: string) {
  const client = new PGlite(path);
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
  const visibleOriginal = async () => (await db.select({ id: schema.sandboxOperations.id })
    .from(schema.sandboxOperations).where(not(compensatedCleanupOriginal)))
    .some(row => row.id === operationId);
  expect(await visibleOriginal()).toBe(true);
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
  expect(await visibleOriginal()).toBe(true);
  await new SandboxAdmissionStore(db).recordObservedState(bindingId, 1, "ABSENT",
    `incus-qualification-destroy-${fixtureOperationId}`, cleanupId);
  expect(await hasUnfinishedProviderSandboxes(db, scope.installationId)).toBe(false);
  expect(await visibleOriginal()).toBe(false);
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

function abortReceipt(overrides: Partial<FencedCleanupAbortPayload> = {}, recovery = receipt().payload): FencedCleanupAbortReceipt {
  const { nonce, reviewId, scope, fixtureOperationId, bindingId, operationId, generation, connectionRevision } = recovery;
  const originalRequest = { version: 1 as const, action: "recover-fenced-cleanup" as const, nonce, reviewId, scope,
    fixtureOperationId, bindingId, operationId, generation, connectionRevision, deadlineMs: now - 1,
    allClientsFenced: true as const, fenceEvidence: recovery.fenceEvidence };
  const keys = ["installationGeneration", "releaseDigest", "grantsDigest", "endpoint", "project", "providerOperationId", "nativeOperationId", "operationTag", "payloadHash", "presetDigest", "effectiveSettingsDigest", "imageFingerprint", "helperVersion", "serverCertificateSha256"] as const;
  const pins = Object.fromEntries(keys.map(key => [key, recovery[key]])) as FencedCleanupAbortPayload["pins"];
  const payload: FencedCleanupAbortPayload = { version: 1, action: "abort-fenced-cleanup-before-admission", originalRequest, pins,
    requestSha256: createHash("sha256").update(canonicalRecoveryJson(originalRequest)).digest("hex"),
    holdSha256: createHash("sha256").update(canonicalRecoveryJson({ nonce, reviewId }) + "\n").digest("hex"),
    issuedAtMs: now, expiresAtMs: now + 30_000, ...overrides };
  return { payload, signature: sign(null, Buffer.from(canonicalRecoveryJson(payload)), privateKey).toString("base64") };
}

test("signed pre-admission abort preserves UNKNOWN and blocks the same cleanup nonce", async () => {
  const { db } = await setup();
  const signed = abortReceipt();
  const proof = await applyFencedCleanupAbort(db, signed, publicKeyPem, now);
  expect(proof).toMatchObject({ nonce: signed.payload.originalRequest.nonce, requestSha256: signed.payload.requestSha256, holdSha256: signed.payload.holdSha256 });
  await expect(applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now)).rejects.toThrow("nonce");
  const rows = await db.select().from(schema.sandboxOperations);
  expect(rows.filter(row => row.kind === "DESTROY")).toHaveLength(0);
  expect(rows.find(row => row.id === operationId)?.state).toBe("OUTCOME_UNKNOWN");
});

test("committed abort replay and inspection survive expiry; changed signed receipt refuses", async () => {
  const { db } = await setup();
  const signed = abortReceipt();
  const proof = await applyFencedCleanupAbort(db, signed, publicKeyPem, now);
  expect(await applyFencedCleanupAbort(db, signed, publicKeyPem, now + 60_000)).toEqual(proof);
  expect(await inspectFencedCleanupAbort(db, signed, publicKeyPem)).toEqual(proof);
  await expect(applyFencedCleanupAbort(db, abortReceipt({ issuedAtMs: now + 1 }), publicKeyPem, now + 2)).rejects.toThrow("nonce");
  await expect(inspectFencedCleanupAbort(db, abortReceipt({ issuedAtMs: now + 1 }), publicKeyPem)).rejects.toThrow("proof");
});

test("abort rejects expired, future, malformed and forged proofs without consuming nonce", async () => {
  const { db } = await setup();
  for (const signed of [abortReceipt({ issuedAtMs: now - 60_000, expiresAtMs: now - 30_000 }),
    abortReceipt({ issuedAtMs: now + 1 }), abortReceipt({ requestSha256: "a".repeat(64) }),
    abortReceipt({ holdSha256: "a".repeat(64) }), abortReceipt({ expiresAtMs: now + 30_001 }),
    { ...abortReceipt(), signature: "AAAA" }]) {
    await expect(applyFencedCleanupAbort(db, signed, publicKeyPem, now)).rejects.toThrow();
  }
  expect(await db.select().from(schema.incusFencedCleanupNonceClaims)).toHaveLength(0);
  expect(await inspectFencedCleanupAbort(db, abortReceipt(), publicKeyPem)).toMatchObject({ status: "uncommitted", nonce: "nonce-one" });
});

test("admitted cleanup cannot be aborted and legacy consumed nonce cannot be reused", async () => {
  const { db } = await setup();
  await applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now);
  await expect(applyFencedCleanupAbort(db, abortReceipt(), publicKeyPem, now)).rejects.toThrow("nonce");
  await db.delete(schema.incusFencedCleanupNonceClaims);
  await expect(applyFencedCleanupAbort(db, abortReceipt(), publicKeyPem, now)).rejects.toThrow("nonce");
  expect(await db.select().from(schema.incusFencedCleanupAborts)).toHaveLength(0);
});

function synchronizedActions(actions: Array<() => Promise<unknown>>) {
  let pending = actions.length;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  return Promise.allSettled(actions.map(async action => {
    if (--pending === 0) release();
    await barrier;
    return action();
  }));
}

test("abort and cleanup race has exactly one durable winner", async () => {
  const { db } = await setup();
  const results = await synchronizedActions([() => applyFencedCleanupAbort(db, abortReceipt(), publicKeyPem, now),
    () => applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(await db.select().from(schema.incusFencedCleanupNonceClaims)).toHaveLength(1);
  const aborted = await db.select().from(schema.incusFencedCleanupAborts);
  const recovered = await db.select().from(schema.incusFencedCleanupRecoveries);
  expect(aborted.length + recovered.length).toBe(1);
  expect((await db.select().from(schema.sandboxOperations).where(eq(schema.sandboxOperations.id, operationId)))[0]?.state).toBe("OUTCOME_UNKNOWN");
});


test("abort validation rollback and fresh distinct review leave original authority intact", async () => {
  const { db } = await setup();
  const original = (await db.select().from(schema.sandboxOperations).where(eq(schema.sandboxOperations.id, operationId)))[0];
  const binding = (await db.select().from(schema.sandboxBindings))[0];
  const reservation = (await db.select().from(schema.sandboxReservations))[0];
  clock.mockReturnValue(now + 30_001);
  try { await expect(applyFencedCleanupAbort(db, abortReceipt(), publicKeyPem, now)).rejects.toThrow("before commit"); }
  finally { clock.mockReturnValue(now); }
  expect(await db.select().from(schema.incusFencedCleanupNonceClaims)).toHaveLength(0);
  await applyFencedCleanupAbort(db, abortReceipt(), publicKeyPem, now);
  expect((await db.select().from(schema.sandboxOperations).where(eq(schema.sandboxOperations.id, operationId)))[0]).toEqual(original);
  expect((await db.select().from(schema.sandboxBindings))[0]).toEqual(binding);
  expect((await db.select().from(schema.sandboxReservations))[0]).toEqual(reservation);
  await expect(applyFencedCleanupRecovery(db, receipt({ nonce: "fresh-independent-nonce", reviewId: "fresh-review" }), publicKeyPem, now)).resolves.toBeString();
});

test("shared nonce denies a concurrent recovery on another exact binding", async () => {
  const { db } = await setup();
  const otherBinding = "other-binding", otherOperation = "62633686-a1bc-4b93-b87a-54fdbc96c2fe", otherFixture = "other-fixture";
  const [project] = await db.select().from(schema.projects);
  const [binding] = await db.select().from(schema.sandboxBindings);
  const [fixture] = await db.select().from(schema.incusQualificationFixtures);
  const [operation] = await db.select().from(schema.sandboxOperations);
  const [reservation] = await db.select().from(schema.sandboxReservations);
  await db.insert(schema.projects).values({ ...project!, id: "other-project" });
  await db.insert(schema.sandboxBindings).values({ ...binding!, id: otherBinding, resourceKey: otherBinding, projectId: "other-project", currentOperationId: otherOperation });
  await db.insert(schema.incusQualificationFixtures).values({ ...fixture!, operationId: otherFixture, projectId: "other-project", bindingId: otherBinding });
  const payloadHash = operationPayloadHash({ bindingId: otherBinding, kind: "START", generation: 1,
    idempotencyScope: "incus-qualification-power", idempotencyKey: `${otherFixture}:start`, payload: { expectedGeneration: 1 } });
  await db.insert(schema.sandboxOperations).values({ ...operation!, id: otherOperation, bindingId: otherBinding,
    idempotencyKey: `${otherFixture}:start`, payloadHash });
  await db.insert(schema.sandboxReservations).values({ ...reservation!, bindingId: otherBinding, projectId: "other-project" });
  const other = receipt({ bindingId: otherBinding, operationId: otherOperation, fixtureOperationId: otherFixture, payloadHash,
    resourceName: resourceName(scope.connectionId, otherBinding),
    operationTag: incusLifecycleOperationId("setPower", { connectionId: scope.connectionId,
      sandboxName: resourceName(scope.connectionId, otherBinding), tags: { managedBy: "ezharness-incus-sandbox", connectionId: scope.connectionId, sandboxId: otherBinding },
      idempotency: { requestId: otherOperation, key: otherOperation } } as IncusTransportRequest) });
  const results = await synchronizedActions([() => applyFencedCleanupAbort(db, abortReceipt(), publicKeyPem, now),
    () => applyFencedCleanupRecovery(db, other, publicKeyPem, now)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(await db.select().from(schema.incusFencedCleanupNonceClaims)).toHaveLength(1);
  expect((await db.select().from(schema.incusFencedCleanupAborts)).length + (await db.select().from(schema.incusFencedCleanupRecoveries)).length).toBe(1);
});

test("migration backfills legacy consumed nonces idempotently", async () => {
  const { db } = await setup();
  await applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now);
  await db.delete(schema.incusFencedCleanupNonceClaims);
  await migrateFencedCleanup(db); await migrateFencedCleanup(db);
  expect(await db.select().from(schema.incusFencedCleanupNonceClaims)).toMatchObject([{ nonce: "nonce-one", action: "recovery", operationId, bindingId }]);
});

test("offline abort CLI commits then SELECT-only inspection matches exact signer proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "incus-abort-cli-"));
  const path = join(root, "db");
  const { client } = await setup(path);
  await client.close(); clients.splice(clients.indexOf(client), 1);
  const saved = { db: process.env.EZCORP_INCUS_SUPERVISOR_DB_PATH, key: process.env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY,
    b64: process.env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64, external: process.env.DATABASE_URL };
  process.env.EZCORP_INCUS_SUPERVISOR_DB_PATH = path;
  process.env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY = publicKeyPem;
  delete process.env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64; delete process.env.DATABASE_URL;
  try {
    const issuedAtMs = realNow();
    const signed = abortReceipt({ issuedAtMs, expiresAtMs: issuedAtMs + 30_000 });
    const child = Bun.spawn([process.execPath, "scripts/incus/incus-create-noeffect-recovery.ts"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    child.stdin.write(JSON.stringify({ phase: "abort", receipt: signed, publicKeyPem })); child.stdin.end();
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    const proof = JSON.parse(stdout);
    expect(proof).toMatchObject({ nonce: signed.payload.originalRequest.nonce, requestSha256: signed.payload.requestSha256 });
    expect(await handleFencedCleanupPhase({ phase: "inspect-abort", receipt: signed, publicKeyPem })).toEqual(proof);
    const { originalRequest: r, pins } = signed.payload;
    const target = { action: "recover-fenced-cleanup", scope: r.scope, fixtureOperationId: r.fixtureOperationId,
      bindingId: r.bindingId, operationId: r.operationId, generation: r.generation, connectionRevision: r.connectionRevision, pins };
    expect(await handleFencedCleanupPhase({ phase: "durable", target })).toEqual({ verified: true, pins });
    expect(await handleFencedCleanupPhase({ phase: "apply", receipt: receipt({ nonce: "independent-cli-cleanup" }), publicKeyPem })).toMatchObject({ cleanupOperationId: expect.any(String) });
    await expect(handleFencedCleanupPhase({ phase: "abort", receipt: signed, publicKeyPem, extra: true })).rejects.toThrow("fields");
    const wrong = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
    await expect(handleFencedCleanupPhase({ phase: "abort", receipt: signed, publicKeyPem: wrong })).rejects.toThrow("configured");
  } finally {
    for (const [key, value] of Object.entries({ EZCORP_INCUS_SUPERVISOR_DB_PATH: saved.db,
      EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY: saved.key, EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64: saved.b64, DATABASE_URL: saved.external })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});


test("expired uncommitted inspection permits only explicitly fresh same-request abort", async () => {
  const { db } = await setup();
  const expired = abortReceipt({ issuedAtMs: now - 60_000, expiresAtMs: now - 30_000 });
  expect(await inspectFencedCleanupAbort(db, expired, publicKeyPem)).toMatchObject({ status: "uncommitted", requestSha256: expired.payload.requestSha256 });
  const fresh = abortReceipt();
  const proof = await applyFencedCleanupAbort(db, fresh, publicKeyPem, now);
  await expect(inspectFencedCleanupAbort(db, expired, publicKeyPem)).rejects.toThrow("changed");
  expect(await inspectFencedCleanupAbort(db, fresh, publicKeyPem)).toEqual(proof);
});

test("late old abort commit cannot be replaced after uncommitted inspection", async () => {
  const { db } = await setup();
  const original = abortReceipt();
  expect(await inspectFencedCleanupAbort(db, original, publicKeyPem)).toMatchObject({ status: "uncommitted" });
  const oldProof = await applyFencedCleanupAbort(db, original, publicKeyPem, now);
  await expect(applyFencedCleanupAbort(db, abortReceipt({ issuedAtMs: now + 1 }), publicKeyPem, now + 2)).rejects.toThrow("nonce");
  expect(await inspectFencedCleanupAbort(db, original, publicKeyPem)).toEqual(oldProof);
});

test("uncommitted inspection never treats admitted cleanup or broken storage as absence", async () => {
  const { db } = await setup();
  await applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now);
  await expect(inspectFencedCleanupAbort(db, abortReceipt(), publicKeyPem)).rejects.toThrow("claimed");
  const other = await setup();
  await other.db.execute(sql`DROP TABLE incus_fenced_cleanup_aborts`);
  await expect(inspectFencedCleanupAbort(other.db, abortReceipt(), publicKeyPem)).rejects.toThrow();
});

test("abort and uncommitted inspection reject already-admitted target even with a different nonce", async () => {
  const { db } = await setup();
  await applyFencedCleanupRecovery(db, receipt(), publicKeyPem, now);
  const signed = abortReceipt({}, receipt({ nonce: "unused-abort-nonce" }).payload);
  await expect(applyFencedCleanupAbort(db, signed, publicKeyPem, now)).rejects.toThrow("already admitted");
  await expect(inspectFencedCleanupAbort(db, signed, publicKeyPem)).rejects.toThrow("already admitted");
  expect(await db.select().from(schema.incusFencedCleanupNonceClaims)).toHaveLength(1);
});

test("abort refuses changed original state, payload, current binding and signed scope", async () => {
  const { db } = await setup();
  for (const change of [{ state: "SUCCEEDED" as const }, { requestPayload: { expectedGeneration: 2 } }]) {
    const [original] = await db.select().from(schema.sandboxOperations).where(eq(schema.sandboxOperations.id, operationId));
    await db.update(schema.sandboxOperations).set(change).where(eq(schema.sandboxOperations.id, operationId));
    await expect(applyFencedCleanupAbort(db, abortReceipt(), publicKeyPem, now)).rejects.toThrow("original operation");
    await db.update(schema.sandboxOperations).set(original!).where(eq(schema.sandboxOperations.id, operationId));
  }
  await db.update(schema.sandboxBindings).set({ desiredState: "STOPPED" }).where(eq(schema.sandboxBindings.id, bindingId));
  await expect(applyFencedCleanupAbort(db, abortReceipt(), publicKeyPem, now)).rejects.toThrow("original operation");
  await db.update(schema.sandboxBindings).set({ desiredState: "RUNNING" }).where(eq(schema.sandboxBindings.id, bindingId));
  const base = abortReceipt();
  const changed = abortReceipt({ originalRequest: { ...base.payload.originalRequest, scope: { ...scope, presetId: "other" } } });
  await expect(applyFencedCleanupAbort(db, changed, publicKeyPem, now)).rejects.toThrow("hash");
  expect(await db.select().from(schema.incusFencedCleanupNonceClaims)).toHaveLength(0);
});

test("inspection observes the exact old abort that commits between lookup and binding lock", async () => {
  const { db } = await setup();
  const signed = abortReceipt();
  let proof: Awaited<ReturnType<typeof applyFencedCleanupAbort>> | undefined;
  // Sample the genuine absent row first, then commit on the same real database
  // before the inspector takes its transaction lock. No clock or storage fake.
  const observer = {
    select: () => ({ from: (table: typeof schema.incusFencedCleanupAborts) => ({ where: async (predicate: ReturnType<typeof eq>) => {
      const rows = await db.select().from(table).where(predicate);
      proof = await applyFencedCleanupAbort(db, signed, publicKeyPem, now);
      return rows;
    } }) }),
    transaction: db.transaction.bind(db),
  };
  expect(await inspectFencedCleanupAbort(observer, signed, publicKeyPem)).toEqual(proof!);
});


test("actual Python abort signer and hold archive compose with production Bun CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "incus-abort-python-cli-"));
  const path = join(root, "db");
  const { client } = await setup(path);
  await client.close(); clients.splice(clients.indexOf(client), 1);
  const { originalRequest, pins } = abortReceipt({}, receipt({ fenceEvidence: "operator stopped clients — café 🧪" }).payload).payload;
  const keyPath = join(root, "supervisor-key.pem");
  const originalPath = join(root, "original-request.json"), sealedPath = join(root, "sealed.json");
  writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(originalPath, JSON.stringify(originalRequest, null, 2) + "\n", { mode: 0o600 });
  const target = { scope: originalRequest.scope, fixtureOperationId: originalRequest.fixtureOperationId,
    bindingId: originalRequest.bindingId, operationId: originalRequest.operationId,
    generation: originalRequest.generation, connectionRevision: originalRequest.connectionRevision };
  writeFileSync(sealedPath, JSON.stringify({ version: 1, action: "recover-fenced-cleanup", target, pins }), { mode: 0o600 });
  const python = `import hashlib, importlib.util, json, os, sys
from pathlib import Path
source, root, bun, cli = map(Path, sys.argv[1:5])
spec = importlib.util.spec_from_file_location('supervisor', source)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
original_file = root/'original-request.json'
original = json.loads(original_file.read_text())
s = m.Supervisor(str(root/'unused.sock'), ['must-not-start'], os.getuid(), os.getgid(), root/'supervisor-key.pem', ['true'], ['true'], enforce_distinct_uid=False)
s.recovery_request_path=original_file
s.recovery_abort_command=[str(bun),str(cli)]
s.set_recovery_hold(original)
request={'version':1,'action':'abort-fenced-cleanup-before-admission','originalRequest':original,
 'requestFileSha256':hashlib.sha256(original_file.read_bytes()).hexdigest(),
 'requestSha256':hashlib.sha256(m.canonical(original)).hexdigest(),
 'holdSha256':hashlib.sha256(s.recovery_hold_path.read_bytes()).hexdigest()}
try:
 s.abort_recovery({**request,'extra':'unreviewed'})
 raise AssertionError('extra fields accepted')
except ValueError:
 pass
assert s.recovery_hold_path.exists()
proof=s.abort_recovery(request)
assert not s.recovery_hold_path.exists() and s.child is None
assert s.abort_recovery(request)==proof
print(json.dumps(proof))`;
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", EZCORP_INCUS_SUPERVISOR_DB_PATH: path,
    EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY: publicKeyPem, EZCORP_INCUS_FENCED_CLEANUP_CONFIG: sealedPath };
  delete env.DATABASE_URL; delete env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY_B64;
  try {
    const child = Bun.spawn(["python3", "-c", python, join(import.meta.dir, "../../scripts/incus/incus-qualification-supervisor.py"),
      root, process.execPath, join(import.meta.dir, "../../scripts/incus/incus-create-noeffect-recovery.ts")], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    const proof = JSON.parse(stdout);
    const reopened = new PGlite(path); clients.push(reopened); await reopened.waitReady;
    const db = drizzle(reopened, { schema });
    const aborts = await db.select().from(schema.incusFencedCleanupAborts);
    expect(aborts).toHaveLength(1);
    const saved = aborts[0]!;
    expect(proof).toEqual({ abortId: saved.id, nonce: originalRequest.nonce,
      requestSha256: createHash("sha256").update(canonicalRecoveryJson(originalRequest)).digest("hex"),
      holdSha256: createHash("sha256").update(canonicalRecoveryJson({ nonce: originalRequest.nonce, reviewId: originalRequest.reviewId }) + "\n").digest("hex"),
      receiptSha256: saved.receiptSha256 });
    const archived = keyPath + ".noeffect-hold.aborted." + proof.requestSha256;
    expect(readFileSync(archived, "utf8")).toBe(canonicalRecoveryJson({ nonce: originalRequest.nonce, reviewId: originalRequest.reviewId }) + "\n");
    expect(await db.select().from(schema.incusFencedCleanupRecoveries)).toHaveLength(0);
    const operations = await db.select().from(schema.sandboxOperations);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ id: operationId, state: "OUTCOME_UNKNOWN", providerOperationId: pins.providerOperationId, payloadHash: pins.payloadHash });
    await reopened.close(); clients.splice(clients.indexOf(reopened), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
