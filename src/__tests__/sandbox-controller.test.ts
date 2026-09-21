import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { sql } from "drizzle-orm";
import { validateManifest } from "@ezcorp/extension-contract";
import { providerMethodSchemas } from "../../packages/@ezcorp/extension-contract/src/validation";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import type { LocalSandboxDriver } from "../runtime/sandbox/controller/types";
import type { SandboxProviderInvocation } from "../runtime/sandbox/controller/types";
import { users } from "../db/schema";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";

mockDbConnection();
const { configureSandboxController, createSandboxController, getSandboxController } = await import("../runtime/sandbox/controller");

afterAll(closeTestDb);
beforeEach(setupTestDb);

const limits = { memoryBytes: 1_048_576, milliCpu: 1000, pids: 64, diskBytes: 10_485_760 };
const receipt = (call: { operationId: string; idempotencyKey: string; requestDigest: string }) => ({ operationId: call.operationId, idempotencyKey: call.idempotencyKey, requestDigest: call.requestDigest, outcome: "succeeded" as const });

function driver() {
  const create = mock<LocalSandboxDriver["create"]>(async input => ({ receipt: receipt(input.call), resource: { resourceId: "resource-1", desiredState: "stopped" as const, observedState: "stopped" as const, limits } }));
  const lifecycle = (desiredState: "running" | "stopped" | "destroyed", observedState: "running" | "stopped" | "destroyed") => mock(async (input: any) => ({ receipt: receipt(input.call), resource: { resourceId: input.resourceId, desiredState, observedState, limits } }));
  const process = mock(async (input: any) => ({ receipt: receipt(input.call), process: { identity: input.identity ?? { bootId: "boot-1", processId: "process-1" }, state: "exited" as const, exitCode: 0, outputCursor: 2 } }));
  const output = mock(async (input: any) => ({ receipt: receipt(input.call), identity: input.identity, cursor: 2, chunks: input.cursor === 0 ? [{ stream: "stdout" as const, encoding: "utf8" as const, data: "ok" }] : [], eof: true, gap: false }));
  const file = mock(async (input: any) => ({ receipt: receipt(input.call) }));
  return { create, inspect: lifecycle("stopped", "stopped"), start: lifecycle("running", "running"), stop: lifecycle("stopped", "stopped"), destroy: lifecycle("destroyed", "destroyed"), processStart: process, processInspect: process, processReadOutput: output, processCancel: process, fileStat: file, fileList: file, fileRead: file, fileWrite: file, fileMkdir: file, fileRemove: file, fileChmod: file } as unknown as LocalSandboxDriver;
}

