import { resourceName } from "./incus-transport/lifecycle";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { makeTestCertificates } from "./incus-transport/test-certificates";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createIncusTransportCommand } from "../../extensions/incus-sandbox/adapter";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";
import { IncusTransportError, type IncusTransportRequest } from "../../extensions/incus-sandbox/transport";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import * as schema from "../db/schema";
import { SandboxController } from "../sandboxes/controller";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { guestHelperSha256 } from "./incus-guest/protocol";
import {
  ProviderRpcBroker,
  type PreparedIncusAction,
  type ProviderConnectionResolver,
} from "./provider-rpc-broker";

const open: PGlite[] = [];
const observerCertificates = makeTestCertificates();
afterAll(() => observerCertificates.dispose());

async function setup(reply: (command: IncusTransportRequest) => unknown = () => ({ ok: true, file: { path: "src/app.ts" } })) {
  const pglite = new PGlite();
  open.push(pglite);
  await pglite.waitReady;
  await pglite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'user', icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const db = drizzle(pglite, { schema });
  await addSandboxController(db);
  await db.insert(schema.projects).values({ id: "project", name: "project", path: "/work/project" });
  const controller = new SandboxController(db, {
    dispatch: async () => { throw new Error("unexpected dispatch"); },
    inspectOperation: async () => { throw new Error("unexpected inspection"); },
  });
  await controller.createBinding({ id: "binding", projectId: "project", providerInstallationId: "installation",
    providerReleaseId: "release", connectionId: "connection", connectionRevision: 1,
    profile: "linux-exec.v1", presetId: "incus-linux-exec-v1", presetDigest: "a".repeat(64),
    effectiveSettingsDigest: "b".repeat(64), resourceKey: "binding",
    desiredState: "RUNNING", observedState: "RUNNING" });
  const config = { connectionId: "connection", serverCertificateSha256: "c".repeat(64),
    project: "ezharness", profile: "ezharness-feature", helperVersion: "0.1.0", guestUser: "sandbox" };
  const connections = { resolveForHost: async () => { throw new Error("unexpected connection lookup"); },
    getMetadata: async () => null } as unknown as ProviderConnectionResolver;
  const calls: IncusTransportRequest[] = [];
  const broker = new ProviderRpcBroker(connections, () => { throw new Error("unexpected probe"); }, db,
    () => ({ request: async command => { calls.push(command); return reply(command); } }));
  const scope = (operation: PreparedIncusAction["operation"], input: Record<string, unknown>): PreparedIncusAction => ({
    installationId: "installation", releaseId: "release", releaseDigest: "d".repeat(64), generation: 1,
    connectionId: "connection", revision: 1, config, operation, method: `incus/${operation.replace(".", "/")}`,
    bindingId: "binding", projectId: "project", bindingGeneration: 1, resourceKey: "binding",
    approvedPreset: { profile: "linux-exec.v1", incusProfile: "ezharness-feature", presetId: "incus-linux-exec-v1", presetDigest: "a".repeat(64),
      effectiveSettingsDigest: "b".repeat(64), imageFingerprint: "e".repeat(64),
      limits: { memoryBytes: 1_073_741_824, cpuMillis: 1_000, pids: 256, diskBytes: 5_368_709_120 } },
    approvedGuest: { user: "sandbox", uid: 1000, gid: 1000, helperSha256: "f".repeat(64) },
    expectedCommand: createIncusTransportCommand(operation, input, config),
  });
  return { broker, calls, scope, db, connections };
}

afterEach(async () => { await Promise.all(open.splice(0).map(database => database.close())); });

test("reviewed Incus presets pin the shipped guest helper", () => {
  for (const preset of incusManifest.sandboxProviders![0]!.presets) {
    expect(preset.helperDigests).toContain(guestHelperSha256());
  }
});

test("host broker routes a pinned guest read and denies changed worker command", async () => {
  const { broker, calls, scope } = await setup();
  const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding",
    rpcDeadlineMs: Date.now() + 30_000, path: "src/app.ts" };
  const action = scope("files.stat", input);
  const reply = await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs);
  expect(reply).toMatchObject({ ok: true, result: { ok: true, file: { path: "src/app.ts" } } });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.action).toBe("helper.file.stat");
  const forged = structuredClone(action.expectedCommand);
  forged.payload = { path: "../../host" };
  expect(await broker.request(action, { command: forged }, input.rpcDeadlineMs)).toMatchObject({
    ok: false, error: { kind: "permission" },
  });
  expect(calls).toHaveLength(1);
});

test("legacy CREATE inspection gains only its exact host-journaled identity after worker command approval", async () => {
  const { broker, calls, scope, db } = await setup();
  const nativeId = "incus-create-11111111-1111-1111-1111-111111111111";
  const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding",
    rpcDeadlineMs: Date.now() + 30_000, operationId: nativeId };
  const action = { ...scope("lifecycle.inspectOperation", input), approvedGuest: undefined };
  expect(action.expectedCommand.idempotency).toBeUndefined();
  await db.insert(schema.sandboxOperations).values({ id: "journal-create", bindingId: "binding", kind: "CREATE",
    generation: 1, idempotencyScope: "feature", idempotencyKey: "client-key", payloadHash: "hash",
    requestPayload: { profile: "linux-exec.v1", presetId: "incus-linux-exec-v1", presetDigest: "a".repeat(64),
      effectiveSettingsDigest: "b".repeat(64) }, state: "OUTCOME_UNKNOWN", providerOperationId: nativeId });
  await db.update(schema.sandboxBindings).set({ currentOperationId: "journal-create", desiredState: "STOPPED", observedState: "UNKNOWN" });

  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs)).toMatchObject({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.idempotency).toEqual({ requestId: "journal-create", key: "journal-create" });
  expect(calls[0]?.payload).toEqual({ operationId: nativeId });

  const stableId = `ezh-create-${createHash("sha256").update("connection").update("\0").update("binding").digest("hex").slice(0, 32)}-${createHash("sha256").update("connection\0binding\0journal-create\0journal-create\0create").digest("hex").slice(0, 32)}`;
  await db.update(schema.sandboxOperations).set({ providerOperationId: stableId });
  const stableInput = { ...input, operationId: stableId };
  const stableAction = { ...scope("lifecycle.inspectOperation", stableInput), approvedGuest: undefined };
  expect(await broker.request(stableAction, { command: stableAction.expectedCommand }, input.rpcDeadlineMs)).toMatchObject({ ok: true });
  expect(calls[1]?.idempotency).toEqual({ requestId: "journal-create", key: "journal-create" });
  expect(calls[1]?.payload).toEqual({ operationId: stableId });
  await db.update(schema.sandboxOperations).set({ providerOperationId: nativeId });

  const forged = { ...action.expectedCommand, payload: { operationId: "incus-create-22222222-2222-2222-2222-222222222222" } };
  expect(await broker.request(action, { command: forged }, input.rpcDeadlineMs)).toMatchObject({ ok: false, error: { kind: "permission" } });
  const wrongBinding: PreparedIncusAction = { ...action, bindingId: "other-binding" };
  expect(await broker.request(wrongBinding, { command: action.expectedCommand }, input.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxOperations).set({ providerOperationId: "incus-create-22222222-2222-2222-2222-222222222222" });
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs)).toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxOperations).set({ providerOperationId: nativeId });
  await db.insert(schema.sandboxOperations).values({ id: "queued-cleanup", bindingId: "binding", kind: "DESTROY",
    generation: 1, idempotencyScope: "cleanup", idempotencyKey: "cleanup", payloadHash: "cleanup",
    requestPayload: { expectedGeneration: 1 }, state: "JOURNALED" });
  await db.update(schema.sandboxBindings).set({ currentOperationId: "queued-cleanup", desiredState: "ABSENT", tombstonedAt: new Date() });
  const before = await db.select().from(schema.sandboxOperations);
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs)).toMatchObject({ ok: true });
  expect(await db.select().from(schema.sandboxOperations)).toEqual(before);
  await db.update(schema.sandboxOperations).set({ requestPayload: { expectedGeneration: 2 } }).where(eq(schema.sandboxOperations.id, "queued-cleanup"));
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs)).toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxBindings).set({ currentOperationId: "other-journal" });
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs)).toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxBindings).set({ currentOperationId: "journal-create", presetId: "other-preset" });
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs)).toMatchObject({ ok: false, error: { kind: "permission" } });
  expect(calls).toHaveLength(3);
});

