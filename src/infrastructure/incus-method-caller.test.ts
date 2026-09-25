import { afterEach, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { RunnerError } from "@ezcorp/extension-runner";
import * as schema from "../db/schema";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import type { IncusDispatchScope } from "../sandboxes/incus-dispatcher";

let database: ReturnType<typeof drizzle>;
let activeRelease: { installation: { generation: number }; release: { id: string } } | null =
  { installation: { generation: 1 }, release: { id: "release" } };
const calls: { operation: string; input: Record<string, unknown> }[] = [];
const retiredCalls: string[] = [];
let settled = false;
let releaseError: unknown;
mock.module("../db/connection", () => ({ getDb: () => database }));
mock.module("../extensions/release-process", () => ({
  getReleaseRuntime: () => ({}),
  resolveActiveRelease: async () => activeRelease,
  ReleaseProcess: class {
    constructor(readonly installationId: string) {}
    async callIncusSandboxOperation(_bindingId: string, operation: string, input: Record<string, unknown>) {
      calls.push({ operation, input });
      if (releaseError) throw releaseError;
      return { result: { ok: true, operation } };
    }
    kill() {}
    async whenCallsSettled() { settled = true; }
  },
}));
const { IncusMethodCaller } = await import("./incus-method-caller");

const scope: IncusDispatchScope = {
  installationId: "installation", releaseId: "release", connectionId: "connection", connectionRevision: 1,
  projectId: "project", bindingId: "binding", resourceKey: "binding", generation: 1,
  operationId: "operation", deadlineMs: 100_000,
};
const common = { providerId: "incus", sandboxId: "binding", connectionId: "connection", rpcDeadlineMs: 100_000 };
const create = { ...common, requestId: "operation", idempotencyKey: "operation", profile: "profile",
  presetId: "preset", presetDigest: "preset-digest", effectiveSettingsDigest: "settings-digest" };
const databases: PGlite[] = [];
// Each case starts a fresh in-memory PostgreSQL engine and schema. Under a
// parallel Incus suite this can take longer than Bun's 5-second default.
const DB_TEST_TIMEOUT_MS = 30_000;
async function fixture(kind: "CREATE" | "START" | "STOP" | "DESTROY" = "CREATE") {
  calls.length = 0;
  retiredCalls.length = 0;
  settled = false;
  releaseError = undefined;
  activeRelease = { installation: { generation: 1 }, release: { id: "release" } };
  const client = new PGlite();
  databases.push(client);
  await client.waitReady;
  await client.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'user', icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  database = drizzle(client, { schema });
  await addSandboxController(database);
  await database.insert(schema.projects).values({ id: "project", name: "project", path: "/project" });
  await database.insert(schema.sandboxBindings).values({ id: "binding", projectId: "project",
    providerInstallationId: "installation", providerReleaseId: "release", connectionId: "connection",
    connectionRevision: 1, profile: "profile", presetId: "preset", presetDigest: "preset-digest",
    effectiveSettingsDigest: "settings-digest", resourceKey: "binding", desiredState: "STOPPED",
    observedState: "STOPPED", generation: 1, currentOperationId: "operation" });
  await database.insert(schema.sandboxOperations).values({ id: "operation", bindingId: "binding", kind,
    generation: 1, idempotencyScope: "caller", idempotencyKey: "caller", payloadHash: "hash",
    requestPayload: kind === "CREATE" ? { profile: "profile", presetId: "preset", presetDigest: "preset-digest",
      effectiveSettingsDigest: "settings-digest" } : { expectedGeneration: 1 }, state: "DISPATCHING",
    providerOperationId: "provider-operation" });
  return new IncusMethodCaller(async (_db, _binding, operation) => {
    retiredCalls.push(operation);
    return { ok: true, retired: true };
  });
}
afterEach(async () => { await Promise.all(databases.splice(0).map(client => client.close())); });

test("a durable create receipt reaches the active release and settles its call", async () => {
  const caller = await fixture();
  expect(await caller.call(scope, "incus/lifecycle/create", create)).toEqual({ ok: true, operation: "lifecycle.create" });
  expect(calls).toEqual([{ operation: "lifecycle.create", input: create }]);
  expect(settled).toBe(true);
}, DB_TEST_TIMEOUT_MS);

test("only a missing runner artifact is a definitive pre-start dispatch failure", async () => {
  const caller = await fixture();
  releaseError = new RunnerError("artifact_missing", "Pinned worker artifact is missing");
  await expect(caller.call(scope, "incus/lifecycle/create", create))
    .rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });
  expect(settled).toBe(true);

  for (const error of [new RunnerError("artifact_unavailable", "Unproven artifact failure"),
    new RunnerError("runner_unavailable", "Runner disconnected"),
    new Error("Reply lost after start")]) {
    releaseError = error;
    await expect(caller.call(scope, "incus/lifecycle/create", create)).rejects.toBe(error);
  }
}, DB_TEST_TIMEOUT_MS);