async function fixture(invoke?: SandboxProviderInvocation, clock?: { now(): number; sleep(ms: number): Promise<void> }) {
  const database = getTestDb();
  const [owner] = await database.insert(users).values({ email: `owner-${crypto.randomUUID()}@example.test`, name: "Owner", passwordHash: "unused" }).returning();
  const [other] = await database.insert(users).values({ email: `other-${crypto.randomUUID()}@example.test`, name: "Other", passwordHash: "unused" }).returning();
  const installation = { id: "sandbox-installation", ownerId: owner!.id, scope: "global", activeReleaseId: "sandbox-release", generation: 4, acknowledgedGeneration: 4, enabled: true, uninstalled: false, status: "active", grants: [] };
  const groups = [
    ["sandbox.lifecycle.v1", ["create", "inspect", "start", "stop", "destroy"]],
    ["sandbox.process.v1", ["start", "inspect", "readOutput", "cancel"]],
    ["sandbox.files.v1", ["stat", "list", "read", "write", "mkdir", "remove", "chmod"]],
  ] as const;
  const schemas = providerMethodSchemas as unknown as (group: string, operation: string) => { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> };
  const methods = groups.flatMap(([group, operations]) => operations.map(operation => ({ name: `${group}:${operation}`, ...schemas(group, operation), sensitivity: "ordinary" as const })));
  const manifest = validateManifest({ schemaVersion: 4, name: "local-sandbox", version: "1.0.0", author: { name: "Test" }, description: "Sandbox fixture", permissions: { hostApi: { routes: [{ method: "POST", path: "/api/local-sandbox/operations/:id/execute" }], events: false } }, methods, providers: [{ id: "local", kind: "sandbox", protocolMajor: 1, minimumHostContract: { major: 4, minor: 0 }, profiles: ["linux-exec.v1"], capabilities: [], configSchema: {}, requiredPermissions: ["hostApi"], methodGroups: [{ name: "sandbox.lifecycle.v1", methods: { create: "sandbox.lifecycle.v1:create", inspect: "sandbox.lifecycle.v1:inspect", start: "sandbox.lifecycle.v1:start", stop: "sandbox.lifecycle.v1:stop", destroy: "sandbox.lifecycle.v1:destroy" } }, { name: "sandbox.process.v1", methods: { start: "sandbox.process.v1:start", inspect: "sandbox.process.v1:inspect", readOutput: "sandbox.process.v1:readOutput", cancel: "sandbox.process.v1:cancel" } }, { name: "sandbox.files.v1", methods: { stat: "sandbox.files.v1:stat", list: "sandbox.files.v1:list", read: "sandbox.files.v1:read", write: "sandbox.files.v1:write", mkdir: "sandbox.files.v1:mkdir", remove: "sandbox.files.v1:remove", chmod: "sandbox.files.v1:chmod" } }] }] });
  const release = { id: "sandbox-release", installationId: installation.id, releaseDigest: "release-digest", policyDigest: "policy-digest", manifest };
  await database.execute(sql`INSERT INTO extension_release_installations(id,owner_id,scope,payload) VALUES(${installation.id},${owner!.id},'global',${JSON.stringify(installation)})`);
  await database.execute(sql`INSERT INTO extension_release_records(installation_id,kind,id,payload) VALUES(${installation.id},'releases',${release.id},${JSON.stringify(release)})`);
  const local = driver();
  const runtime = { resolve: async (installationId: string) => {
    const row = await database.execute(sql`SELECT payload FROM extension_release_installations WHERE id=${installationId}`) as { rows: Array<{ payload: string }> };
    if (!row.rows[0]) return null;
    return { installation: JSON.parse(row.rows[0].payload), release, limits: { memoryBytes: 1_048_576, cpuMillis: 1000, pids: 64, tmpBytes: 10_485_760, outputBytes: 65_536, timeoutMs: 30_000 } } as ActiveExtensionRelease;
  } };
  let controller: ReturnType<typeof createSandboxController>;
  const reviewed: SandboxProviderInvocation = invoke ?? (async (userId, _projectId, _provider, _group, _operation, input, signal) => controller.executeAdmittedLocalSandboxOperationRaw(userId, (input as { call: { operationId: string } }).call.operationId, signal));
  controller = createSandboxController(local, runtime, reviewed, clock);
  return { database, owner: owner!, other: other!, installation, local, controller };
}

async function admitCreate(context: Awaited<ReturnType<typeof fixture>>) {
  return context.controller.createSandboxProject(context.owner.id, { name: "Sandbox project", idempotencyKey: "create-once", providerInstallationId: context.installation.id, providerId: "local", config: {}, limits });
}

test("startup accessor fails closed until a host driver configures it", () => {
  expect(() => getSandboxController()).toThrow("Local sandbox controller is not configured");
  const configured = configureSandboxController(driver(), { resolve: async () => null });
  expect(getSandboxController()).toBe(configured);
});

test("lists only active acknowledged sandbox providers and journals create before its effect", async () => {
  const context = await fixture();
  expect(await context.controller.listLocalSandboxProviders(context.owner.id)).toMatchObject([{ installationId: context.installation.id, providerId: "local", releaseId: "sandbox-release", generation: 4 }]);
  const admitted = await admitCreate(context);
  expect((await admitCreate(context)).projectId).toBe(admitted.projectId);
  expect(admitted.resource).toBeNull();
  expect(admitted.operation).toMatchObject({ action: "create", state: "admitted" });
  expect(context.local.create).not.toHaveBeenCalled();
  const count = await context.database.execute(sql`SELECT COUNT(*)::int AS count FROM sandbox_operations WHERE id=${admitted.operation!.id}`) as { rows: Array<{ count: number }> };
  expect(Number(count.rows[0]!.count)).toBe(1);
  const executed = await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, admitted.operation!.id);
  expect(context.local.create).toHaveBeenCalledTimes(1);
  expect(executed.resource).toMatchObject({ resourceId: "resource-1", observedState: "stopped" });
  expect(executed.operation).toMatchObject({ state: "succeeded" });
  const workspace = await context.database.execute(sql`SELECT state FROM project_workspace_bindings WHERE project_id=${admitted.projectId}`) as { rows: Array<{ state: string }> };
  expect(workspace.rows[0]!.state).toBe("active");
});

