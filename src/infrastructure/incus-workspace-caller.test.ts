import { afterEach, expect, spyOn, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { SandboxProtocolOperation } from "@ezcorp/extension-contract";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import * as schema from "../db/schema";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import { ReleaseProcess } from "../extensions/release-process";
import type { SandboxWorkspaceBinding } from "../runtime/workspaces/target";
import { SandboxController } from "../sandboxes/controller";
import { incusMethodName } from "../../extensions/incus-sandbox/manifest";
import type { ProviderConnectionCredentials, ProviderConnectionScope } from "./provider-connections/store";
import { IncusWorkspaceCaller } from "./incus-workspace-caller";
import { eq } from "drizzle-orm";
import { getBuiltinToolDefs } from "../runtime/tools";
import { createProviderSandboxWorkspaceBackend } from "../runtime/workspaces/provider-backend";
import { sandboxWorkspaceTarget, createSandboxAgentProviders } from "../runtime/workspaces/target";

const open: PGlite[] = [];
const now = Date.parse("2026-09-22T12:00:00Z");

async function setup(defaultInvoke = false, hostOwned = true) {
  const pglite = new PGlite();
  open.push(pglite);
  await pglite.waitReady;
  await pglite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'user', icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const db = drizzle(pglite, { schema });
  await addSandboxController(db);
  await db.insert(schema.projects).values({ id: "project", name: "project", path: "/work/project" });
  const controller = new SandboxController(db, {
    dispatch: async () => { throw new Error("No lifecycle call expected"); },
    inspectOperation: async () => { throw new Error("No lifecycle inspection expected"); },
  });
  await controller.createBinding({
    id: "binding", projectId: "project", providerInstallationId: "installation",
    providerReleaseId: "release", connectionId: "connection", connectionRevision: 4,
    resourceKey: "binding", profile: "linux-exec.v1", presetId: "incus-linux-exec-v1",
    presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64),
    desiredState: "RUNNING", observedState: "RUNNING",
  });
  const binding: SandboxWorkspaceBinding = {
    projectId: "project", workspaceId: "binding", connectionId: "connection", providerId: "incus",
    generation: 1, presetId: "incus-linux-exec-v1", releaseDigest: "release-digest",
    presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64),
  };
  const connection: ProviderConnectionCredentials = {
    id: "connection", revision: 4, providerInstallationId: "installation", providerReleaseId: "release",
    endpoint: "https://incus.example:8443/", serverCertificatePem: "certificate", project: "ezharness",
    configuration: { kind: "incus", profile: "ezharness-feature", helperVersion: "1.0.0", guestUser: "sandbox" },
    clientCertificatePem: "client", privateKeyPem: "private-key-canary", revokedAt: null,
  };
  const supportedOperations: SandboxProtocolOperation[] = [
    "files.stat", "files.list", "files.readRange", "files.writeAtomic",
    "processes.start", "processes.inspect", "processes.readOutput", "processes.cancel",
  ];
  const release = {
    installation: { id: "installation" },
    release: { id: "release", releaseDigest: "release-digest", manifest: {
      methods: supportedOperations.map(operation => ({ name: incusMethodName(operation) })),
    } },
  } as unknown as ActiveExtensionRelease;
  const calls: Array<{ installationId: string; bindingId: string; operation: SandboxProtocolOperation; input: Record<string, unknown> }> = [];
  const releaseLookups: string[] = [];
  const connectionLookups: ProviderConnectionScope[] = [];
  let connectionHook = async () => {};
  let response: (operation: SandboxProtocolOperation, input: Record<string, unknown>) => unknown = () => ({ ok: true, file: {
    path: "src/app.ts", kind: "file", revision: "revision-1", sizeBytes: 5, executable: false,
  } });
  const caller = new IncusWorkspaceCaller({
    db, hostOwned, now: () => now,
    resolveRelease: async installationId => { releaseLookups.push(installationId); return release; },
    resolveConnection: async scope => { connectionLookups.push(scope); await connectionHook(); return connection; },
    ...(!defaultInvoke ? { invoke: async (installationId: string, bindingId: string, operation: SandboxProtocolOperation, input: Record<string, unknown>) => {
      calls.push({ installationId, bindingId, operation, input });
      return response(operation, input);
    } } : {}),
  });
  return { caller, db, pglite, binding, connection, release, calls, releaseLookups, connectionLookups,
    setConnectionHook: (hook: typeof connectionHook) => { connectionHook = hook; },
    setResponse: (next: typeof response) => { response = next; } };
}

