import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { RunnerError } from "@ezcorp/extension-runner";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import * as schema from "../db/schema";
import { SandboxController } from "./controller";
import {
  IncusDispatchAuthorizationError,
  IncusSandboxProviderDispatcher,
  type HostAuthorizedIncusMethodCaller,
  type IncusDispatchScope,
} from "./incus-dispatcher";

const open: PGlite[] = [];
const deadline = Date.parse("2026-09-22T13:00:00Z");
type Call = { scope: IncusDispatchScope; method: string; input: Record<string, unknown> };

async function setup(revision: number | null = 7) {
  const pglite = new PGlite();
  open.push(pglite);
  await pglite.waitReady;
  await pglite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'user', icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const db = drizzle(pglite, { schema });
  await addSandboxController(db);
  await db.insert(schema.projects).values({ id: "project", name: "project", path: "/work/project" });
  const calls: Call[] = [];
  let respond: (call: Call) => unknown | Promise<unknown> = () => { throw new Error("Unconfigured method caller"); };
  const caller: HostAuthorizedIncusMethodCaller = {
    call: async (scope, method, input) => {
      const call = { scope, method, input };
      calls.push(call);
      return respond(call);
    },
  };
  const provider = new IncusSandboxProviderDispatcher(caller, () => deadline - 30_000);
  const controller = new SandboxController(db, provider);
  const binding = await controller.createBinding({
    id: "binding", projectId: "project", providerInstallationId: "installation",
    providerReleaseId: "release", connectionId: "connection", connectionRevision: revision,
    profile: "linux-exec.v1", presetId: "incus-linux-exec-v1",
    presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64),
    resourceKey: "backend-resource", observedState: "STOPPED",
  });
  return { controller, binding, calls, setRespond: (next: typeof respond) => { respond = next; } };
}

function accepted(call: Call, operationId = "provider-operation") {
  return { ok: true, receipt: {
    operationId, kind: call.method.endsWith("create") ? "create"
      : call.method.endsWith("destroy") ? "destroy" : "setPower",
    requestId: call.input.requestId, idempotencyKey: call.input.idempotencyKey,
    sandboxId: call.input.sandboxId, acceptedAt: "2026-09-22T12:00:00Z",
  } };
}

function inspected(call: Call, observedState: "running" | "stopped" | "absent", state = "succeeded") {
  return { ok: true, operation: {
    operationId: call.input.operationId,
    kind: observedState === "absent" ? "destroy" : observedState === "running" ? "setPower" : "create",
    sandboxId: call.input.sandboxId, state,
    desiredState: observedState, observedState,
    resourceId: null, startedAt: "2026-09-22T12:00:00Z",
    finishedAt: state === "succeeded" ? "2026-09-22T12:00:01Z" : null,
    error: null,
  } };
}

afterEach(async () => { await Promise.all(open.splice(0).map((db) => db.close())); });

test("approved binding scope and durable identity reach the exact Incus method", async () => {
  const { controller, calls, setRespond } = await setup();
  setRespond((call) => accepted(call));
  const operation = await controller.requestAndDispatch({
    bindingId: "binding", kind: "CREATE", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "create-once",
    payload: { profile: "linux-exec.v1", presetId: "incus-linux-exec-v1",
      presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64) },
  });
  expect(operation.state).toBe("PROVIDER_PENDING");
  expect(operation.providerOperationId).toBe("provider-operation");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    scope: { installationId: "installation", releaseId: "release", connectionId: "connection",
      connectionRevision: 7, projectId: "project", bindingId: "binding", generation: 1,
      resourceKey: "backend-resource", operationId: operation.id, deadlineMs: deadline },
    method: "incus/lifecycle/create",
    input: { providerId: "incus", connectionId: "connection", sandboxId: "binding",
      rpcDeadlineMs: deadline, requestId: operation.id, idempotencyKey: operation.id,
      profile: "linux-exec.v1", presetId: "incus-linux-exec-v1",
      presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64), desiredState: "stopped" },
  });
  const replay = await controller.requestAndDispatch({
    bindingId: "binding", kind: "CREATE", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "create-once",
    payload: { profile: "linux-exec.v1", presetId: "incus-linux-exec-v1",
      presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64) },
  });
  expect(replay.id).toBe(operation.id);
  expect(calls).toHaveLength(1);
});