test("replays a settled operation without a second provider effect and admits idempotent lifecycle actions", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  expect(context.local.create).toHaveBeenCalledTimes(1);
  const first = await context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "start", idempotencyKey: "start-once" });
  const replay = await context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "start", idempotencyKey: "start-once" });
  expect(replay).toEqual(first);
  await expect(context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "stop", idempotencyKey: "stop-while-start-admitted" })).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, first.id);
  expect(context.local.start).toHaveBeenCalledTimes(1);
});

test("replays a concurrent lifecycle admission after its insert conflicts", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const [first, second] = await Promise.all([
    context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "start", idempotencyKey: "concurrent-start" }),
    context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "start", idempotencyKey: "concurrent-start" }),
  ]);
  expect(second).toEqual(first);
  const stored = await context.database.execute(sql`SELECT id FROM sandbox_operations WHERE binding_id=${create.bindingId} AND idempotency_key='concurrent-start'`) as { rows: Array<{ id: string }> };
  expect(stored.rows).toEqual([{ id: first.id }]);
});

test("persists a process writer lease and denies an interleaved file writer", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Sandbox process')`);
  const start = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.process.v1", operation: "start", idempotencyKey: "process-start", conversationId, payload: { argv: ["echo", "ok"], env: {}, cwd: "/workspace", user: "workspace", timeoutMs: 1000 } });
  expect(start.state).toBe("admitted");
  await expect(context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.files.v1", operation: "write", idempotencyKey: "write-during-process", conversationId, payload: { path: "/a", encoding: "utf8", data: "x" } })).rejects.toMatchObject({ code: "WRITER_LEASED" });
  await expect(context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "destroy", idempotencyKey: "destroy-during-process" })).rejects.toMatchObject({ code: "WRITER_LEASED" });
  const persisted = await context.controller.getSandboxOperationResult(context.owner.id, start.id);
  expect(persisted).toMatchObject({ id: start.id, group: "sandbox.process.v1", operation: "start", state: "admitted" });
});

test("serializes disposal against new sandbox access", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Dispose race')`);
  const destroy = await context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "destroy", idempotencyKey: "destroy-first" });
  expect(destroy.state).toBe("admitted");
  await expect(context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.files.v1", operation: "stat", idempotencyKey: "stat-after-destroy", conversationId, payload: { path: "/a" } })).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
});

test("admits either disposal or a racing writer, never both", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Dispose writer race')`);
  const results = await Promise.allSettled([
    context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.files.v1", operation: "write", idempotencyKey: "racing-write", conversationId, payload: { path: "/a", encoding: "utf8", data: "x" } }),
    context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "destroy", idempotencyKey: "racing-destroy" }),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  expect(rejected?.reason).toMatchObject({ code: expect.stringMatching(/^(OPERATION_IN_PROGRESS|WRITER_LEASED)$/) });
});

for (const [operation, payload] of [
  ["read", { path: "/a", offsetBytes: 0, lengthBytes: 1 }],
  ["write", { path: "/a", encoding: "utf8", data: "x" }],
  ["remove", { path: "/a", recursive: false }],
] as const) {
  test(`admits either a lifecycle start or a racing file ${operation}, never both`, async () => {
    const context = await fixture();
    const create = await admitCreate(context);
    await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
    const conversationId = crypto.randomUUID();
    await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Lifecycle race')`);
    const results = await Promise.allSettled([
      context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "start", idempotencyKey: `start-vs-${operation}` }),
      context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.files.v1", operation, idempotencyKey: `${operation}-vs-start`, conversationId, payload }),
    ]);
    expect(results.filter(result => result.status === "fulfilled"), operation).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason, operation).toMatchObject({ code: expect.stringMatching(/^(OPERATION_IN_PROGRESS|WRITER_LEASED)$/) });
  });
}

test("an admitted file read blocks a lifecycle transition", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Read fence')`);
  await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.files.v1", operation: "read", idempotencyKey: "active-read", conversationId, payload: { path: "/a", offsetBytes: 0, lengthBytes: 1 } });
  await expect(context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "start", idempotencyKey: "start-during-read" })).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
});