test("expired power inspection keeps the controller fence while advancing the Incus guest generation", async () => {
  const { broker, calls, scope, db } = await setup();
  await db.insert(schema.sandboxOperations).values({ id: "journal-create", bindingId: "binding", kind: "CREATE",
    generation: 1, idempotencyScope: "feature", idempotencyKey: "create", payloadHash: "hash-create",
    requestPayload: { profile: "linux-exec.v1", presetId: "incus-linux-exec-v1", presetDigest: "a".repeat(64),
      effectiveSettingsDigest: "b".repeat(64) }, state: "SUCCEEDED" });
  const nativeId = "incus-setPower-11111111-1111-1111-1111-111111111111";
  const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding",
    rpcDeadlineMs: Date.now() + 30_000, operationId: nativeId };
  const action = { ...scope("lifecycle.inspectOperation", input), approvedGuest: undefined };
  await db.insert(schema.sandboxOperations).values({ id: "journal-start", bindingId: "binding", kind: "START",
    generation: 1, idempotencyScope: "feature", idempotencyKey: "client-key", payloadHash: "hash",
    requestPayload: { expectedGeneration: 1 }, state: "PROVIDER_PENDING", providerOperationId: nativeId });
  await db.update(schema.sandboxBindings).set({ currentOperationId: "journal-start", desiredState: "RUNNING", observedState: "STOPPED" });
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs)).toMatchObject({ ok: true });
  expect(calls[0]?.idempotency).toEqual({ requestId: "journal-start", key: "journal-start" });
  expect(calls[0]?.payload).toEqual({ operationId: nativeId,
    readback: { expectedGeneration: 1, desiredState: "running" } });
  await db.update(schema.sandboxOperations).set({ state: "SUCCEEDED" })
    .where(eq(schema.sandboxOperations.id, "journal-start"));
  await db.update(schema.sandboxBindings).set({ currentOperationId: "other-journal" });
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  expect(calls).toHaveLength(1);
  await db.update(schema.sandboxBindings).set({ currentOperationId: "journal-start", generation: 2 });
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxBindings).set({ generation: 1, presetDigest: "wrong-preset" });
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxBindings).set({ presetDigest: "a".repeat(64) });
  await db.update(schema.sandboxOperations).set({ providerOperationId: "incus-setPower-33333333-3333-3333-3333-333333333333" });
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  expect(calls).toHaveLength(1);

  // CREATE produced guest generation 1; START produced guest generation 2.
  // Qualification power operations retain controller binding generation 1.
  const stopId = "incus-setPower-22222222-2222-2222-2222-222222222222";
  await db.insert(schema.sandboxOperations).values({ id: "journal-stop", bindingId: "binding", kind: "STOP",
    generation: 1, idempotencyScope: "feature", idempotencyKey: "client-stop", payloadHash: "hash-stop",
    requestPayload: { expectedGeneration: 2 }, state: "PROVIDER_PENDING", providerOperationId: stopId });
  await db.update(schema.sandboxBindings).set({ currentOperationId: "journal-stop",
    desiredState: "STOPPED", observedState: "RUNNING" });
  const stopInput = { ...input, operationId: stopId };
  const stopAction = { ...scope("lifecycle.inspectOperation", stopInput), approvedGuest: undefined };
  expect(await broker.request(stopAction, { command: stopAction.expectedCommand }, stopInput.rpcDeadlineMs)).toMatchObject({ ok: true });
  expect(calls[1]?.idempotency).toEqual({ requestId: "journal-stop", key: "journal-stop" });
  expect(calls[1]?.payload).toEqual({ operationId: stopId,
    readback: { expectedGeneration: 2, desiredState: "stopped" } });
  const forged = { ...stopAction.expectedCommand, payload: { operationId: stopId,
    readback: { expectedGeneration: 999, desiredState: "stopped" } } };
  expect(await broker.request(stopAction, { command: forged }, stopInput.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxBindings).set({ currentOperationId: "journal-start" });
  expect(await broker.request(stopAction, { command: stopAction.expectedCommand }, stopInput.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxBindings).set({ currentOperationId: "journal-stop", generation: 2 });
  expect(await broker.request(stopAction, { command: stopAction.expectedCommand }, stopInput.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxBindings).set({ generation: 1, presetDigest: "f".repeat(64) });
  expect(await broker.request(stopAction, { command: stopAction.expectedCommand }, stopInput.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxBindings).set({ presetDigest: "a".repeat(64) });
  expect(await broker.request({ ...stopAction, revision: 2 }, { command: stopAction.expectedCommand }, stopInput.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxOperations).set({ providerOperationId: nativeId })
    .where(eq(schema.sandboxOperations.id, "journal-stop"));
  expect(await broker.request(stopAction, { command: stopAction.expectedCommand }, stopInput.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxOperations).set({ providerOperationId: stopId,
    requestPayload: { expectedGeneration: 0 } }).where(eq(schema.sandboxOperations.id, "journal-stop"));
  expect(await broker.request(stopAction, { command: stopAction.expectedCommand }, stopInput.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxOperations).set({ requestPayload: { expectedGeneration: 2, desiredState: "stopped" } })
    .where(eq(schema.sandboxOperations.id, "journal-stop"));
  expect(await broker.request(stopAction, { command: stopAction.expectedCommand }, stopInput.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  expect(calls).toHaveLength(2);
});

test("START, STOP, and DESTROY readbacks use persisted guest generations independent of the binding fence", async () => {
  const { broker, calls, scope, db } = await setup();
  const steps = [
    { kind: "START", desiredState: "RUNNING", providerGeneration: 2, guestState: "running" },
    { kind: "STOP", desiredState: "STOPPED", providerGeneration: 3, guestState: "stopped" },
    { kind: "DESTROY", desiredState: "ABSENT", providerGeneration: 3, guestState: "absent" },
  ] as const;
  for (const [index, step] of steps.entries()) {
    const journalId = `journal-${step.kind.toLowerCase()}`;
    const operationId = `incus-${step.kind === "DESTROY" ? "destroy" : "setPower"}-${String(index + 1).repeat(8)}-1111-1111-1111-111111111111`;
    await db.insert(schema.sandboxOperations).values({ id: journalId, bindingId: "binding", kind: step.kind,
      generation: 1, idempotencyScope: "feature", idempotencyKey: journalId,
      payloadHash: journalId, requestPayload: { expectedGeneration: step.providerGeneration },
      state: "OUTCOME_UNKNOWN", providerOperationId: operationId });
    await db.update(schema.sandboxBindings).set({ currentOperationId: journalId,
      desiredState: step.desiredState, observedState: step.kind === "START" ? "STOPPED" : "RUNNING",
      tombstonedAt: step.kind === "DESTROY" ? new Date() : null });
    const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding",
      rpcDeadlineMs: Date.now() + 30_000, operationId };
    const action = { ...scope("lifecycle.inspectOperation", input), approvedGuest: undefined };
    expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs))
      .toMatchObject({ ok: true });
    expect(calls.at(-1)?.payload).toEqual({ operationId,
      readback: { expectedGeneration: step.providerGeneration, desiredState: step.guestState } });
    expect(calls.at(-1)?.idempotency).toEqual({ requestId: journalId, key: journalId });
    await db.update(schema.sandboxOperations).set({ state: "SUCCEEDED" })
      .where(eq(schema.sandboxOperations.id, journalId));
  }
  expect(calls).toHaveLength(steps.length);
});

test("expired DESTROY readback needs the exact tombstoned current journal", async () => {
  const { broker, calls, scope, db } = await setup();
  const nativeId = "incus-destroy-11111111-1111-1111-1111-111111111111";
  const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding",
    rpcDeadlineMs: Date.now() + 30_000, operationId: nativeId };
  const action = { ...scope("lifecycle.inspectOperation", input), approvedGuest: undefined };
  await db.insert(schema.sandboxOperations).values({ id: "journal-destroy", bindingId: "binding", kind: "DESTROY",
    generation: 1, idempotencyScope: "feature", idempotencyKey: "client-destroy", payloadHash: "hash",
    requestPayload: { expectedGeneration: 1 }, state: "PROVIDER_PENDING", providerOperationId: nativeId });
  await db.update(schema.sandboxBindings).set({ currentOperationId: "journal-destroy", desiredState: "ABSENT",
    observedState: "STOPPED", tombstonedAt: new Date() });
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs)).toMatchObject({ ok: true });
  expect(calls[0]?.idempotency).toEqual({ requestId: "journal-destroy", key: "journal-destroy" });
  expect(calls[0]?.payload).toEqual({ operationId: nativeId,
    readback: { expectedGeneration: 1, desiredState: "absent" } });
  await db.update(schema.sandboxBindings).set({ tombstonedAt: null });
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  expect(calls).toHaveLength(1);
});

test("minor-1 guest mutations preserve their result and dispatch once without a lifecycle journal", async () => {
  const results = {
    "helper.process.start": { ok: true, processId: "process-proof", bootId: "boot-proof", startedAt: "2026-10-05T12:00:00Z" },
    "helper.process.cancel": { ok: true, receipt: { operationId: "cancel-proof", kind: "processCancel", requestId: "cancel-request",
      idempotencyKey: "cancel-request", sandboxId: "binding", acceptedAt: "2026-10-05T12:00:00Z" } },
    "helper.file.writeAtomic": { ok: true, path: "proof", revision: "written-revision", sizeBytes: 2 },
    "helper.file.remove": { ok: true, receipt: { operationId: "remove-proof", kind: "fileRemove", requestId: "remove-request",
      idempotencyKey: "remove-request", sandboxId: "binding", acceptedAt: "2026-10-05T12:00:00Z" } },
  };
  const { broker, calls, scope, db } = await setup(command => results[command.action as keyof typeof results]);
  const mutations = [
    { operation: "processes.start", requestId: "process-request", payload: { argv: ["/bin/true"], cwd: ".", user: "sandbox", env: [], processDeadlineMs: Date.now() + 60_000 } },
    { operation: "processes.cancel", requestId: "cancel-request", payload: { processId: "process-proof", bootId: "boot-proof" } },
    { operation: "files.writeAtomic", requestId: "write-request", payload: { path: "proof", expectedRevision: null, dataBase64: "b2s=", byteLength: 2 } },
    { operation: "files.remove", requestId: "remove-request", payload: { path: "proof", expectedRevision: "written-revision", recursive: false } },
  ] as const;
  for (const mutation of mutations) {
    const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding",
      rpcDeadlineMs: Date.now() + 30_000, requestId: mutation.requestId, idempotencyKey: mutation.requestId, ...mutation.payload };
    const action = { ...scope(mutation.operation, input), hostContractMinor: 1 };
    const payload = { command: action.expectedCommand };
    const [first, replay] = await Promise.all([
      broker.request(action, payload, input.rpcDeadlineMs), broker.request(action, payload, input.rpcDeadlineMs),
    ]);
    expect(first).toEqual({ ok: true, result: results[action.expectedCommand.action as keyof typeof results] });
    expect(replay).toEqual(first);
    expect(await broker.request(action, payload, input.rpcDeadlineMs)).toEqual(first);
    expect(calls.filter(call => call.action === action.expectedCommand.action)).toHaveLength(1);
    const stoppedScope = { ...action };
    await db.update(schema.sandboxBindings).set({ observedState: "STOPPED" }).where(eq(schema.sandboxBindings.id, "binding"));
    expect(await broker.request(stoppedScope, payload, input.rpcDeadlineMs))
      .toMatchObject({ ok: false, error: { kind: "permission", effect: "none" } });
    expect(calls.filter(call => call.action === action.expectedCommand.action)).toHaveLength(1);
    await db.update(schema.sandboxBindings).set({ observedState: "RUNNING" }).where(eq(schema.sandboxBindings.id, "binding"));

  }
  expect(await db.select().from(schema.sandboxOperations)).toEqual([]);
  expect(calls).toHaveLength(4);
});