test("reconcile inspects the saved provider operation and updates observed state", async () => {
  const { controller, calls, setRespond } = await setup();
  setRespond((call) => accepted(call));
  const pending = await controller.requestAndDispatch({
    bindingId: "binding", kind: "START", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "start",
    payload: { expectedGeneration: 1 },
  });
  setRespond((call) => inspected(call, "running"));
  await controller.reconcile();
  expect((await controller.getOperation(pending.id))?.state).toBe("SUCCEEDED");
  expect((await controller.getBinding("binding"))?.observedState).toBe("RUNNING");
  expect(calls.map((call) => call.method)).toEqual(["incus/lifecycle/setPower", "incus/lifecycle/inspectOperation"]);
  expect(calls[1]?.input.operationId).toBe("provider-operation");
  expect(calls[1]?.input.requestId).toBeUndefined();
  expect(calls[1]?.input.idempotencyKey).toBeUndefined();
});

test("destroy finishes only after readback proves absence", async () => {
  const { controller, calls, setRespond } = await setup();
  setRespond((call) => accepted(call));
  const pending = await controller.requestAndDispatch({
    bindingId: "binding", kind: "DESTROY", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "destroy", payload: { expectedGeneration: 1 },
  });
  expect(pending.state).toBe("PROVIDER_PENDING");
  expect((await controller.getBinding("binding"))?.cleanupConfirmedAt).toBeNull();
  setRespond((call) => inspected(call, "absent"));
  await controller.reconcile();
  expect((await controller.getOperation(pending.id))?.state).toBe("SUCCEEDED");
  expect((await controller.getBinding("binding"))?.cleanupConfirmedAt).toBeInstanceOf(Date);
  expect(calls.map((call) => call.method)).toEqual(["incus/lifecycle/destroy", "incus/lifecycle/inspectOperation"]);
  expect(calls[1]?.input.requestId).toBeUndefined();
  expect(calls[1]?.input.idempotencyKey).toBeUndefined();
});

test("revoked scope fails before mutation, and unpinned old bindings fail closed", async () => {
  const revoked = await setup();
  revoked.setRespond(() => { throw new IncusDispatchAuthorizationError("CONNECTION_REVOKED"); });
  const result = await revoked.controller.requestAndDispatch({
    bindingId: "binding", kind: "START", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "revoked", payload: { expectedGeneration: 1 },
  });
  expect(result).toMatchObject({ state: "FAILED", errorCode: "CONNECTION_REVOKED" });
  const unpinned = await setup(null);
  const old = await unpinned.controller.requestAndDispatch({
    bindingId: "binding", kind: "START", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "old", payload: { expectedGeneration: 1 },
  });
  expect(old).toMatchObject({ state: "FAILED", errorCode: "SCOPE_INVALID" });
  expect(unpinned.calls).toHaveLength(0);
});

test("lost response stays unknown and never retries mutation", async () => {
  const { controller, calls, setRespond } = await setup();
  setRespond(() => { throw new Error("response lost after acceptance"); });
  const unknown = await controller.requestAndDispatch({
    bindingId: "binding", kind: "DESTROY", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "destroy",
    payload: { expectedGeneration: 1 },
  });
  expect(unknown.state).toBe("OUTCOME_UNKNOWN");
  setRespond(() => { throw new Error("must not redispatch"); });
  await controller.reconcile();
  expect((await controller.getOperation(unknown.id))?.state).toBe("OUTCOME_UNKNOWN");
  expect(calls).toHaveLength(1);
});

test("missing worker artifact is failed; other runner errors preserve unknown outcome", async () => {
  const missing = await setup();
  missing.setRespond(() => { throw new IncusDispatchAuthorizationError("ARTIFACT_UNAVAILABLE"); });
  const failed = await missing.controller.requestAndDispatch({
    bindingId: "binding", kind: "START", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "missing-artifact", payload: { expectedGeneration: 1 },
  });
  expect(failed).toMatchObject({ state: "FAILED", errorCode: "ARTIFACT_UNAVAILABLE" });
  expect((await missing.controller.reconcile()).examined).toBe(0);
  expect(missing.calls).toHaveLength(1);

  const uncertain = await setup();
  uncertain.setRespond(() => { throw new RunnerError("runner_unavailable", "Runner disconnected"); });
  const unknown = await uncertain.controller.requestAndDispatch({
    bindingId: "binding", kind: "START", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "runner-disconnected", payload: { expectedGeneration: 1 },
  });
  expect(unknown.state).toBe("OUTCOME_UNKNOWN");
  expect(uncertain.calls).toHaveLength(1);
});