test("keeps the writer lease through a running process and releases it only after stopped inspection", async () => {
  let processState: "running" | "exited" = "running";
  const context = await fixture();
  context.local.processStart = mock(async (input: any) => ({ receipt: receipt(input.call), process: { identity: { bootId: "boot", processId: "process" }, state: "running" as const, outputCursor: 0 } }));
  context.local.processInspect = mock(async (input: any) => ({ receipt: receipt(input.call), process: { identity: input.identity, state: processState, ...(processState === "exited" ? { exitCode: 0 } : {}), outputCursor: 1 } }));
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Process')`);
  const start = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.process.v1", operation: "start", idempotencyKey: "start", conversationId, payload: { argv: ["echo"], env: {}, cwd: "/workspace", user: "workspace", timeoutMs: 1000 } });
  expect((await context.controller.executeAdmittedSandboxMethod(context.owner.id, start.id)).state).toBe("succeeded");
  const output = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.process.v1", operation: "readOutput", idempotencyKey: "output", conversationId, payload: { identity: { bootId: "boot", processId: "process" }, cursor: 0, maxBytes: 1024 } });
  expect((await context.controller.executeAdmittedSandboxMethod(context.owner.id, output.id)).state).toBe("succeeded");
  const storedOutput = await context.database.execute(sql`SELECT input FROM sandbox_method_operations WHERE id=${output.id}`) as { rows: Array<{ input: string | object }> };
  expect(typeof storedOutput.rows[0]!.input === "string" ? JSON.parse(storedOutput.rows[0]!.input) : storedOutput.rows[0]!.input).toEqual({ identity: { bootId: "boot", processId: "process" }, cursor: 0, maxBytes: 1024 });
  await context.controller.reconcileSandboxProcess(context.owner.id, create.projectId);
  await expect(context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.files.v1", operation: "write", idempotencyKey: "blocked", conversationId, payload: { path: "/a", encoding: "utf8", data: "x" } })).rejects.toMatchObject({ code: "WRITER_LEASED" });
  processState = "exited";
  await context.controller.reconcileSandboxProcess(context.owner.id, create.projectId);
  expect((await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.files.v1", operation: "write", idempotencyKey: "after-stop", conversationId, payload: { path: "/a", encoding: "utf8", data: "x" } })).state).toBe("admitted");
  expect(context.local.processStart).toHaveBeenCalled();
  expect(context.local.inspect).toHaveBeenCalledTimes(1);
});

test("a running process writer lease blocks lifecycle transitions", async () => {
  const context = await fixture();
  context.local.processStart = mock(async (input: any) => ({ receipt: receipt(input.call), process: { identity: { bootId: "boot", processId: "process" }, state: "running" as const, outputCursor: 0 } }));
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Lifecycle process fence')`);
  const start = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.process.v1", operation: "start", idempotencyKey: "running-process", conversationId, payload: { argv: ["sleep"], env: {}, cwd: "/workspace", user: "workspace", timeoutMs: 1000 } });
  expect((await context.controller.executeAdmittedSandboxMethod(context.owner.id, start.id)).state).toBe("succeeded");
  await expect(context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "stop", idempotencyKey: "stop-during-process" })).rejects.toMatchObject({ code: "WRITER_LEASED" });
});

test("an unknown process inspection retains the persisted writer lease", async () => {
  const context = await fixture();
  context.local.processStart = mock(async (input: any) => ({ receipt: receipt(input.call), process: { identity: { bootId: "boot", processId: "process" }, state: "running" as const, outputCursor: 0 } }));
  context.local.processInspect = mock(async (input: any) => ({ receipt: receipt(input.call), process: { identity: input.identity, state: "unknown" as const, outputCursor: 0 } }));
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Unknown process')`);
  const start = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.process.v1", operation: "start", idempotencyKey: "start-unknown", conversationId, payload: { argv: ["echo"], env: {}, cwd: "/workspace", user: "workspace", timeoutMs: 1000 } });
  await context.controller.executeAdmittedSandboxMethod(context.owner.id, start.id);
  await context.controller.reconcileSandboxProcess(context.owner.id, create.projectId);
  await expect(context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.files.v1", operation: "write", idempotencyKey: "still-blocked", conversationId, payload: { path: "/a", encoding: "utf8", data: "x" } })).rejects.toMatchObject({ code: "WRITER_LEASED" });
});

test("a failed process start creates no process and releases its writer lease", async () => {
  const context = await fixture();
  context.local.processStart = mock(async (input: any) => ({ receipt: { ...receipt(input.call), outcome: "failed" as const, error: { code: "resource_not_running", message: "Process start failed.", retryable: false } } }));
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Failed process')`);
  const start = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.process.v1", operation: "start", idempotencyKey: "failed-start", conversationId, payload: { argv: ["false"], env: {}, cwd: "/workspace", user: "workspace", timeoutMs: 1000 } });
  expect((await context.controller.executeAdmittedSandboxMethod(context.owner.id, start.id)).state).toBe("failed");
  const processes = await context.database.execute(sql`SELECT id FROM sandbox_processes WHERE operation_id=${start.id}`) as { rows: unknown[] };
  const leases = await context.database.execute(sql`SELECT operation_id FROM sandbox_writer_leases WHERE binding_id=${create.bindingId}`) as { rows: unknown[] };
  expect(processes.rows).toEqual([]);
  expect(leases.rows).toEqual([]);
});

test("an unknown process start retains only its unknown writer lease", async () => {
  const context = await fixture();
  context.local.processStart = mock(async (input: any) => ({ receipt: { ...receipt(input.call), outcome: "unknown" as const, error: { code: "process_start_unknown", message: "Process start may have run.", retryable: true } } }));
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Unknown process start')`);
  const start = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.process.v1", operation: "start", idempotencyKey: "unknown-start", conversationId, payload: { argv: ["maybe"], env: {}, cwd: "/workspace", user: "workspace", timeoutMs: 1000 } });
  expect((await context.controller.executeAdmittedSandboxMethod(context.owner.id, start.id)).state).toBe("unknown");
  const processes = await context.database.execute(sql`SELECT id FROM sandbox_processes WHERE operation_id=${start.id}`) as { rows: unknown[] };
  const leases = await context.database.execute(sql`SELECT operation_id,state FROM sandbox_writer_leases WHERE binding_id=${create.bindingId}`) as { rows: Array<{ operation_id: string; state: string }> };
  expect(processes.rows).toEqual([]);
  expect(leases.rows).toEqual([{ operation_id: start.id, state: "unknown" }]);
});

test("a recovered file mutation terminalizes and releases its writer lease", async () => {
  const context = await fixture();
  let interrupted = true;
  context.local.fileWrite = mock(async (input: any) => interrupted
    ? { receipt: { ...receipt(input.call), outcome: "unknown" as const, error: { code: "operation_outcome_unknown", message: "Interrupted.", retryable: true } } }
    : { receipt: receipt(input.call), entry: { path: input.path, kind: "file" as const, revision: "recovered", sizeBytes: 1, mode: 0o600 } });
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Recovered file')`);
  const write = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.files.v1", operation: "write", idempotencyKey: "interrupted-write", conversationId, payload: { path: "/a", encoding: "utf8", data: "x" } });
  expect((await context.controller.executeAdmittedSandboxMethod(context.owner.id, write.id)).state).toBe("unknown");
  interrupted = false;
  const stop = await context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "stop", idempotencyKey: "stop-after-recovery" });
  expect(stop.state).toBe("admitted");
  expect((await context.controller.getSandboxOperationResult(context.owner.id, write.id)).state).toBe("succeeded");
  const leases = await context.database.execute(sql`SELECT operation_id FROM sandbox_writer_leases WHERE binding_id=${create.bindingId}`) as { rows: unknown[] };
  expect(leases.rows).toEqual([]);
});