test("minor-1 lost guest mutation reply keeps its unknown identity and cannot redispatch", async () => {
  const { broker, calls, scope, db } = await setup(() => {
    throw new IncusTransportError("unavailable", "private guest transport failure", { effect: "unknown", operationId: "guest-process-proof" });
  });
  const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding", rpcDeadlineMs: Date.now() + 30_000,
    requestId: "lost-process", idempotencyKey: "lost-process", argv: ["true"], cwd: ".", user: "sandbox", env: [], processDeadlineMs: Date.now() + 60_000 };
  const action = { ...scope("processes.start", input), hostContractMinor: 1 };
  const first = await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs);
  expect(first).toMatchObject({ ok: false, error: { kind: "unavailable", effect: "unknown", operationId: "guest-process-proof" } });
  expect(JSON.stringify(first)).not.toContain("private");
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs)).toEqual(first);
  expect(calls).toHaveLength(1);
  expect(await db.select().from(schema.sandboxOperations)).toEqual([]);
});

test("minor-1 lifecycle mutations still require their admitted host journal before dispatch", async () => {
  const { broker, calls, scope } = await setup();
  for (const operation of ["lifecycle.create", "lifecycle.setPower", "lifecycle.destroy"] as const) {
    const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding", rpcDeadlineMs: Date.now() + 30_000,
      requestId: `missing-${operation}`, idempotencyKey: `missing-${operation}`, expectedGeneration: 1,
      desiredState: "running", profile: "linux-exec.v1", presetId: "incus-linux-exec-v1", presetDigest: "a".repeat(64),
      effectiveSettingsDigest: "b".repeat(64), limits: {} };
    const action = { ...scope(operation, input), hostContractMinor: 1, approvedGuest: undefined };
    expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs))
      .toMatchObject({ ok: false, error: { kind: "permission", effect: "none" } });
  }
  expect(calls).toHaveLength(0);
});