afterEach(async () => { await Promise.all(open.splice(0).map(db => db.close())); });

test("native tools deny the next guest call after the initiating member loses membership", async () => {
  const { caller, db, pglite, binding, calls, setResponse } = await setup(false, false);
  await pglite.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL); CREATE TABLE project_members (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL)");
  await pglite.exec("INSERT INTO users VALUES ('member','member','active'); INSERT INTO project_members VALUES ('membership','project','member','member')");
  setResponse(operation => operation === "files.stat"
    ? { ok: true, file: { path: "src/app.ts", kind: "file", revision: "revision-1", sizeBytes: 0, executable: false } }
    : { ok: true, path: "src/app.ts", revision: "revision-1", offsetBytes: 0, dataBase64: "", byteLength: 0, eof: true });
  const target = sandboxWorkspaceTarget(binding, createProviderSandboxWorkspaceBackend(caller));
  const read = getBuiltinToolDefs(target, undefined, undefined, { userId: "member", conversationId: "owned-conversation" }).find(tool => tool.name === "readFile")!;
  expect((await read.execute("read-1", { path: "src/app.ts" })).content[0]).toMatchObject({ type: "text", text: "" });
  expect(calls).toHaveLength(2);
  await db.delete(schema.projectMembers).where(eq(schema.projectMembers.userId, "member"));
  const denied = await read.execute("read-2", { path: "src/app.ts", userId: "admin" });
  expect(JSON.stringify(denied)).toContain("unavailable");
  const agent = createSandboxAgentProviders(target, { userId: "member" });
  await expect(agent.shell.run("touch denied-marker")).rejects.toThrow("unavailable");
  expect(calls).toHaveLength(2);
});

test("each call reads current active user and role; no principal or forged payload can grant authority", async () => {
  const { caller, pglite, binding, calls } = await setup(false, false);
  await pglite.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL); CREATE TABLE project_members (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL)");
  await pglite.exec("INSERT INTO users VALUES ('actor','member','active'); INSERT INTO project_members VALUES ('membership','project','actor','owner')");
  const request = { binding, toolCallId: "stat:1", action: "file.stat" as const, payload: { path: "src/app.ts" } };
  await expect(caller.call(request)).rejects.toThrow("principal is unavailable");
  await expect(caller.call({ ...request, principal: { userId: "missing" } })).rejects.toThrow("authority is unavailable");
  await caller.call({ ...request, principal: { userId: "actor" } });
  await pglite.exec("UPDATE project_members SET role='unknown'");
  await expect(caller.call({ ...request, principal: { userId: "actor" } })).rejects.toThrow("authority is unavailable");
  await pglite.exec("DELETE FROM project_members; UPDATE users SET role='admin'");
  await caller.call({ ...request, principal: { userId: "actor" } });
  await pglite.exec("UPDATE users SET status='disabled'");
  await expect(caller.call({ ...request, principal: { userId: "actor" } })).rejects.toThrow("authority is unavailable");
  await pglite.exec("UPDATE users SET status='active', role='member'");
  await expect(caller.call({ ...request, principal: { userId: "actor" }, payload: { path: "src/app.ts", userId: "admin" } })).rejects.toThrow("authority is unavailable");
  expect(calls).toHaveLength(2);
});