test("native runner journals a fresh process, reads output, and proves terminal inspection", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Native')`);
  const workspace = await context.database.execute(sql`SELECT binding_id,revision FROM project_workspace_bindings WHERE project_id=${create.projectId}`) as { rows: Array<{ binding_id: string; revision: number }> };
  const result = await context.controller.runNativeWorkspaceProcess({ projectId: create.projectId, bindingId: workspace.rows[0]!.binding_id, revision: Number(workspace.rows[0]!.revision) }, { argv: ["/usr/local/bin/bun", "/opt/ezharness/native-tools.js", "ZXhpdCAw"], timeoutMs: 1_000 }, undefined, { userId: context.owner.id, conversationId });
  expect(result).toEqual({ stdout: "ok", exitCode: 0 });
  expect(context.local.start).toHaveBeenCalledTimes(1);
  expect(context.local.processStart).toHaveBeenCalled();
  expect(context.local.processReadOutput).toHaveBeenCalled();
  expect(context.local.processInspect).toHaveBeenCalled();
  const operations = await context.database.execute(sql`SELECT id FROM sandbox_method_operations WHERE method='start'`) as { rows: Array<{ id: string }> };
  expect(operations.rows[0]!.id).not.toContain("native:");
});

test("denies a user without project membership before operation execution", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await expect(context.controller.getProjectSandboxStatus(context.other.id, create.projectId)).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  await expect(context.controller.executeAdmittedLocalSandboxOperation(context.other.id, create.operation!.id)).rejects.toMatchObject({ code: "OPERATION_NOT_ADMITTED" });
  expect(context.local.create).not.toHaveBeenCalled();
});

