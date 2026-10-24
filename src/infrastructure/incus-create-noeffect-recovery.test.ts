import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { up as addController } from "../db/migrations/add-sandbox-controller";
import { up as addFixtures } from "../db/migrations/add-incus-qualification-fixtures";
import { up as addRecovery } from "../db/migrations/add-incus-noeffect-recoveries";
import { up as addRuns } from "../db/migrations/add-incus-qualification-runs";
import * as schema from "../db/schema";
import { operationPayloadHash } from "../sandboxes/controller";
import { resourceName } from "./incus-transport/lifecycle";
import { applyNoEffectRecovery, canonicalRecoveryJson, type NoEffectRecoveryPayload,
  type NoEffectRecoveryReceipt } from "./incus-create-noeffect-recovery";

const clients: PGlite[] = [];
const fixtureOperationId = "live-fixture-20260924";
const bindingId = "binding-recovery";
const operationId = "62633686-a1bc-4b93-b87a-54fdbc96c2fd";
const scope = { installationId: "installation", releaseId: "release",
  connectionId: "connection", presetId: "incus-compose-v1" };
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const now = Date.now();

function receipt(overrides: Partial<NoEffectRecoveryPayload> = {}): NoEffectRecoveryReceipt {
  const payload: NoEffectRecoveryPayload = { version: 1, action: "recover-noeffect",
    nonce: "nonce-one", reviewId: "review-one", scope, fixtureOperationId, bindingId,
    operationId, generation: 1, connectionRevision: 1,
    resourceName: resourceName(scope.connectionId, bindingId),
    oldProcess: { pid: 123, startTicks: "456" }, stoppedAtMs: now - 85_000,
    fenceUntilMs: now + 30_000, allClientsFenced: true,
    fenceEvidence: "operator stopped all app and runner clients",
    first: { observedAtMs: now - 15_000, instanceState: "absent", activeOperations: [] },
    second: { observedAtMs: now - 9_000, instanceState: "absent", activeOperations: [] },
    ...overrides };
  return { payload, signature: sign(null, Buffer.from(canonicalRecoveryJson(payload)), privateKey).toString("base64") };
}

async function setup(providerOperationId: string | null = null, directory?: string) {
  const client = new PGlite(directory);
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
  await addFixtures(db);
  await addRecovery(db);
  await addRuns(db);
  await db.insert(schema.projects).values({ id: "project", name: "fixture", path: "/fixture",
    purpose: "incus-qualification" });
  await db.insert(schema.sandboxBindings).values({ id: bindingId, projectId: "project",
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    connectionId: scope.connectionId, connectionRevision: 1, profile: "incus-compose",
    presetId: scope.presetId, presetDigest: "a".repeat(64),
    effectiveSettingsDigest: "b".repeat(64), resourceKey: bindingId,
    desiredState: "STOPPED", observedState: "UNKNOWN", currentOperationId: operationId });
  await db.insert(schema.incusQualificationFixtures).values({ operationId: fixtureOperationId,
    projectId: "project", bindingId, installationId: scope.installationId,
    releaseId: scope.releaseId, connectionId: scope.connectionId, connectionRevision: 1,
    presetId: scope.presetId, presetDigest: "a".repeat(64),
    effectiveSettingsDigest: "b".repeat(64) });
  const createPayload = { profile: "incus-compose", presetId: scope.presetId,
    presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64) };
  await db.insert(schema.sandboxOperations).values({ id: operationId, bindingId,
    kind: "CREATE", generation: 1, idempotencyScope: "incus-qualification",
    idempotencyKey: fixtureOperationId,
    payloadHash: operationPayloadHash({ bindingId, kind: "CREATE", generation: 1,
      idempotencyScope: "incus-qualification", idempotencyKey: fixtureOperationId,
      payload: createPayload }), requestPayload: createPayload, state: "OUTCOME_UNKNOWN",
    providerOperationId, reconcileOrder: 1n });
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
    idempotencyKey: fixtureOperationId, payloadHash: "a".repeat(64), memoryBytes: 512,
    cpuMillicores: 1000, pids: 64, diskBytes: 1024, executionSlots: 1,
    state: "ADMITTED" });
  return { client, db };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => {})));
});