test("a stopped binding denies a previously prepared guest action before transport", async () => {
  const { broker, calls, scope, db } = await setup();
  const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding",
    rpcDeadlineMs: Date.now() + 30_000, path: "src/app.ts" };
  const action = scope("files.stat", input);
  await db.update(schema.sandboxBindings).set({ observedState: "STOPPED" });
  expect(await broker.request(action, { command: action.expectedCommand }, input.rpcDeadlineMs)).toMatchObject({
    ok: false, error: { kind: "permission" },
  });
  expect(calls).toHaveLength(0);
});


test("default broker factories pass pinned scope to probe, lifecycle, and guest transports", async () => {
  const { db, connections, scope } = await setup();
  const broker = new ProviderRpcBroker(connections, undefined, db);
  const deadline = Date.now() + 10_000;
  const base = { providerId: "incus", connectionId: "connection", sandboxId: "binding", rpcDeadlineMs: deadline };
  const guest = { ...scope("files.stat", { ...base, path: "src/app.ts" }),
    approvedGuest: { user: "sandbox", uid: 1000, gid: 1000, helperSha256: guestHelperSha256() } };
  const lifecycle = { ...scope("lifecycle.inspect", base), approvedGuest: undefined };
  for (const action of [guest, lifecycle]) {
    const outcome = await broker.request(action, { command: action.expectedCommand }, deadline);
    expect(outcome).toMatchObject({ ok: false, error: { kind: "not_found" } });
  }
  const probe = {
    installationId: guest.installationId, releaseId: guest.releaseId,
    releaseDigest: guest.releaseDigest, generation: guest.generation,
    connectionId: guest.connectionId, revision: guest.revision, config: guest.config,
  };
  const command: IncusTransportRequest = {
    action: "probe", connectionId: "connection", deadlineMs: deadline,
    pins: guest.expectedCommand.pins,
    tags: { managedBy: "ezharness-incus-sandbox", connectionId: "connection" }, payload: {},
  };
  expect(await broker.request(probe, { command }, deadline))
    .toMatchObject({ ok: false, error: { kind: "not_found" } });
});

test("default host broker gives only lifecycle transport its operator fault instance", async () => {
  const { db, connections, scope } = await setup();
  const fault = { matches: () => false, consume: () => false };
  const broker = new ProviderRpcBroker(connections, undefined, db, undefined, fault);
  const deadline = Date.now() + 10_000;
  const base = { providerId: "incus", connectionId: "connection", sandboxId: "binding", rpcDeadlineMs: deadline };
  const lifecycle = { ...scope("lifecycle.inspect", base), approvedGuest: undefined };
  const guest = scope("files.stat", { ...base, path: "src/app.ts" });
  const factory = (broker as unknown as { actionTransportFactory: (action: PreparedIncusAction) => object }).actionTransportFactory;
  expect((factory(lifecycle) as { lostDestroyReply?: unknown }).lostDestroyReply).toBe(fault);
  expect((factory(guest) as { lostDestroyReply?: unknown }).lostDestroyReply).toBeUndefined();
  expect(await broker.request(lifecycle, { command: lifecycle.expectedCommand }, deadline))
    .toMatchObject({ ok: false, error: { kind: "not_found" } });
});

test("a changed binding revision after lifecycle preparation denies dispatch before transport", async () => {
  const { db, connections, scope } = await setup();
  let matches = 0;
  const broker = new ProviderRpcBroker(connections, undefined, db, undefined,
    { matches: () => { matches++; return true; }, consume: () => true });
  const deadline = Date.now() + 10_000;
  const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding", rpcDeadlineMs: deadline };
  const prepared = { ...scope("lifecycle.inspect", input), approvedGuest: undefined };
  await db.update(schema.sandboxBindings).set({ connectionRevision: 2 });
  expect(await broker.request(prepared, { command: prepared.expectedCommand }, deadline))
    .toMatchObject({ ok: false, error: { kind: "permission" } });
  expect(matches).toBe(0);
});