test("rechecks the active acknowledged provider before execution after approval revocation", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.database.execute(sql`UPDATE extension_release_installations SET payload=${JSON.stringify({ ...context.installation, enabled: false })} WHERE id=${context.installation.id}`);
  await expect(context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id)).rejects.toMatchObject({ code: "PROVIDER_INACTIVE" });
  expect(context.local.create).not.toHaveBeenCalled();
  const operation = await context.database.execute(sql`SELECT state FROM sandbox_operations WHERE id=${create.operation!.id}`) as { rows: Array<{ state: string }> };
  expect(operation.rows[0]!.state).toBe("admitted");
});

test("rejects a reviewed provider response that did not use the raw host callback", async () => {
  const context = await fixture(async (_userId, _projectId, _provider, _group, _operation, input) => {
    const call = (input as { call: { operationId: string; idempotencyKey: string; requestDigest: string } }).call;
    return { receipt: receipt(call), resource: { resourceId: "forged", desiredState: "stopped" as const, observedState: "stopped" as const, limits } };
  });
  const create = await admitCreate(context);
  await expect(context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id)).rejects.toMatchObject({ code: "PROVIDER_RESULT_UNVERIFIED" });
  await expect(context.controller.executeAdmittedLocalSandboxOperationRaw(context.owner.id, create.operation!.id)).rejects.toMatchObject({ code: "RAW_DISPATCH_DENIED" });
  const operation = await context.database.execute(sql`SELECT state FROM sandbox_operations WHERE id=${create.operation!.id}`) as { rows: Array<{ state: string }> };
  expect(operation.rows[0]!.state).toBe("admitted");
  expect(context.local.create).not.toHaveBeenCalled();
});

test("a host-confirmed clean create failure releases the one local slot", async () => {
  const context = await fixture();
  context.local.create = mock(async input => ({ receipt: { operationId: input.call.operationId, idempotencyKey: input.call.idempotencyKey, requestDigest: input.call.requestDigest, outcome: "failed" as const, error: { code: "create_failed_clean", message: "cleaned", retryable: false } } }));
  const create = await admitCreate(context);
  const status = await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  expect(status.operation).toMatchObject({ state: "failed" });
  const resource = await context.database.execute(sql`SELECT desired_state,observed_state FROM sandbox_resources WHERE binding_id=${status.bindingId}`) as { rows: Array<{ desired_state: string; observed_state: string }> };
  expect(resource.rows[0]).toEqual({ desired_state: "destroyed", observed_state: "destroyed" });
});

test("an interrupted raw create stays unknown and retains its reservation", async () => {
  const context = await fixture();
  context.local.create = mock(async () => { throw new Error("transport lost"); });
  const create = await admitCreate(context);
  await expect(context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id)).rejects.toThrow("transport lost");
  const resource = await context.database.execute(sql`SELECT observed_state FROM sandbox_resources WHERE binding_id=${create.bindingId}`) as { rows: Array<{ observed_state: string }> };
  expect(resource.rows[0]!.observed_state).toBe("unknown");
});

test("reuses an interrupted same-actor disposal with fresh reviewed authorization and releases the local slot", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  let attempts = 0;
  context.local.destroy = mock(async input => {
    attempts++;
    if (attempts === 1) throw new Error("transport lost");
    return { receipt: receipt(input.call), resource: { resourceId: input.resourceId, desiredState: "destroyed" as const, observedState: "destroyed" as const, limits } };
  });
  const initial = await context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "destroy", idempotencyKey: "dispose-original" });
  await expect(context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, initial.id)).rejects.toThrow("transport lost");
  await expect(context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "start", idempotencyKey: "dispose-original" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await context.database.execute(sql`INSERT INTO project_members(id,project_id,user_id,role) VALUES(${crypto.randomUUID()},${create.projectId},${context.other.id},'member')`);
  await expect(context.controller.requestSandboxAction(context.other.id, create.projectId, { action: "destroy", idempotencyKey: "other-dispose" })).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
  const retried = await context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "destroy", idempotencyKey: "dispose-retry" });
  expect(retried).toMatchObject({ id: initial.id, action: "destroy", state: "unknown" });
  const status = await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, retried.id);
  expect(attempts).toBe(2);
  expect(status.resource).toMatchObject({ observedState: "destroyed" });
  await expect(context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "destroy", idempotencyKey: "after-disposal" })).rejects.toMatchObject({ code: "RESOURCE_DESTROYED" });
  const next = await context.controller.createSandboxProject(context.owner.id, { name: "Next task", idempotencyKey: "next-task-after-retry", providerInstallationId: context.installation.id, providerId: "local", config: {}, limits });
  expect(next.projectId).not.toBe(create.projectId);
});

