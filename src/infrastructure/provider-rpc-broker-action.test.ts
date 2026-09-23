import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createIncusTransportCommand } from "../../extensions/incus-sandbox/adapter";
import { incusManifest } from "../../extensions/incus-sandbox/manifest";
import type { IncusTransportRequest } from "../../extensions/incus-sandbox/transport";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import * as schema from "../db/schema";
import { SandboxController } from "../sandboxes/controller";
import { guestHelperSha256 } from "./incus-guest/protocol";
import {
  ProviderRpcBroker,
  type PreparedIncusAction,
  type ProviderConnectionResolver,
} from "./provider-rpc-broker";

const open: PGlite[] = [];

async function setup() {
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
    () => ({ request: async command => { calls.push(command); return { ok: true, file: { path: "src/app.ts" } }; } }));
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

test("a repeated guest process mutation returns the first result without redispatch", async () => {
  const { broker, calls, scope } = await setup();
  const input = { providerId: "incus", connectionId: "connection", sandboxId: "binding",
    rpcDeadlineMs: Date.now() + 30_000, requestId: "process-request", idempotencyKey: "process-request",
    argv: ["/bin/true"], cwd: ".", user: "sandbox", env: [], processDeadlineMs: Date.now() + 60_000 };
  const action = scope("processes.start", input);
  const payload = { command: action.expectedCommand };
  const [first, replay] = await Promise.all([
    broker.request(action, payload, input.rpcDeadlineMs),
    broker.request(action, payload, input.rpcDeadlineMs),
  ]);
  expect(first).toMatchObject({ ok: true });
  expect(replay).toEqual(first);
  expect(await broker.request(action, payload, input.rpcDeadlineMs)).toEqual(first);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.action).toBe("helper.process.start");
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
