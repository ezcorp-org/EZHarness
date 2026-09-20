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

async function fixture(invoke?: SandboxProviderInvocation) {
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
  controller = createSandboxController(local, runtime, reviewed);
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

test("persists a process writer lease and denies an interleaved file writer", async () => {
  const context = await fixture();
  const create = await admitCreate(context);
  await context.controller.executeAdmittedLocalSandboxOperation(context.owner.id, create.operation!.id);
  const conversationId = crypto.randomUUID();
  await context.database.execute(sql`INSERT INTO conversations(id,project_id,user_id,title) VALUES(${conversationId},${create.projectId},${context.owner.id},'Sandbox process')`);
  const start = await context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.process.v1", operation: "start", idempotencyKey: "process-start", conversationId, payload: { argv: ["echo", "ok"], env: {}, cwd: "/workspace", user: "workspace", timeoutMs: 1000 } });
  expect(start.state).toBe("admitted");
  await expect(context.controller.admitSandboxMethod(context.owner.id, create.projectId, { group: "sandbox.files.v1", operation: "write", idempotencyKey: "write-during-process", conversationId, payload: { path: "/a", encoding: "utf8", data: "x" } })).rejects.toMatchObject({ code: "WRITER_LEASED" });
  const persisted = await context.controller.getSandboxOperationResult(context.owner.id, start.id);
  expect(persisted).toMatchObject({ id: start.id, group: "sandbox.process.v1", operation: "start", state: "admitted" });
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