test("tombstoned linked STOP dispatch and readback require fresh persisted recovery links", async () => {
  const { broker, calls, scope, db } = await setup();
  const base = { providerId: "incus", connectionId: "connection", sandboxId: "binding", rpcDeadlineMs: Date.now() + 30_000 };
  await db.insert(schema.sandboxOperations).values([
    { id: "failed", bindingId: "binding", kind: "DESTROY", generation: 1, idempotencyScope: "cleanup", idempotencyKey: "failed", payloadHash: "failed",
      requestPayload: { expectedGeneration: 2 }, state: "FAILED", errorCode: "REVISION_CONFLICT" },
    { id: "stop", bindingId: "binding", kind: "STOP", generation: 1, idempotencyScope: "cleanup", idempotencyKey: "stop", payloadHash: "stop",
      requestPayload: { expectedGeneration: 2 }, state: "DISPATCHING", providerOperationId: "incus-setPower-11111111-1111-1111-1111-111111111111" },
  ]);
  await db.update(schema.sandboxBindings).set({ desiredState: "ABSENT", tombstonedAt: new Date(), currentOperationId: "stop" });
  await db.update(schema.sandboxBindings).set({ currentOperationId: "failed" });
  const inspection = { ...scope("lifecycle.inspect", base), approvedGuest: undefined };
  expect(await broker.request(inspection, { command: inspection.expectedCommand }, base.rpcDeadlineMs)).toMatchObject({ ok: true });
  await db.update(schema.sandboxOperations).set({ providerOperationId: "unknown-effect" }).where(eq(schema.sandboxOperations.id, "failed"));
  expect(await broker.request(inspection, { command: inspection.expectedCommand }, base.rpcDeadlineMs)).toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxOperations).set({ providerOperationId: null }).where(eq(schema.sandboxOperations.id, "failed"));
  await db.update(schema.sandboxBindings).set({ currentOperationId: "stop" });
  const action = { ...scope("lifecycle.setPower", { ...base, requestId: "stop", idempotencyKey: "stop", desiredState: "stopped", expectedGeneration: 2 }), approvedGuest: undefined };
  expect(await broker.request(action, { command: action.expectedCommand }, base.rpcDeadlineMs)).toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.insert(schema.sandboxCleanupRecoveries).values({ id: "recovery", bindingId: "binding", generation: 1, failedDestroyOperationId: "failed",
    stopOperationId: "stop", destroyOperationId: "destroy", installationId: "installation", releaseId: "release", connectionId: "connection",
    connectionRevision: 1, providerResourceId: resourceName("connection", "binding"), providerGeneration: 2, state: "STOP_REQUIRED" });
  expect(action.expectedCommand.sandboxName).toBe(resourceName("connection", "binding"));
  await db.update(schema.sandboxCleanupRecoveries).set({ providerResourceId: resourceName("connection", "foreign-binding") });
  expect(await broker.request({ ...action }, { command: action.expectedCommand }, base.rpcDeadlineMs)).toMatchObject({ ok: false, error: { kind: "permission" } });
  await db.update(schema.sandboxCleanupRecoveries).set({ providerResourceId: resourceName("connection", "binding") });
  expect(await broker.request({ ...action }, { command: action.expectedCommand }, base.rpcDeadlineMs)).toMatchObject({ ok: true });
  await db.update(schema.sandboxOperations).set({ state: "PROVIDER_PENDING" }).where(eq(schema.sandboxOperations.id, "stop"));
  const readback = { ...scope("lifecycle.inspectOperation", { ...base, operationId: "incus-setPower-11111111-1111-1111-1111-111111111111" }), approvedGuest: undefined };
  expect(await broker.request(readback, { command: readback.expectedCommand }, base.rpcDeadlineMs)).toMatchObject({ ok: true });
  expect(calls.at(-1)?.payload).toMatchObject({ readback: { expectedGeneration: 2, desiredState: "stopped" } });
  await db.update(schema.sandboxOperations).set({ state: "SUCCEEDED" }).where(eq(schema.sandboxOperations.id, "stop"));
  expect(await broker.request(inspection, { command: inspection.expectedCommand }, base.rpcDeadlineMs)).toMatchObject({ ok: true });
  await db.update(schema.sandboxCleanupRecoveries).set({ state: "COMPLETED" });
  expect(await broker.request(inspection, { command: inspection.expectedCommand }, base.rpcDeadlineMs)).toMatchObject({ ok: false, error: { kind: "permission" } });
  expect(await broker.request(readback, { command: readback.expectedCommand }, base.rpcDeadlineMs)).toMatchObject({ ok: false, error: { kind: "permission" } });
  expect(calls).toHaveLength(4);
});

async function observationFixture() {
  const fixture = await setup();
  const now = Date.UTC(2026, 9, 4, 17);
  const actions: PreparedIncusAction[] = [];
  const add = async (index: number, age = 0, recovery = false) => {
    const bindingId = `observation-${index}`;
    const id = `observation-journal-${index}`;
    const [original] = await fixture.db.select().from(schema.sandboxBindings).where(eq(schema.sandboxBindings.id, "binding"));
    await fixture.db.insert(schema.projects).values({ id: bindingId, name: bindingId, path: `/work/${bindingId}` });
    const [binding] = await fixture.db.insert(schema.sandboxBindings).values({ ...original!, id: bindingId, projectId: bindingId,
      resourceKey: bindingId, currentOperationId: id, desiredState: recovery ? "ABSENT" : "STOPPED",
      observedState: "UNKNOWN", tombstonedAt: recovery ? new Date(now) : null }).returning();
    const payload = recovery ? { expectedGeneration: 1 } : { profile: binding!.profile, presetId: binding!.presetId,
      presetDigest: binding!.presetDigest, effectiveSettingsDigest: binding!.effectiveSettingsDigest };
    await fixture.db.insert(schema.sandboxOperations).values({ id, bindingId, generation: 1,
      kind: recovery ? "DESTROY" : "CREATE", state: "DISPATCHING", idempotencyScope: recovery ? "incus-qualification" : "feature",
      idempotencyKey: recovery ? `qual-recovery-${id}:destroy` : id, payloadHash: "observer-hash",
      requestPayload: payload, createdAt: new Date(now - age) });
    const input = { providerId: "incus", connectionId: "connection", sandboxId: bindingId,
      requestId: id, idempotencyKey: id, rpcDeadlineMs: Date.now() + 30_000, ...payload, ...(!recovery ? { desiredState: "stopped" } : {}) };
    const action = fixture.scope(recovery ? "lifecycle.destroy" : "lifecycle.create", input);
    const { id: capturedId, projectId, providerInstallationId, providerReleaseId, connectionId,
      connectionRevision, resourceKey, generation, currentOperationId, desiredState, tombstonedAt } = binding!;
    const prepared: PreparedIncusAction = { ...action, bindingId, projectId: bindingId, resourceKey: bindingId, hostContractMinor: 1,
      approvedGuest: undefined, settlementScope: { id: capturedId, projectId, providerInstallationId, providerReleaseId,
        connectionId, connectionRevision, resourceKey, generation, currentOperationId, desiredState, tombstonedAt,
        kind: recovery ? "DESTROY" : "CREATE", payloadHash: "observer-hash" } };
    actions.push(prepared);
    return prepared;
  };
  return { ...fixture, now, add, actions };
}