test("membership revoked during connection resolution denies before guest dispatch", async () => {
  const { caller, pglite, binding, calls, setConnectionHook } = await setup(false, false);
  await pglite.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL); CREATE TABLE project_members (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL); INSERT INTO users VALUES ('actor','member','active'); INSERT INTO project_members VALUES ('membership','project','actor','member')");
  setConnectionHook(async () => { await pglite.exec("DELETE FROM project_members"); });
  await expect(caller.call({ binding, principal: { userId: "actor" }, toolCallId: "stat:1", action: "file.stat", payload: { path: "src/app.ts" } }))
    .rejects.toThrow("authority is unavailable");
  expect(calls).toHaveLength(0);
});

test("the production release call receives a guard that rejects later revocation with the captured project", async () => {
  const { caller, pglite, binding } = await setup(true, false);
  await pglite.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL); CREATE TABLE project_members (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL); INSERT INTO users VALUES ('actor','member','active'); INSERT INTO project_members VALUES ('membership','project','actor','member')");
  const invoke = spyOn(ReleaseProcess.prototype, "callIncusSandboxOperation").mockImplementation(async (_binding, _operation, _input, options) => {
    expect(options?.invocationGuard).toBeFunction();
    await options!.invocationGuard!();
    await pglite.exec("DELETE FROM project_members");
    await pglite.exec("INSERT INTO project_members VALUES ('forged','forged-project','actor','member')");
    // A queued caller cannot replace the fixed authority while awaiting a worker.
    binding.projectId = "forged-project";
    await options!.invocationGuard!();
    throw new Error("Guest effect must not run");
  });
  try {
    await expect(caller.call({ binding, principal: { userId: "actor" }, toolCallId: "stat:1", action: "file.stat", payload: { path: "src/app.ts" } }))
      .rejects.toThrow("authority is unavailable");
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally { invoke.mockRestore(); }
});

test("file action uses the persisted binding and declared Incus method", async () => {
  const { caller, binding, calls, releaseLookups, connectionLookups } = await setup();
  const reply = await caller.call({ binding, toolCallId: "tool-1:1", action: "file.stat", payload: { path: "src/app.ts" } });
  expect(reply).toMatchObject({ ok: true, file: { path: "src/app.ts" } });
  expect(calls).toEqual([{ installationId: "installation", bindingId: "binding", operation: "files.stat",
    input: { providerId: "incus", connectionId: "connection", sandboxId: "binding",
      rpcDeadlineMs: now + 30_000, path: "src/app.ts" } }]);
  expect(releaseLookups).toEqual(["installation"]);
  expect(connectionLookups).toEqual([{ connectionId: "connection", providerInstallationId: "installation",
    providerReleaseId: "release", revision: 4 }]);
});

test("mutations derive stable distinct identities and use the approved guest user", async () => {
  const { caller, binding, calls, setResponse } = await setup();
  setResponse((operation, input) => operation === "processes.start"
    ? { ok: true, processId: "process-1", bootId: "boot-1", startedAt: "2026-09-22T12:00:00Z" }
    : { ok: true, path: input.path, revision: "revision-2", sizeBytes: 5 });
  const write = { binding, toolCallId: "tool-1:1", action: "file.writeAtomic" as const,
    payload: { path: "src/app.ts", expectedRevision: "revision-1", dataBase64: btoa("hello"), byteLength: 5, executable: false } };
  await caller.call(write);
  await caller.call(write);
  await caller.call({ ...write, toolCallId: "tool-1:2" });
  await caller.call({ binding, toolCallId: "shell-1:1", action: "process.start",
    payload: { argv: ["bun", "test"], cwd: ".", user: "workspace", env: [], processDeadlineMs: now + 60_000 } });
  expect(calls.map(call => call.operation)).toEqual([
    "files.writeAtomic", "files.writeAtomic", "files.writeAtomic", "processes.start",
  ]);
  expect(calls[0]?.input.requestId).toBe(calls[1]?.input.requestId);
  expect(calls[0]?.input.requestId).not.toBe(calls[2]?.input.requestId);
  expect(calls[0]?.input.idempotencyKey).toBe(calls[0]?.input.requestId);
  expect(calls[3]?.input.user).toBe("sandbox");
  expect(JSON.stringify(calls)).not.toContain("private-key-canary");
});