test("signed fenced recovery preserves CREATE receipt, records audit, and releases once", async () => {
  const { client, db } = await setup();
  const signed = receipt();
  const cleanupId = await applyNoEffectRecovery(db, signed, publicKeyPem, now);
  const rows = await db.select().from(schema.sandboxOperations);
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.id === operationId)).toMatchObject({
    state: "FAILED", providerOperationId: null, errorCode: "OPERATOR_PROVEN_NO_EFFECT",
    idempotencyKey: fixtureOperationId });
  expect(rows.find(row => row.id === cleanupId)).toMatchObject({ kind: "DESTROY", state: "SUCCEEDED" });
  expect((await db.select().from(schema.sandboxBindings))[0]).toMatchObject({
    observedState: "ABSENT", desiredState: "ABSENT", currentOperationId: cleanupId });
  expect((await db.select().from(schema.sandboxReservations))[0]).toMatchObject({
    computeState: "RELEASED", diskState: "RELEASED" });
  expect((await client.query("SELECT * FROM incus_noeffect_recoveries")).rows).toHaveLength(1);
  await expect(applyNoEffectRecovery(db, signed, publicKeyPem, now)).rejects.toThrow();
});

test("a receipt that expires while the transaction waits cannot change the CREATE", async () => {
  const { db } = await setup();
  const startedAt = Date.now();
  const signed = receipt({ stoppedAtMs: startedAt - 85_000,
    first: { observedAtMs: startedAt - 15_000, instanceState: "absent", activeOperations: [] },
    second: { observedAtMs: startedAt - 9_000, instanceState: "absent", activeOperations: [] },
    fenceUntilMs: startedAt + 500 });
  const delayedDb = { transaction: async (callback: Parameters<typeof db.transaction>[0]) => {
    await Bun.sleep(600);
    return db.transaction(callback);
  } } as typeof db;
  await expect(applyNoEffectRecovery(delayedDb, signed, publicKeyPem, startedAt))
    .rejects.toThrow("invalid or stale fence");
  expect((await db.select().from(schema.sandboxOperations))[0]?.state).toBe("OUTCOME_UNKNOWN");
  expect((await db.select().from(schema.sandboxReservations))[0]?.computeState).toBe("RESERVED");
});

test("offline repair reopens one persistent PGlite database in a second process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "incus-noeffect-"));
  try {
    const { client } = await setup(null, directory);
    await client.close();
    const receiptPath = join(directory, "receipt.json");
    const keyPath = join(directory, "public.pem");
    writeFileSync(receiptPath, JSON.stringify(receipt()));
    writeFileSync(keyPath, publicKeyPem);
    const child = Bun.spawn([process.execPath,
      new URL("./__tests__/incus-noeffect-recovery-worker.ts", import.meta.url).pathname,
      directory, receiptPath, keyPath], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    const reopened = new PGlite(directory);
    clients.push(reopened);
    await reopened.waitReady;
    const operations = await reopened.query<{ kind: string; state: string }>(
      "SELECT kind, state FROM provider_sandbox_operations ORDER BY kind");
    expect(operations.rows).toEqual([
      { kind: "CREATE", state: "FAILED" }, { kind: "DESTROY", state: "SUCCEEDED" }]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("provider ID, stale state, live operation, and broken signature deny repair", async () => {
  const first = await setup("provider-operation");
  await expect(applyNoEffectRecovery(first.db, receipt(), publicKeyPem, now))
    .rejects.toThrow("original CREATE");
  const second = await setup();
  await expect(applyNoEffectRecovery(second.db, receipt({ second: {
    observedAtMs: now - 9_000, instanceState: "absent",
    activeOperations: ["/1.0/operations/late"] } }), publicKeyPem, now))
    .rejects.toThrow("invalid or stale fence");
  const forged = receipt();
  forged.payload.reviewId = "changed";
  await expect(applyNoEffectRecovery(second.db, forged, publicKeyPem, now))
    .rejects.toThrow("signature changed");
  await second.db.update(schema.sandboxBindings).set({ observedState: "RUNNING" })
    .where(eq(schema.sandboxBindings.id, bindingId));
  await expect(applyNoEffectRecovery(second.db, receipt(), publicKeyPem, now))
    .rejects.toThrow("binding changed");
  const [binding] = await second.db.select().from(schema.sandboxBindings);
  expect(binding?.observedState).toBe("RUNNING");
  expect((await second.db.select().from(schema.sandboxOperations))[0]?.state).toBe("OUTCOME_UNKNOWN");
});