function pendingUntilAbort(signal: AbortSignal | undefined, entered: () => void): Promise<unknown> {
  entered();
  return new Promise(resolve => {
    if (signal?.aborted) resolve({ ok: false });
    else signal?.addEventListener("abort", () => resolve({ ok: false }), { once: true });
  });
}

test("host observer capacity is reserved before effects and shutdown drains all accepted dispatches", async () => {
  const fixture = await observationFixture();
  let effects = 0;
  let entered!: () => void;
  const broker = new ProviderRpcBroker(fixture.connections, undefined, fixture.db,
    (_scope, signal) => ({ request: () => pendingUntilAbort(signal, () => { effects++; entered(); }) }), undefined,
    { now: () => fixture.now, resolveActiveRelease: async () => { throw new Error("No native acceptance yet"); } });
  const calls: Promise<unknown>[] = [];
  for (let index = 0; index < 32; index++) {
    const action = await fixture.add(index);
    const ready = new Promise<void>(resolve => { entered = resolve; });
    calls.push(broker.request(action, { command: action.expectedCommand }, action.expectedCommand.deadlineMs));
    await ready;
  }
  const refused = await fixture.add(32);
  expect(await broker.request(refused, { command: refused.expectedCommand }, refused.expectedCommand.deadlineMs))
    .toMatchObject({ ok: false, error: { kind: "unavailable" } });
  expect(effects).toBe(32);
  await broker.stopObservations();
  await Promise.all(calls);
  expect(await broker.request(refused, { command: refused.expectedCommand }, refused.expectedCommand.deadlineMs))
    .toMatchObject({ ok: false, error: { kind: "unavailable" } });
  const afterStop = await fixture.add(33);
  expect(await broker.request(afterStop, { command: afterStop.expectedCommand }, afterStop.expectedCommand.deadlineMs))
    .toMatchObject({ ok: false, error: { kind: "unavailable" } });
  expect(effects).toBe(32);
  expect((await fixture.db.select().from(schema.sandboxOperations)).every(row => row.state === "DISPATCHING")).toBe(true);
});

test("observer budget is absolute from journal creation and never resets on a new host", async () => {
  const fixture = await observationFixture();
  const expired = await fixture.add(0, 600_000);
  let effects = 0;
  const broker = new ProviderRpcBroker(fixture.connections, undefined, fixture.db,
    () => ({ request: async () => { effects++; return { ok: true }; } }), undefined,
    { now: () => fixture.now, resolveActiveRelease: async () => { throw new Error("Expired journal must not resolve"); } });
  expect(await broker.request(expired, { command: expired.expectedCommand }, expired.expectedCommand.deadlineMs))
    .toMatchObject({ ok: false, error: { kind: "unavailable" } });
  await fixture.db.update(schema.sandboxOperations).set({ providerOperationId: "incus-create-11111111-1111-4111-8111-111111111111", state: "OUTCOME_UNKNOWN" });
  await broker.resumePendingObservations();
  expect(effects).toBe(0);
  expect((await fixture.db.select().from(schema.sandboxOperations))[0]?.state).toBe("OUTCOME_UNKNOWN");
  await broker.stopObservations();
});

test("an accepted observer refreshes authority independently and revoked release preserves the journal", async () => {
  const fixture = await observationFixture();
  const action = await fixture.add(0);
  const nativeId = "incus-create-11111111-1111-4111-8111-111111111111";
  let writes = 0;
  let reads = 0;
  let authorityChecks = 0;
  const broker = new ProviderRpcBroker(fixture.connections, undefined, fixture.db,
    (_scope, _signal, accepted, _terminal, observing) => ({ request: async () => {
      if (observing) { reads++; throw new Error("Revocation must precede read"); }
      writes++;
      await accepted!(nativeId);
      return { ok: true, receipt: { operationId: nativeId } };
    } }), undefined,
    { now: () => fixture.now, resolveActiveRelease: async () => { authorityChecks++; throw new Error("Release revoked"); } });
  const first = await broker.request(action, { command: action.expectedCommand }, action.expectedCommand.deadlineMs);
  expect(await broker.request(action, { command: action.expectedCommand }, action.expectedCommand.deadlineMs)).toEqual(first);
  await broker.awaitObservation(action.expectedCommand.idempotency!.requestId);
  expect({ writes, reads, authorityChecks }).toEqual({ writes: 1, reads: 0, authorityChecks: 1 });
  expect((await fixture.db.select().from(schema.sandboxOperations))[0]).toMatchObject({ state: "DISPATCHING", providerOperationId: nativeId });
  await broker.stopObservations();
});

test("only the exact operator recovery DESTROY is excluded from independent observers", async () => {
  const fixture = await observationFixture();
  const action = await fixture.add(0, 600_001, true);
  const nearMiss = await fixture.add(1, 600_001, true);
  await fixture.db.update(schema.sandboxOperations).set({ idempotencyScope: "feature" })
    .where(eq(schema.sandboxOperations.id, nearMiss.expectedCommand.idempotency!.requestId));
  let effects = 0;
  let reads = 0;
  const nativeId = "incus-destroy-11111111-1111-4111-8111-111111111111";
  const broker = new ProviderRpcBroker(fixture.connections, undefined, fixture.db,
    (_scope, _signal, accepted) => ({ request: async () => { effects++; await accepted!(nativeId); return { ok: true }; } }), undefined,
    { now: () => fixture.now, resolveActiveRelease: async () => { reads++; throw new Error("Fault observer must remain excluded"); } });
  expect(await broker.request(action, { command: action.expectedCommand }, action.expectedCommand.deadlineMs)).toMatchObject({ ok: true });
  expect(await broker.request(nearMiss, { command: nearMiss.expectedCommand }, nearMiss.expectedCommand.deadlineMs))
    .toMatchObject({ ok: false, error: { kind: "unavailable" } });
  await broker.resumePendingObservations();
  await broker.awaitObservation(action.expectedCommand.idempotency!.requestId);
  expect({ effects, reads }).toEqual({ effects: 1, reads: 0 });
  expect((await fixture.db.select().from(schema.sandboxOperations)
    .where(eq(schema.sandboxOperations.id, action.expectedCommand.idempotency!.requestId)))[0])
    .toMatchObject({ state: "DISPATCHING", providerOperationId: nativeId });
  await broker.stopObservations();
});

