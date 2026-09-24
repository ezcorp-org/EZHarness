import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import { up as addQualificationFixtures } from "../db/migrations/add-incus-qualification-fixtures";
import * as schema from "../db/schema";
import { HostIncusLostDestroyReplyFault, readIncusLostDestroyReplyState } from "./incus-destroy-reply-fault";

const scope = { installationId: "installation-a", releaseId: "release-a",
  connectionId: "connection-a", presetId: "preset-a" };
const arm = { runId: "run-a", nonce: "nonce-a", deadlineMs: Date.now() + 30_000,
  scope, fixtureOperationId: "fixture-a", bindingId: "binding-a",
  destroyOperationId: "destroy-a", generation: 1, providerGeneration: 1, connectionRevision: 1 };
const transportScope = { providerInstallationId: scope.installationId,
  providerReleaseId: scope.releaseId, revision: 1 };
const command = { action: "instance.destroy" as const, connectionId: scope.connectionId,
  tags: { sandboxId: arm.bindingId }, idempotency: { requestId: arm.destroyOperationId,
    key: arm.destroyOperationId }, payload: { expectedGeneration: 1 } };

async function fixture() {
  const server = new PGlite();
  await server.waitReady;
  await server.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await server.exec("CREATE TABLE provider_connections (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, provider_installation_id TEXT NOT NULL, provider_release_id TEXT NOT NULL, endpoint TEXT NOT NULL, server_certificate_pem TEXT NOT NULL, project TEXT NOT NULL, configuration JSONB, client_certificate_pem TEXT NOT NULL, private_key_ciphertext TEXT NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const db = drizzle(server, { schema });
  await addSandboxController(db);
  await addQualificationFixtures(db);
  await db.insert(schema.projects).values({ id: "project-a", name: "fixture", path: "/fixture", purpose: "incus-qualification" });
  await db.insert(schema.providerConnections).values({ id: scope.connectionId, revision: 1,
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    endpoint: "https://127.0.0.1", serverCertificatePem: "cert", project: "sandbox",
    clientCertificatePem: "client", privateKeyCiphertext: "ciphertext" });
  await db.insert(schema.sandboxBindings).values({ id: arm.bindingId, projectId: "project-a",
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    connectionId: scope.connectionId, connectionRevision: 1, resourceKey: arm.bindingId,
    desiredState: "ABSENT", observedState: "STOPPED", currentOperationId: arm.destroyOperationId });
  await db.insert(schema.incusQualificationFixtures).values({ operationId: arm.fixtureOperationId,
    projectId: "project-a", bindingId: arm.bindingId, installationId: scope.installationId,
    releaseId: scope.releaseId, connectionId: scope.connectionId, connectionRevision: 1,
    presetId: scope.presetId, presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64) });
  await db.insert(schema.sandboxOperations).values({ id: arm.destroyOperationId,
    bindingId: arm.bindingId, kind: "DESTROY", generation: 1,
    idempotencyScope: "incus-qualification", idempotencyKey: `${arm.fixtureOperationId}:destroy`,
    payloadHash: "hash", requestPayload: { expectedGeneration: 1 }, state: "JOURNALED" });
  await db.insert(schema.sandboxHostCapacities).values({ providerInstallationId: scope.installationId,
    connectionId: scope.connectionId, allocatableMemoryBytes: 10, allocatableCpuMillicores: 10,
    allocatablePids: 10, allocatableDiskBytes: 10, allocatableExecutionSlots: 10,
    safetyMemoryBytes: 0, safetyCpuMillicores: 0, safetyPids: 0, safetyDiskBytes: 0,
    safetyExecutionSlots: 0 });
  await db.insert(schema.sandboxReservations).values({ bindingId: arm.bindingId, projectId: "project-a",
    providerInstallationId: scope.installationId, connectionId: scope.connectionId,
    generation: 1, memoryBytes: 1, cpuMillicores: 1, pids: 1, diskBytes: 1, executionSlots: 1,
    computeState: "RELEASED", diskState: "RELEASE_REQUESTED",
    cleanupIntentId: `incus-qualification-destroy-${arm.fixtureOperationId}` });
  return { db, server };
}

test("operator arm is exact and single-use; readback retains the original unknown destroy", async () => {
  const { db, server } = await fixture();
  try {
    let authenticated = 0;
    let authorized = 0;
    const fault = new HostIncusLostDestroyReplyFault(db, {
      authenticateOperator: async () => { authenticated++; },
      authorizeRun: async () => { authorized++; },
    });
    await expect(fault.arm({ ...arm, bindingId: "user-binding" })).rejects.toThrow();
    await expect(fault.arm({ ...arm, destroyOperationId: "other-destroy" })).rejects.toThrow();
    await expect(fault.arm({ ...arm, connectionRevision: 2 })).rejects.toThrow();
    await db.update(schema.projects).set({ purpose: "user" });
    await expect(fault.arm(arm)).rejects.toThrow();
    await db.update(schema.projects).set({ purpose: "incus-qualification" });
    await fault.arm(arm);
    expect(authenticated).toBe(5);
    expect(authorized).toBe(1);
    expect(fault.matches(command as never, transportScope)).toBe(true);
    expect(fault.matches({ ...command, idempotency: { requestId: "other", key: "other" } } as never, transportScope)).toBe(false);
    expect(fault.matches({ ...command, payload: { expectedGeneration: 2 } } as never, transportScope)).toBe(false);
    expect(fault.matches(command as never, { ...transportScope, revision: 2 })).toBe(false);
    expect(fault.consume(command as never, transportScope)).toBe(true);
    expect(fault.consume(command as never, transportScope)).toBe(false);
    await expect(fault.arm(arm)).rejects.toThrow();
    await db.update(schema.sandboxOperations).set({ state: "OUTCOME_UNKNOWN",
      providerOperationId: "incus-destroy-11111111-1111-1111-1111-111111111111" });
    const readback = await readIncusLostDestroyReplyState(db, arm);
    expect(readback).toMatchObject({ fixtureOperationId: arm.fixtureOperationId,
      bindingId: arm.bindingId, generation: 1, cleanupIntentId: "incus-qualification-destroy-fixture-a",
      destroyOperationId: arm.destroyOperationId,
      providerOperationId: "incus-destroy-11111111-1111-1111-1111-111111111111",
      operationState: "OUTCOME_UNKNOWN", desiredState: "ABSENT",
      reservationDiskState: "RELEASE_REQUESTED", fact: "RECONCILE_REQUIRED" });
    await expect(readIncusLostDestroyReplyState(db, { ...arm, bindingId: "user-binding" })).rejects.toThrow();
  } finally { await server.close(); }
}, 30_000);