test("method caller denies unapproved methods and forged scope before any effect", async () => {
  const caller = await fixture();
  await expect(caller.call(scope, "incus/lifecycle/inspect" as "incus/lifecycle/create", create))
    .rejects.toMatchObject({ code: "SCOPE_INVALID" });
  for (const [badScope, badInput] of [
    [{ ...scope, projectId: "other" }, create],
    [scope, { ...create, rpcDeadlineMs: 100_001 }],
    [scope, { ...create, requestId: "other" }],
    [scope, { ...create, presetDigest: "other" }],
  ] as const) {
    await expect(caller.call(badScope, "incus/lifecycle/create", badInput))
      .rejects.toMatchObject({ code: "SCOPE_INVALID" });
  }
  expect(calls).toHaveLength(0);
}, DB_TEST_TIMEOUT_MS);

test("current release and journal state gate mutations", async () => {
  const caller = await fixture("START");
  const power = { ...common, requestId: "operation", idempotencyKey: "operation",
    desiredState: "running", expectedGeneration: 1 };
  expect(await caller.call(scope, "incus/lifecycle/setPower", power)).toMatchObject({ ok: true });
  await expect(caller.call(scope, "incus/lifecycle/setPower", { ...power, desiredState: "stopped" }))
    .rejects.toMatchObject({ code: "SCOPE_INVALID" });
  await database.update(schema.sandboxOperations).set({ state: "PROVIDER_PENDING" });
  await expect(caller.call(scope, "incus/lifecycle/setPower", power))
    .rejects.toMatchObject({ code: "SCOPE_INVALID" });
  await database.update(schema.sandboxOperations).set({ state: "DISPATCHING" });
  activeRelease = null;
  await expect(caller.call(scope, "incus/lifecycle/setPower", power))
    .rejects.toMatchObject({ code: "RELEASE_REVOKED" });
  expect(calls).toHaveLength(1);
}, DB_TEST_TIMEOUT_MS);

test("operation readback uses its durable provider id after the binding advances", async () => {
  const caller = await fixture();
  await database.update(schema.sandboxOperations).set({ state: "OUTCOME_UNKNOWN" });
  await database.update(schema.sandboxBindings).set({ generation: 2, currentOperationId: "next" });
  const inspect = { ...common, operationId: "provider-operation" };
  expect(await caller.call(scope, "incus/lifecycle/inspectOperation", inspect))
    .toEqual({ ok: true, operation: "lifecycle.inspectOperation" });
  await expect(caller.call(scope, "incus/lifecycle/inspectOperation", { ...inspect, operationId: "other" }))
    .rejects.toMatchObject({ code: "SCOPE_INVALID" });
  activeRelease = { installation: { generation: 0 }, release: { id: "release" } };
  await expect(caller.call(scope, "incus/lifecycle/inspectOperation", inspect))
    .rejects.toMatchObject({ code: "RELEASE_CHANGED" });
  expect(calls).toHaveLength(1);
}, DB_TEST_TIMEOUT_MS);

test("operation ID, journal state and generation mismatch deny readback or mutation", async () => {
  const caller = await fixture("STOP");
  const power = { ...common, requestId: "operation", idempotencyKey: "operation",
    desiredState: "stopped", expectedGeneration: 1 };
  await database.update(schema.sandboxBindings).set({ currentOperationId: "another" });
  await expect(caller.call(scope, "incus/lifecycle/setPower", power))
    .rejects.toMatchObject({ code: "SCOPE_INVALID" });
  await database.update(schema.sandboxBindings).set({ currentOperationId: "operation" });
  await expect(caller.call(scope, "incus/lifecycle/setPower", { ...power, expectedGeneration: 2 }))
    .rejects.toMatchObject({ code: "SCOPE_INVALID" });
  await database.update(schema.sandboxOperations).set({ state: "SUCCEEDED" });
  await expect(caller.call(scope, "incus/lifecycle/inspectOperation", { ...common, operationId: "provider-operation" }))
    .rejects.toMatchObject({ code: "SCOPE_INVALID" });
  expect(calls).toHaveLength(0);
}, DB_TEST_TIMEOUT_MS);

test("feature service default inspection closes its release process", async () => {
  await fixture();
  const { IncusFeatureService } = await import("./incus-feature-service");
  const service = new IncusFeatureService({ db: database, loadQualification: async () => null });
  const inspect = service as unknown as { inspect: (installationId: string, bindingId: string,
    input: Record<string, unknown>) => Promise<unknown> };
  expect(await inspect.inspect("installation", "binding", common))
    .toEqual({ ok: true, operation: "lifecycle.inspect" });
  expect(calls).toEqual([{ operation: "lifecycle.inspect", input: common }]);
  expect(settled).toBe(true);
}, DB_TEST_TIMEOUT_MS);


test("retired destroy uses host cleanup with the durable destroy receipt", async () => {
  const caller = await fixture("DESTROY");
  activeRelease = null;
  const destroy = { ...common, requestId: "operation", idempotencyKey: "operation", expectedGeneration: 1 };
  expect(await caller.call(scope, "incus/lifecycle/destroy", destroy))
    .toEqual({ ok: true, retired: true });
  expect(retiredCalls).toEqual(["lifecycle.destroy"]);
  expect(calls).toHaveLength(0);
}, DB_TEST_TIMEOUT_MS);