test("does not reuse a failed disposal", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  context.local.destroy = mock(async input => ({ receipt: { ...receipt(input.call), outcome: "failed" as const, error: { code: "destroy_failed", message: "not destroyed", retryable: true } } }));
  const failed = await context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "destroy", idempotencyKey: "dispose-failed" });
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, failed.id);
  const fresh = await context.controller.requestSandboxAction(context.owner.id, create.projectId, { action: "destroy", idempotencyKey: "dispose-fresh" });
  expect(fresh).toMatchObject({ action: "destroy", state: "admitted" });
  expect(fresh.id).not.toBe(failed.id);
});

test("method idempotency binds the conversation and canonical payload", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const one = crypto.randomUUID(); const two = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${one},${create.projectId},${context.owner.id},'One'),(${two},${create.projectId},${context.owner.id},'Two')`);
  await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.process.v1", operation: "inspect", idempotencyKey: "same", conversationId: one, payload: { identity: { bootId: "boot", processId: "process" } } });
  await expect(context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.process.v1", operation: "inspect", idempotencyKey: "same", conversationId: two, payload: { identity: { bootId: "boot", processId: "process" } } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

test("identical method admission replays its durable operation", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const admitted = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.process.v1", operation: "inspect", idempotencyKey: "replay", payload: { identity: { bootId: "boot", processId: "process" } } });
  const replay = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.process.v1", operation: "inspect", idempotencyKey: "replay", payload: { identity: { bootId: "boot", processId: "process" } } });
  expect(replay).toEqual(admitted);
});

test("invalid host driver output becomes an unknown durable method operation", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  context.local.fileStat = mock(async () => ({} as never));
  const admitted = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.files.v1", operation: "stat", idempotencyKey: "bad-result", payload: { path: "/x" } });
  await expect(context.controller.executeAdmittedSandboxMethod(context.owner.id, admitted.id)).rejects.toThrow();
  expect((await context.controller.getSandboxOperationResult(context.owner.id, admitted.id)).state).toBe("unknown");
});

test("a valid but unsupported generic lifecycle method is durably marked unknown", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const admitted = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.lifecycle.v1", operation: "start", idempotencyKey: "unsupported", payload: {} });
  await expect(context.controller.executeAdmittedSandboxMethod(context.owner.id, admitted.id)).rejects.toMatchObject({ code: "INVALID_OPERATION" });
  expect((await context.controller.getSandboxOperationResult(context.owner.id, admitted.id)).state).toBe("unknown");
});

test("raw dispatcher persists canonical cancel and file method results", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Methods')`);
  const identity = { bootId: "boot", processId: "process" };
  context.local.processCancel = mock(async (input: any) => ({ receipt: receipt(input.call), process: { identity: input.identity, state: "cancelled" as const, outputCursor: 0 } }));
  const entry = { path: "/x", kind: "file" as const, revision: "r1", sizeBytes: 1, mode: 420 };
  context.local.fileStat = mock(async (input: any) => ({ receipt: receipt(input.call), entry }));
  context.local.fileList = mock(async (input: any) => ({ receipt: receipt(input.call), entries: [] }));
  context.local.fileRead = mock(async (input: any) => ({ receipt: receipt(input.call), path: "/x", revision: "r1", offsetBytes: 0, nextOffsetBytes: 1, eof: true, encoding: "utf8" as const, data: "x" }));
  context.local.fileWrite = mock(async (input: any) => ({ receipt: receipt(input.call), entry }));
  context.local.fileMkdir = mock(async (input: any) => ({ receipt: receipt(input.call), entry: { ...entry, path: "/dir", kind: "directory" as const } }));
  context.local.fileRemove = mock(async (input: any) => ({ receipt: receipt(input.call), removedRevision: "r1" }));
  context.local.fileChmod = mock(async (input: any) => ({ receipt: receipt(input.call), entry }));
  const cases: Array<[string, Record<string, unknown>]> = [["cancel", { identity }], ["stat", { path: "/x" }], ["list", { path: "/", limit: 10 }], ["read", { path: "/x", offsetBytes: 0, lengthBytes: 10 }], ["write", { path: "/x", encoding: "utf8", data: "x" }], ["mkdir", { path: "/dir", recursive: false }], ["remove", { path: "/x", recursive: false }], ["chmod", { path: "/x", mode: 420 }]];
  for (const [operation, payload] of cases) {
    const group = operation === "cancel" ? "sandbox.process.v1" : "sandbox.files.v1";
    const admitted = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group, operation, idempotencyKey: crypto.randomUUID(), conversationId, payload });
    expect((await context.controller.executeAdmittedSandboxMethod(context.owner.id, admitted.id)).state).toBe("succeeded");
  }
});

