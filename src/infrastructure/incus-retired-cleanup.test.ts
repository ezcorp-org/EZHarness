import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sandboxPresetDigest, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import * as schema from "../db/schema";
import { up as addExtensionReleases } from "../db/migrations/add-extension-releases";
import { up as addProviderConnections } from "../db/migrations/add-provider-connections";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";
import { IncusTransportError } from "../../extensions/incus-sandbox/transport";
import { ProviderRpcBroker } from "./provider-rpc-broker";
import { ProviderConnectionStore } from "./provider-connections/store";
import { makeTestCertificates } from "./incus-transport/test-certificates";
import { callRetiredIncusCleanup } from "./incus-retired-cleanup";

const certificates = makeTestCertificates();
const read = certificates.read;
const clients: PGlite[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });

async function fixture() {
  const client = new PGlite();
  clients.push(client);
  await client.waitReady;
  const db = drizzle(client, { schema });
  await addExtensionReleases(db);
  await addProviderConnections(db);
  await client.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await addSandboxController(db);
  await db.insert(schema.projects).values({ id: "project", name: "project", path: "/project" });
  const installation = { id: "installation", ownerId: "owner", scope: "global", activeReleaseId: "release",
    generation: 3, enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 2 };
  const manifest = structuredClone(incusManifest);
  const preset = manifest.sandboxProviders![0]!.presets[0]!;
  preset.imageDigest = "c".repeat(64);
  const release = { id: "release", installationId: "installation", releaseDigest: "digest", manifest };
  const approval = { id: "approval", installationId: "installation", releaseId: "release", releaseDigest: "digest",
    principalId: "owner", scope: "global", status: "consumed", expectedGeneration: 1 };
  await client.query("INSERT INTO extension_release_installations (id, owner_id, scope, payload) VALUES ($1, $2, $3, $4)",
    [installation.id, installation.ownerId, installation.scope, JSON.stringify(installation)]);
  for (const [kind, row] of [["releases", release], ["approvals", approval]] as const) {
    await client.query("INSERT INTO extension_release_records (installation_id, kind, id, payload) VALUES ($1, $2, $3, $4)",
      [installation.id, kind, row.id, JSON.stringify(row)]);
  }
  const store = new ProviderConnectionStore(db);
  await client.query("UPDATE extension_release_installations SET payload = $1 WHERE id = $2",
    [JSON.stringify({ ...installation, enabled: true, status: "active", generation: 2 }), installation.id]);
  await store.create({ id: "connection", providerInstallationId: "installation", providerReleaseId: "release",
    endpoint: "https://127.0.0.1:8443/", serverCertificatePem: read("server-cert.pem"), project: "sandbox",
    configuration: { kind: "incus", profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" },
    clientCertificatePem: read("client-cert.pem"), privateKeyPem: read("client-key.pem") });
  await client.query("UPDATE extension_release_installations SET payload = $1 WHERE id = $2",
    [JSON.stringify(installation), installation.id]);
  const digest = await sandboxPresetDigest(preset);
  await db.insert(schema.sandboxBindings).values({ id: "binding", projectId: "project", providerInstallationId: "installation",
    providerReleaseId: "release", connectionId: "connection", connectionRevision: 1, resourceKey: "binding",
    profile: preset.profile, presetId: preset.id, presetDigest: digest,
    effectiveSettingsDigest: "a".repeat(64), desiredState: "ABSENT", observedState: "STOPPED", generation: 1,
    currentOperationId: "journal" });
  await db.insert(schema.sandboxOperations).values({ id: "journal", bindingId: "binding", kind: "DESTROY",
    generation: 1, idempotencyScope: "retired", idempotencyKey: "cleanup", payloadHash: "hash",
    requestPayload: { expectedGeneration: 1 }, state: "DISPATCHING" });
  const [binding] = await db.select().from(schema.sandboxBindings);
  const calls: string[] = [];
  let failure: "unknown" | "denied" | null = null;
  const brokerFactory = (credentialStore: ProviderConnectionStore, releaseDigest: string) => new ProviderRpcBroker({
    getMetadata: id => credentialStore.getMetadata(id),
    resolveForHost: scope => credentialStore.resolveRetiredForHost(scope, releaseDigest),
  }, undefined, db, () => ({ request: async command => {
    calls.push(command.action);
    if (command.action === "operation.inspect") return { ok: true, operation: {
      operationId: "provider-destroy", kind: "destroy", sandboxId: "binding", state: "outcome_unknown",
      desiredState: "absent", observedState: "unknown", resourceId: null,
      startedAt: new Date().toISOString(), finishedAt: null,
      error: { code: "OUTCOME_UNKNOWN", message: "pending", retryable: false, operationId: "provider-destroy" },
    } };
    if (failure === "unknown") throw new IncusTransportError("unavailable", "response lost", { effect: "unknown", operationId: "provider-destroy" });
    if (failure === "denied") throw new IncusTransportError("permission", "denied");
    return { ok: true, receipt: { operationId: "provider-destroy", kind: "destroy", requestId: "journal",
      idempotencyKey: "journal", sandboxId: "binding", acceptedAt: new Date().toISOString() } };
  } }));
  return { client, db, binding: binding!, brokerFactory, calls, setFailure: (value: "unknown" | "denied") => { failure = value; } };
}

test("retired host cleanup reaches only the exact pinned destroy transport", async () => {
  const { db, binding, brokerFactory, calls } = await fixture();
  const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding",
    rpcDeadlineMs: Date.now() + 20_000, requestId: "journal", idempotencyKey: "journal", expectedGeneration: 1 };
  const result = await callRetiredIncusCleanup(db, binding, "lifecycle.destroy", input, brokerFactory);
  expect(result).toMatchObject({ ok: true, receipt: { kind: "destroy", sandboxId: "binding" } });
  expect(calls).toEqual(["instance.destroy"]);
  for (const denied of ["lifecycle.create", "lifecycle.setPower", "files.writeAtomic", "processes.start"] as SandboxProtocolOperation[]) {
    await expect(callRetiredIncusCleanup(db, binding, denied, input, brokerFactory)).rejects.toThrow("unavailable");
  }
  await expect(callRetiredIncusCleanup(db, { ...binding, connectionId: "other" }, "lifecycle.destroy", input, brokerFactory)).rejects.toThrow();
  await expect(callRetiredIncusCleanup(db, { ...binding, providerReleaseId: "other" }, "lifecycle.destroy", input, brokerFactory)).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test("a lost retired destroy reply stays reconcilable and stale journals cannot dispatch", async () => {
  const { db, binding, brokerFactory, calls, setFailure } = await fixture();
  const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding",
    rpcDeadlineMs: Date.now() + 20_000, requestId: "journal", idempotencyKey: "journal", expectedGeneration: 1 };
  setFailure("unknown");
  expect(await callRetiredIncusCleanup(db, binding, "lifecycle.destroy", input, brokerFactory)).toMatchObject({
    ok: false, error: { code: "OUTCOME_UNKNOWN", operationId: "provider-destroy" },
  });
  await db.update(schema.sandboxOperations).set({ state: "OUTCOME_UNKNOWN", providerOperationId: "provider-destroy" });
  await expect(callRetiredIncusCleanup(db, binding, "lifecycle.destroy", input, brokerFactory)).rejects.toThrow("journal is unavailable");
  expect(await callRetiredIncusCleanup(db, binding, "lifecycle.inspectOperation",
    { providerId: "incus", connectionId: "connection", sandboxId: "binding",
      rpcDeadlineMs: Date.now() + 20_000, operationId: "provider-destroy" }, brokerFactory)).toMatchObject({
    ok: true, operation: { state: "outcome_unknown", operationId: "provider-destroy" },
  });
  expect(calls).toEqual(["instance.destroy", "operation.inspect"]);
});

test("retired inspection, changed connection, and denied transport fail closed", async () => {
  const { db, binding, brokerFactory, calls, setFailure } = await fixture();
  const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding",
    rpcDeadlineMs: Date.now() + 20_000, requestId: "journal", idempotencyKey: "journal", expectedGeneration: 1 };
  await expect(callRetiredIncusCleanup(db, { ...binding, observedState: "RUNNING" },
    "lifecycle.inspect", input, brokerFactory)).rejects.toThrow("binding is unavailable");
  await expect(callRetiredIncusCleanup(db, { ...binding, connectionRevision: 2 },
    "lifecycle.destroy", input, brokerFactory)).rejects.toThrow("connection changed");
  setFailure("denied");
  await expect(callRetiredIncusCleanup(db, binding, "lifecycle.destroy", input, brokerFactory))
    .rejects.toThrow("transport failed");
  expect(calls).toEqual(["instance.destroy"]);
});

test("revoked credentials and reactivated release cannot reach retired transport", async () => {
  const { client, db, binding, brokerFactory, calls } = await fixture();
  const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding",
    rpcDeadlineMs: Date.now() + 20_000, requestId: "journal", idempotencyKey: "journal", expectedGeneration: 1 };
  await new ProviderConnectionStore(db).revoke("connection", 1);
  await expect(callRetiredIncusCleanup(db, binding, "lifecycle.destroy", input, brokerFactory)).rejects.toThrow();
  expect(calls).toEqual([]);
  const installation = { id: "installation", ownerId: "owner", scope: "global", activeReleaseId: "release",
    generation: 2, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 2 };
  await client.query("UPDATE extension_release_installations SET payload = $1 WHERE id = $2",
    [JSON.stringify(installation), installation.id]);
  await expect(callRetiredIncusCleanup(db, binding, "lifecycle.destroy", input, brokerFactory))
    .rejects.toThrow("Retired provider release is unavailable");
  expect(calls).toEqual([]);
});