async function observerReadFixture() {
  const fixture = await observationFixture();
  const manifest = structuredClone(incusManifest);
  const preset = manifest.sandboxProviders![0]!.presets[0]!;
  const digest = await sandboxPresetDigest(preset);
  await new SandboxAdmissionStore(fixture.db).configureHostCapacity({ providerInstallationId: "installation", connectionId: "connection",
    allocatable: { memoryBytes: preset.limits.memoryBytes * 4, cpuMillicores: preset.limits.cpuMillis * 4,
      pids: preset.limits.pids * 4, diskBytes: preset.limits.diskBytes * 4, executionSlots: 4 },
    safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 } });
  const snapshot = { installation: { id: "installation", generation: 1 },
    release: { id: "release", releaseDigest: "d".repeat(64), manifest } } as ActiveExtensionRelease;
  const certificate = observerCertificates.read("server-cert.pem");
  let connectionsChecked = 0;
  const connection = { id: "connection", revision: 1, providerInstallationId: "installation", providerReleaseId: "release",
    revokedAt: null, serverCertificatePem: certificate, project: "ezharness",
    configuration: { kind: "incus", profile: "ezharness-feature", helperVersion: "0.1.0", guestUser: "sandbox" } };
  const connections = { getMetadata: async () => connection,
    resolveForHost: async () => { connectionsChecked++; return connection; } } as unknown as ProviderConnectionResolver;
  const add = async (index: number) => {
    const action = await fixture.add(index);
    await fixture.db.update(schema.sandboxBindings).set({ presetId: preset.id, profile: preset.profile, presetDigest: digest })
      .where(eq(schema.sandboxBindings.id, action.bindingId));
    const payload = { profile: preset.profile, presetId: preset.id, presetDigest: digest,
      effectiveSettingsDigest: "b".repeat(64) };
    await fixture.db.update(schema.sandboxOperations).set({ requestPayload: payload })
      .where(eq(schema.sandboxOperations.id, action.expectedCommand.idempotency!.requestId));
    await fixture.db.insert(schema.sandboxReservations).values({ bindingId: action.bindingId, projectId: action.projectId,
      providerInstallationId: "installation", connectionId: "connection", generation: 1,
      memoryBytes: preset.limits.memoryBytes, cpuMillicores: preset.limits.cpuMillis, pids: preset.limits.pids,
      diskBytes: preset.limits.diskBytes, executionSlots: 1, computeState: "RESERVED", diskState: "RESERVED" });
    return action;
  };
  return { ...fixture, add, snapshot, connections, connectionChecks: () => connectionsChecked };
}

for (const completion of ["terminal", "revoked", "expired"] as const) {
  test(`independent observer schedules bounded reads and ${completion} preserves exact journal truth`, async () => {
    const fixture = await observerReadFixture();
    const action = await fixture.add(0);
    const nativeId = "incus-create-11111111-1111-4111-8111-111111111111";
    let now = fixture.now;
    let releaseAllowed = true;
    let reads = 0;
    let writes = 0;
    let authorityChecks = 0;
    let pauseReady!: () => void;
    const paused = new Promise<void>(resolve => { pauseReady = resolve; });
    let resume!: () => void;
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    const delays: number[] = [];
    const broker = new ProviderRpcBroker(fixture.connections, undefined, fixture.db,
      (prepared, _signal, accepted, _terminal, observing) => ({ request: async () => {
        if (!observing) { writes++; await accepted!(nativeId); return { ok: true }; }
        reads++;
        return { ok: true, operation: { operationId: nativeId, kind: "create", sandboxId: action.bindingId,
          state: reads === 1 ? "running" : "succeeded", desiredState: "stopped", observedState: reads === 1 ? "unknown" : "stopped",
          resourceId: prepared.expectedCommand.sandboxName, startedAt: new Date(fixture.now).toISOString(),
          finishedAt: reads === 1 ? null : new Date(fixture.now + 1).toISOString(), error: null } };
      } }), undefined, { now: () => now,
        resolveActiveRelease: async () => { authorityChecks++; if (!releaseAllowed) throw new Error("Revoked"); return fixture.snapshot; },
        delay: async (milliseconds, signal) => { delays.push(milliseconds); pauseReady();
          signal.addEventListener("abort", resume, { once: true }); await barrier; } });
    expect(await broker.request(action, { command: action.expectedCommand }, action.expectedCommand.deadlineMs)).toMatchObject({ ok: true });
    await paused;
    expect(delays).toEqual([250]);
    expect({ reads, writes, authorityChecks }).toEqual({ reads: 1, writes: 1, authorityChecks: 1 });
    // A new prepared owner of this same journal cannot consume another observation slot or dispatch.
    expect(await broker.request({ ...action }, { command: action.expectedCommand }, action.expectedCommand.deadlineMs))
      .toMatchObject({ ok: false, error: { kind: "permission" } });
    if (completion === "revoked") releaseAllowed = false;
    if (completion === "expired") now += 600_000;
    const complete = broker.awaitObservation(action.expectedCommand.idempotency!.requestId);
    resume();
    await complete;
    const journal = (await fixture.db.select().from(schema.sandboxOperations))[0]!;
    expect(journal).toMatchObject({ state: completion === "terminal" ? "SUCCEEDED" : "DISPATCHING", providerOperationId: nativeId });
    expect(writes).toBe(1);
    expect(reads).toBe(completion === "terminal" ? 2 : 1);
    expect(authorityChecks).toBe(completion === "expired" ? 1 : 2);
    expect(fixture.connectionChecks()).toBe(completion === "terminal" ? 2 : 1);
    const binding = (await fixture.db.select().from(schema.sandboxBindings).where(eq(schema.sandboxBindings.id, action.bindingId)))[0]!;
    expect(binding.observedState).toBe(completion === "terminal" ? "STOPPED" : "UNKNOWN");
    await broker.stopObservations();
  });
}