test("native abort sends canonical cancel and reconciles the writer lease", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID(); const abort = new AbortController();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Abort')`);
  context.local.processStart = mock(async (input: any) => { abort.abort(); return { receipt: receipt(input.call), process: { identity: { bootId: "boot", processId: "cancel-me" }, state: "running" as const, outputCursor: 0 } }; });
  context.local.processCancel = mock(async (input: any) => ({ receipt: receipt(input.call), process: { identity: input.identity, state: "cancelled" as const, outputCursor: 0 } }));
  context.local.processInspect = mock(async (input: any) => ({ receipt: receipt(input.call), process: { identity: input.identity, state: "cancelled" as const, outputCursor: 0 } }));
  context.local.processReadOutput = mock(async (input: any) => ({ receipt: receipt(input.call), identity: input.identity, cursor: input.cursor, chunks: [], eof: true, gap: false }));
  const workspace = await context.database.execute(sql`SELECT binding_id,revision FROM project_workspace_bindings WHERE project_id=${create.projectId}`) as { rows: Array<{ binding_id: string; revision: number }> };
  await expect(context.controller.runNativeWorkspaceProcess({ projectId: create.projectId, bindingId: workspace.rows[0]!.binding_id, revision: Number(workspace.rows[0]!.revision) }, { argv: ["/usr/local/bin/bun", "/opt/ezharness/native-tools.js", "ZXhpdCAw"], timeoutMs: 1_000 }, abort.signal, { userId: context.owner.id, conversationId })).rejects.toThrow();
  expect(context.local.processCancel).toHaveBeenCalled();
  const lease = await context.database.execute(sql`SELECT * FROM sandbox_writer_leases WHERE binding_id=${create.bindingId}`) as { rows: unknown[] };
  expect(lease.rows).toHaveLength(0);
});

test("native deadline uses the injected clock, waits, cancels, and reconciles", async () => {
  let now = 0; let sleeps = 0;
  const context = await fixture(undefined, { now: () => now, sleep: async () => { sleeps++; now = 31_001; } });
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Deadline')`);
  const identity = { bootId: "boot", processId: "slow" };
  context.local.processStart = mock(async (input: any) => ({ receipt: receipt(input.call), process: { identity, state: "running" as const, outputCursor: 0 } }));
  context.local.processInspect = mock(async (input: any) => ({ receipt: receipt(input.call), process: { identity: input.identity, state: "running" as const, outputCursor: 0 } }));
  context.local.processReadOutput = mock(async (input: any) => ({ receipt: receipt(input.call), identity: input.identity, cursor: 0, chunks: [], eof: true, gap: false }));
  context.local.processCancel = mock(async (input: any) => ({ receipt: receipt(input.call), process: { identity: input.identity, state: "cancelled" as const, outputCursor: 0 } }));
  const workspace = await context.database.execute(sql`SELECT binding_id,revision FROM project_workspace_bindings WHERE project_id=${create.projectId}`) as { rows: Array<{ binding_id: string; revision: number }> };
  await expect(context.controller.runNativeWorkspaceProcess({ projectId: create.projectId, bindingId: workspace.rows[0]!.binding_id, revision: Number(workspace.rows[0]!.revision) }, { argv: ["/usr/local/bin/bun", "/opt/ezharness/native-tools.js", "ZXhpdCAw"], timeoutMs: 1 }, undefined, { userId: context.owner.id, conversationId })).rejects.toMatchObject({ code: "PROCESS_DEADLINE" });
  expect(sleeps).toBe(1);
  expect(context.local.processCancel).toHaveBeenCalled();
});

test("a disposed workspace cannot be restarted or reserve the next task slot again", async () => {
  const context = await fixture();
  const created = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, created.operation!.id);
  const dispose = await context.controller.requestSandboxAction(context.owner.id, created.projectId, { action: "destroy", idempotencyKey: "dispose" });
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, dispose.id);
  for (const action of ["start", "stop", "destroy"] as const) {
    await expect(context.controller.requestSandboxAction(context.owner.id, created.projectId, { action, idempotencyKey: `after-disposal-${action}` })).rejects.toMatchObject({ code: "RESOURCE_DESTROYED" });
  }
  const next = await context.controller.createSandboxProject(context.owner.id, { name: "Next task", idempotencyKey: "next-task", providerInstallationId: context.installation.id, providerId: "local", config: {}, limits });
  expect(next.projectId).not.toBe(created.projectId);
  expect((await context.controller.getProjectSandboxStatus(context.owner.id, created.projectId)).resource?.observedState).toBe("destroyed");
});