test("shell 10s and grep 30s process starts keep RPC deadline within process deadline", async () => {
  const { caller, binding, calls, setResponse } = await setup();
  setResponse(() => ({ ok: true, processId: "process-1", bootId: "boot-1", startedAt: "2026-09-22T12:00:00Z" }));
  const cases = [
    { toolCallId: "shell-1:1", argv: ["/bin/sh", "-c", "true"], timeoutMs: 10_000 },
    { toolCallId: "grep-1:1", argv: ["rg", "-n", "pattern", "."], timeoutMs: 30_000 },
    { toolCallId: "shell-long:1", argv: ["/bin/sh", "-c", "true"], timeoutMs: 60_000 },
  ];
  for (const item of cases) {
    await caller.call({ binding, toolCallId: item.toolCallId, action: "process.start",
      payload: { argv: item.argv, cwd: ".", user: "workspace", env: [], processDeadlineMs: now + item.timeoutMs } });
  }
  expect(calls.map(call => call.input.rpcDeadlineMs)).toEqual([now + 10_000, now + 30_000, now + 30_000]);
  expect(calls.map(call => call.input.processDeadlineMs)).toEqual([now + 10_000, now + 30_000, now + 60_000]);
  expect(calls.every(call => Number(call.input.rpcDeadlineMs) <= Number(call.input.processDeadlineMs))).toBe(true);
});

test("stale binding, release, connection, and revoked state deny before invocation", async () => {
  const { caller, binding, connection, calls } = await setup();
  const input = { binding, toolCallId: "tool-1:1", action: "file.stat" as const, payload: { path: "src/app.ts" } };
  await expect(caller.call({ ...input, binding: { ...binding, workspaceId: "other" } })).rejects.toThrow("binding is unavailable");
  await expect(caller.call({ ...input, binding: { ...binding, generation: 2 } })).rejects.toThrow("binding is unavailable");
  await expect(caller.call({ ...input, binding: { ...binding, releaseDigest: "other" } })).rejects.toThrow("release changed");
  connection.revision = 5;
  await expect(caller.call(input)).rejects.toThrow("connection changed");
  connection.revision = 4;
  connection.revokedAt = new Date();
  await expect(caller.call(input)).rejects.toThrow("connection changed");
  expect(calls).toHaveLength(0);
});

test("unknown action, payload scope injection, missing action suffix, and invalid replies fail closed", async () => {
  const { caller, binding, calls, setResponse } = await setup();
  await expect(caller.call({ binding, toolCallId: "tool-1:1", action: "endpoint.open" as never,
    payload: { port: 3000 } })).rejects.toThrow("unsupported");
  await expect(caller.call({ binding, toolCallId: "tool-1:1", action: "file.stat",
    payload: { path: "src/app.ts", sandboxId: "other" } })).rejects.toThrow("unsupported");
  await expect(caller.call({ binding, toolCallId: "tool-1", action: "file.writeAtomic",
    payload: { path: "src/app.ts", expectedRevision: null, dataBase64: btoa("hello"), byteLength: 5, executable: false } }))
    .rejects.toThrow("unique call suffix");
  setResponse(() => ({ ok: true, file: { path: "other", kind: "file", revision: "revision-1", sizeBytes: 5, executable: false } }));
  await expect(caller.call({ binding, toolCallId: "tool-1:1", action: "file.stat", payload: { path: "src/app.ts" } }))
    .rejects.toThrow("changed path identity");
  expect(calls).toHaveLength(1);
});


test("default caller settles and retires a failed release invocation", async () => {
  const { caller, binding } = await setup(true);
  await expect(caller.call({ binding, toolCallId: "tool-1:1", action: "file.stat",
    payload: { path: "src/app.ts" } })).rejects.toThrow();
});