test("startup resumes only current final native handles without replaying mutations or intent phases", async () => {
  const fixture = await observerReadFixture();
  const actions = await Promise.all([0, 1, 2, 3].map(index => fixture.add(index)));
  const nativeId = "incus-create-11111111-1111-4111-8111-111111111111";
  for (const action of actions) await fixture.db.update(schema.sandboxOperations).set({ state: "PROVIDER_PENDING", providerOperationId: nativeId })
    .where(eq(schema.sandboxOperations.id, action.expectedCommand.idempotency!.requestId));
  await fixture.db.update(schema.sandboxBindings).set({ currentOperationId: "superseded" })
    .where(eq(schema.sandboxBindings.id, actions[1]!.bindingId));
  await fixture.db.update(schema.sandboxOperations).set({ kind: "START", providerOperationId: "incus-setPowerIntent-22222222-2222-4222-8222-222222222222" })
    .where(eq(schema.sandboxOperations.id, actions[2]!.expectedCommand.idempotency!.requestId));
  await fixture.db.update(schema.sandboxOperations).set({ kind: "DESTROY", idempotencyScope: "incus-qualification",
    idempotencyKey: "qual-recovery-saved:destroy", providerOperationId: "incus-destroy-33333333-3333-4333-8333-333333333333" })
    .where(eq(schema.sandboxOperations.id, actions[3]!.expectedCommand.idempotency!.requestId));
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const reads: string[] = [];
  let effects = 0;
  const broker = new ProviderRpcBroker(fixture.connections, undefined, fixture.db,
    (prepared, _signal, _accepted, _terminal, observing) => ({ request: async () => {
      if (!observing) { effects++; throw new Error("Startup cannot dispatch"); }
      reads.push(prepared.bindingId);
      entered();
      await barrier;
      return { ok: true, operation: { operationId: nativeId, kind: "create", sandboxId: prepared.bindingId,
        state: "failed", desiredState: "stopped", observedState: "unknown", resourceId: prepared.expectedCommand.sandboxName,
        startedAt: new Date(fixture.now).toISOString(), finishedAt: new Date(fixture.now + 1).toISOString(),
        error: { code: "INTERNAL", message: "Native creation failed", retryable: false } } };
    } }), undefined, { now: () => fixture.now, resolveActiveRelease: async () => fixture.snapshot });
  await broker.resumePendingObservations();
  await ready;
  await broker.resumePendingObservations();
  expect(reads).toEqual([actions[0]!.bindingId]);
  const complete = broker.awaitObservation(actions[0]!.expectedCommand.idempotency!.requestId);
  release();
  await complete;
  expect(effects).toBe(0);
  const operations = await fixture.db.select().from(schema.sandboxOperations);
  expect(operations.find(row => row.id === actions[0]!.expectedCommand.idempotency!.requestId))
    .toMatchObject({ state: "FAILED", providerOperationId: nativeId, errorCode: "INTERNAL" });
  expect(operations.filter(row => row.id !== actions[0]!.expectedCommand.idempotency!.requestId).map(row => row.state))
    .toEqual(["PROVIDER_PENDING", "PROVIDER_PENDING", "PROVIDER_PENDING"]);
  expect((await fixture.db.select().from(schema.sandboxReservations)).every(row => row.computeState === "RESERVED" && row.diskState === "RESERVED")).toBe(true);
  await broker.stopObservations();
});


for (const boundary of ["missing", "missing-journal", "rebound", "replacement"] as const) {
  test(`native acceptance refuses ${boundary} authority without replacing saved truth`, async () => {
    const fixture = await observationFixture();
    const action = await fixture.add(0);
    const nativeId = "incus-create-11111111-1111-4111-8111-111111111111";
    const replacementId = "incus-create-22222222-2222-4222-8222-222222222222";
    let effects = 0;
    const broker = new ProviderRpcBroker(fixture.connections, undefined, fixture.db,
      (_scope, _signal, accepted) => ({ request: async () => {
        effects++;
        if (boundary === "rebound") await fixture.db.update(schema.sandboxBindings)
          .set({ currentOperationId: "newer-intent" }).where(eq(schema.sandboxBindings.id, action.bindingId));
        await accepted!(nativeId);
        if (boundary === "replacement") await accepted!(replacementId);
        return { ok: true };
      } }), undefined, { now: () => fixture.now,
        resolveActiveRelease: async () => { throw new Error("No independent read is authorized in this boundary"); } });
    const target = boundary === "missing" ? { ...action, settlementScope: undefined } : action;
    if (boundary === "missing-journal") await fixture.db.delete(schema.sandboxOperations);
    const beforeEffect = boundary === "missing" || boundary === "missing-journal";
    try {
      expect(await broker.request(target, { command: target.expectedCommand }, target.expectedCommand.deadlineMs))
        .toMatchObject({ ok: false, error: beforeEffect ? { kind: "permission", effect: "none" }
          : { effect: "unknown", operationId: boundary === "replacement" ? replacementId : nativeId } });
      const [saved] = await fixture.db.select().from(schema.sandboxOperations);
      if (boundary === "missing-journal") expect(saved).toBeUndefined();
      else {
        expect(saved.state).toBe("DISPATCHING");
        expect(saved.providerOperationId).toBe(boundary === "replacement" ? nativeId : null);
      }
      expect(effects).toBe(beforeEffect ? 0 : 1);
    } finally { await broker.stopObservations(); }
  });
}

for (const state of ["succeeded", "running"] as const) {
  test(`shutdown drains original dispatch after observer ${state}`, async () => {
    const fixture = await observerReadFixture();
    const action = await fixture.add(0);
    const nativeId = "incus-create-11111111-1111-4111-8111-111111111111";
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let acceptedReady!: () => void;
    const acceptance = new Promise<void>(resolve => { acceptedReady = resolve; });
    let pauseReady!: () => void;
    const pause = new Promise<void>(resolve => { pauseReady = resolve; });
    const schedule = globalThis.setTimeout;
    const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, milliseconds?: number, ...args: unknown[]) => {
      const timer = schedule(callback, milliseconds, ...args);
      if (milliseconds === 250) pauseReady();
      return timer;
    }) as typeof setTimeout);
    let aborted = false;
    let drained = false;
    let allowDispatch!: () => void;
    const dispatchBarrier = new Promise<void>(resolve => { allowDispatch = resolve; });
    const broker = new ProviderRpcBroker(fixture.connections, undefined, fixture.db,
      (prepared, signal, accepted, _terminal, observing) => ({ request: async () => {
        if (!observing) {
          signal!.addEventListener("abort", () => { aborted = true; entered(); }, { once: true });
          await accepted!(nativeId);
          acceptedReady();
          await dispatchBarrier;
          drained = true;
          return { ok: true };
        }
        const result = { ok: true, operation: { operationId: nativeId, kind: "create", sandboxId: action.bindingId,
          state, desiredState: "stopped", observedState: state === "succeeded" ? "stopped" : "unknown",
          resourceId: prepared.expectedCommand.sandboxName, startedAt: new Date(fixture.now).toISOString(),
          finishedAt: state === "succeeded" ? new Date(fixture.now + 1).toISOString() : null, error: null } };
        return result;
      } }), undefined, { now: () => fixture.now, resolveActiveRelease: async () => fixture.snapshot });
    const request = broker.request(action, { command: action.expectedCommand }, action.expectedCommand.deadlineMs);
    await acceptance;
    if (state === "succeeded") await broker.awaitObservation(action.expectedCommand.idempotency!.requestId);
    else await pause;
    timerSpy.mockRestore();
    const stop = broker.stopObservations();
    await ready;
    expect(aborted).toBe(true);
    expect(drained).toBe(false);
    allowDispatch();
    await stop;
    await request;
    expect(drained).toBe(true);
    expect((await fixture.db.select().from(schema.sandboxOperations))[0]!.state)
      .toBe(state === "succeeded" ? "SUCCEEDED" : "DISPATCHING");
  });
}