test("stable unknown provider ID is inspected, and revoked readback preserves uncertainty", async () => {
  const { controller, calls, setRespond } = await setup();
  setRespond(() => ({ ok: false, error: { code: "OUTCOME_UNKNOWN", message: "lost reply",
    retryable: false, operationId: "uncertain-provider-operation" } }));
  const unknown = await controller.requestAndDispatch({
    bindingId: "binding", kind: "START", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "uncertain", payload: { expectedGeneration: 1 },
  });
  expect(unknown).toMatchObject({ state: "OUTCOME_UNKNOWN", providerOperationId: "uncertain-provider-operation" });
  setRespond(() => { throw new IncusDispatchAuthorizationError("CONNECTION_REVOKED"); });
  await controller.reconcile();
  expect((await controller.getOperation(unknown.id))?.state).toBe("OUTCOME_UNKNOWN");
  expect(calls.map((call) => call.method)).toEqual([
    "incus/lifecycle/setPower", "incus/lifecycle/inspectOperation",
  ]);
  expect(calls[1]?.input.operationId).toBe("uncertain-provider-operation");
});

test("adapter INTERNAL for a lost mutation without provider ID remains unknown", async () => {
  const { controller, calls, setRespond } = await setup();
  setRespond(() => ({ ok: false, error: { code: "INTERNAL",
    message: "The Incus transport lost a mutation without a stable operation identity", retryable: false } }));
  const result = await controller.requestAndDispatch({
    bindingId: "binding", kind: "CREATE", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "lost-id", payload: {
      profile: "linux-exec.v1", presetId: "incus-linux-exec-v1",
      presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64),
    },
  });
  expect(result).toMatchObject({ state: "OUTCOME_UNKNOWN", providerOperationId: null });
  await controller.reconcile();
  expect((await controller.getOperation(result.id))?.state).toBe("OUTCOME_UNKNOWN");
  expect(calls).toHaveLength(1);
});

test("a proven pre-write CREATE failure is terminal and is not retried by reconciliation", async () => {
  const { controller, calls, setRespond } = await setup();
  setRespond(() => ({ ok: false, error: { code: "UNAVAILABLE",
    message: "The Incus service is unavailable", retryable: true } }));
  const result = await controller.requestAndDispatch({
    bindingId: "binding", kind: "CREATE", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "tls-before-write", payload: {
      profile: "linux-exec.v1", presetId: "incus-linux-exec-v1",
      presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64),
    },
  });
  expect(result).toMatchObject({ state: "FAILED", errorCode: "UNAVAILABLE", providerOperationId: null });
  expect((await controller.reconcile()).examined).toBe(0);
  expect(calls).toHaveLength(1);
});

test("create rejects a journal payload that disagrees with binding preset pins", async () => {
  const { controller, calls } = await setup();
  const result = await controller.requestAndDispatch({
    bindingId: "binding", kind: "CREATE", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "wrong-preset", payload: {
      profile: "linux-exec.v1", presetId: "incus-linux-exec-v1",
      presetDigest: "c".repeat(64), effectiveSettingsDigest: "b".repeat(64),
    },
  });
  expect(result).toMatchObject({ state: "FAILED", errorCode: "SCOPE_INVALID" });
  expect(calls).toHaveLength(0);
});

test("invalid mutation payload and stale journal cannot select another sandbox", async () => {
  const { controller, calls } = await setup();
  const invalid = await controller.requestAndDispatch({
    bindingId: "binding", kind: "START", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "invalid",
    payload: { expectedGeneration: 1, sandboxId: "other" },
  });
  expect(invalid).toMatchObject({ state: "FAILED", errorCode: "SCOPE_INVALID" });
  const stale = await controller.journalOperation({
    bindingId: "binding", kind: "START", generation: 1,
    idempotencyScope: "lifecycle", idempotencyKey: "stale", payload: { expectedGeneration: 1 },
  });
  await controller.advanceGeneration("binding", 1);
  await expect(controller.executeOperation(stale.id)).rejects.toMatchObject({ code: "STALE_GENERATION" });
  expect(calls).toHaveLength(0);
});
