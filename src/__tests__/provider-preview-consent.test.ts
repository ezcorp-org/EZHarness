import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import { createProviderSandboxWorkspaceBackend, type ProviderSandboxWorkspaceCaller } from "../runtime/workspaces/provider-backend";
import { sandboxWorkspaceTarget, type SandboxWorkspaceBinding } from "../runtime/workspaces/target";
import { IncusSandboxPreviewBackend } from "../infrastructure/incus-preview-backend";
import { registerPreviewBus, _resetPreviewBusForTests } from "../runtime/preview/preview-bus-registry";

mockDbConnection();
const projects = await import("../db/queries/projects");
const targets = await import("../runtime/workspaces/project-target");
const originalTargets = { ...targets };
const { createUser } = await import("../db/queries/users");
const { createConversation } = await import("../db/queries/conversations");
const { setAlwaysExpose, clearAlwaysExpose } = await import("../runtime/preview/preview-consent");
let target: ReturnType<typeof sandboxWorkspaceTarget>;
let resolveCurrent = () => target;
mock.module("../runtime/workspaces/project-target", () => ({ ...originalTargets,
  resolveProjectWorkspaceTarget: async () => resolveCurrent(),
}));
const { resolveProviderProjectBuiltinTools } = await import("../runtime/stream-chat/provider-project-tools");

let root: string;
let workspace: string;
let state: string;
let userId: string;
let conversationId: string;
let binding: SandboxWorkspaceBinding;
let port: number;
const processes: Array<{ processId: string; bootId: string }> = [];
const calls: Array<Parameters<ProviderSandboxWorkspaceCaller["call"]>[0]> = [];
let afterCall: ((input: Parameters<ProviderSandboxWorkspaceCaller["call"]>[0], result: Record<string, unknown>) => void) | undefined;
const user = (await Bun.$`id -un`.text()).trim();
const helper = new URL("../infrastructure/incus-guest/helper.py", import.meta.url).pathname;
const guest: ProviderSandboxWorkspaceCaller = {
  async call(input) {
    expect(input.binding).toEqual(binding);
    expect(input.principal?.userId).toBe(userId);
    expect(input.signal?.aborted).not.toBe(true);
    calls.push(input);
    const request = { version: "0.1.0", action: input.action, sandboxId: binding.workspaceId, ...input.payload, user,
      requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
    const code = "import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('guest',sys.argv[1]); h=importlib.util.module_from_spec(s); s.loader.exec_module(h)\nprint(json.dumps(h.handle(json.loads(sys.stdin.read()),sys.argv[2],sys.argv[3])))";
    const child = Bun.spawn(["python3", "-B", "-c", code, helper, workspace, state], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, PATH: `${join(process.execPath, "..")}:/home/dev/.bun/bin:${process.env.PATH}` },
    });
    child.stdin.write(JSON.stringify(request)); child.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    const result = JSON.parse(stdout) as Record<string, unknown>;
    if (input.action === "process.start" && typeof result.processId === "string" && typeof result.bootId === "string") {
      processes.push({ processId: result.processId, bootId: result.bootId });
    }
    afterCall?.(input, result);
    return result;
  },
};

beforeAll(async () => {
  await setupTestDb();
  root = await mkdtemp(join(tmpdir(), "ez-provider-preview-"));
  workspace = join(root, "workspace"); state = join(root, "state");
  await mkdir(workspace); await mkdir(state);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { dev: "python3 server.py" } }));
  await writeFile(join(workspace, "server.py"), `import http.server,os\nassert os.environ.get('PREVIEW_MARKER')=='preserved prefix'\nhttp.server.HTTPServer(('127.0.0.1',${port}),http.server.SimpleHTTPRequestHandler).serve_forever()\n`);
  await writeFile(join(workspace, "index.html"), "guest preview marker");
  const owner = await createUser({ email: "provider-preview@test.com", passwordHash: "h", name: "Owner" });
  userId = owner.id;
  const project = await projects.createProject({ name: "Provider preview", path: "/host/canary-must-not-run" });
  conversationId = (await createConversation(project.id, { userId })).id;
  binding = { projectId: project.id, workspaceId: "preview-guest", connectionId: "connection-1", providerId: "incus",
    generation: 8, presetId: "compose", releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64), effectiveSettingsDigest: "c".repeat(64) };
  target = sandboxWorkspaceTarget(binding, { ...createProviderSandboxWorkspaceBackend(guest), previews: new IncusSandboxPreviewBackend(guest) });
}, 30_000);

afterEach(async () => {
  afterCall = undefined;
  resolveCurrent = () => target;
  for (const process of processes.splice(0)) {
    await guest.call({ binding, principal: { userId }, toolCallId: "fixture-cleanup", action: "process.cancel", payload: process });
    let terminal = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await guest.call({ binding, principal: { userId }, toolCallId: "fixture-inspect", action: "process.inspect", payload: process }) as { process: { state: string } };
      if (!["starting", "running"].includes(result.process.state)) { terminal = true; break; }
      await Bun.sleep(100);
    }
    expect(terminal).toBe(true);
  }
  await expect(fetch(`http://127.0.0.1:${port}/index.html`)).rejects.toThrow();
  _resetPreviewBusForTests();
  await clearAlwaysExpose(conversationId);
});

afterAll(async () => {
  mock.module("../runtime/workspaces/project-target", () => originalTargets);
  await closeTestDb();
  if (root) await rm(root, { recursive: true, force: true });
});

const command = "PREVIEW_MARKER='preserved prefix' bun run dev";
async function shellFor(principal = { userId, conversationId }) {
  const tools = await resolveProviderProjectBuiltinTools(binding.projectId, target, undefined, principal);
  return tools.find(tool => tool.name === "shell")!;
}

test("native provider dev server survives its shell turn and emits requester consent from the guest listener", async () => {
  const bus = new EventBus<AgentEvents>();
  registerPreviewBus(bus);
  const events: AgentEvents["tool:complete"][] = [];
  bus.on("tool:complete", event => events.push(event));
  const frames: Array<{ type: string; data: unknown }> = [];
  for (const type of ["tool:start", "tool:complete"] as const) bus.on(type, data => frames.push({ type, data }));
  const shell = await shellFor();
  const result = await shell.execute("native-dev", { command, timeout: 800 });
  expect(result.details).toMatchObject({ exitCode: 0, preview: { launched: true } });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ conversationId, cardType: "ez-preview-consent" });
  expect(events[0]!.output).toMatchObject({ conversationId, port });
  expect(calls.every(call => call.binding.projectId === binding.projectId)).toBe(true);
  expect(JSON.stringify(calls)).not.toContain("/host/canary-must-not-run");
  expect((await fetch(`http://127.0.0.1:${port}/index.html`)).status).toBe(200);
  expect(await (await fetch(`http://127.0.0.1:${port}/index.html`)).text()).toBe("guest preview marker");
  const launch = calls.find(call => call.action === "process.start" && JSON.stringify(call.payload).includes("EZH_PREVIEW_ARGV"))!;
  expect(launch.payload).toMatchObject({ processDeadlineMs: expect.any(Number) });
  expect(JSON.stringify(launch.payload)).toContain(command);
  const artifact = process.env.EZCORP_PREVIEW_TEST_ARTIFACT;
  if (artifact) await writeFile(artifact, JSON.stringify({ projectId: binding.projectId, conversationId, userId, port, events: frames }));
}, 15_000);

test("missing stream bus cancels the exact guest server instead of claiming a consent card exists", async () => {
  _resetPreviewBusForTests();
  const result = await (await shellFor()).execute("no-bus", { command });
  expect((result.details as { isError?: boolean }).isError).toBe(true);
  expect(calls.some(call => call.action === "process.cancel")).toBe(true);
  await expect(fetch(`http://127.0.0.1:${port}/index.html`)).rejects.toThrow();
}, 15_000);

test("owner, conversation, and changed generation deny launch before any guest process", async () => {
  const before = calls.length;
  for (const principal of [{ userId: "wrong-owner", conversationId }, { userId, conversationId: "missing-conversation" }]) {
    expect((await (await shellFor(principal)).execute("wrong-owner", { command })).details).toMatchObject({ isError: true });
  }
  resolveCurrent = () => sandboxWorkspaceTarget({ ...binding, generation: 9 }, target.backend);
  expect((await (await shellFor()).execute("stale-binding", { command })).details).toMatchObject({ isError: true });
  expect(calls.length).toBe(before);
});

test("cancellation after guest launch stops the owned process without emitting consent", async () => {
  const bus = new EventBus<AgentEvents>(); registerPreviewBus(bus);
  const complete: unknown[] = []; bus.on("tool:complete", event => complete.push(event));
  const abort = new AbortController();
  afterCall = input => { if (input.action === "process.start") { afterCall = undefined; abort.abort(); } };
  expect((await (await shellFor()).execute("abort-launch", { command }, abort.signal)).details).toMatchObject({ isError: true });
  expect(complete).toHaveLength(0);
  expect(calls.at(-1)?.action).toBe("process.inspect");
}, 15_000);

test("a consent decision rejection cancels the guest process and emits no card", async () => {
  const bus = new EventBus<AgentEvents>(); registerPreviewBus(bus);
  const complete: unknown[] = []; bus.on("tool:complete", event => complete.push(event));
  await setAlwaysExpose(conversationId, userId);
  let resolutions = 0;
  resolveCurrent = () => { if (++resolutions === 4) throw new Error("fixture decision denial"); return target; };
  expect((await (await shellFor()).execute("decision-denied", { command })).details).toMatchObject({ isError: true });
  expect(complete).toHaveLength(0);
  await expect(fetch(`http://127.0.0.1:${port}/index.html`)).rejects.toThrow();
}, 15_000);

test("an unrelated listening process cannot select the preview destination", async () => {
  const unrelated = createServer();
  await new Promise<void>(resolve => unrelated.listen(0, "127.0.0.1", resolve));
  try {
    registerPreviewBus(new EventBus<AgentEvents>());
    const result = await (await shellFor()).execute("owned-listener", { command });
    expect(result.details).toMatchObject({ exitCode: 0, preview: { port } });
    expect(port).not.toBe((unrelated.address() as { port: number }).port);
  } finally { await new Promise<void>((resolve, reject) => unrelated.close(error => error ? reject(error) : resolve())); }
}, 15_000);

test("binding drift during launch cancels the exact server before consent delivery", async () => {
  const bus = new EventBus<AgentEvents>(); registerPreviewBus(bus);
  const complete: unknown[] = []; bus.on("tool:complete", event => complete.push(event));
  let resolutions = 0;
  resolveCurrent = () => ++resolutions === 3 ? sandboxWorkspaceTarget({ ...binding, presetDigest: "d".repeat(64) }, target.backend) : target;
  expect((await (await shellFor()).execute("binding-drift", { command })).details).toMatchObject({ isError: true });
  expect(complete).toHaveLength(0);
  await expect(fetch(`http://127.0.0.1:${port}/index.html`)).rejects.toThrow();
}, 15_000);

test("missing host for an auto-exposed decision cancels the server instead of emitting an unusable card", async () => {
  const saved = process.env.EZCORP_PREVIEW_APP_HOST;
  delete process.env.EZCORP_PREVIEW_APP_HOST;
  try {
    const bus = new EventBus<AgentEvents>(); registerPreviewBus(bus);
    const complete: unknown[] = []; bus.on("tool:complete", event => complete.push(event));
    await setAlwaysExpose(conversationId, userId);
    expect((await (await shellFor()).execute("missing-host", { command })).details).toMatchObject({ isError: true });
    expect(complete).toHaveLength(0);
    await expect(fetch(`http://127.0.0.1:${port}/index.html`)).rejects.toThrow();
  } finally { if (saved === undefined) delete process.env.EZCORP_PREVIEW_APP_HOST; else process.env.EZCORP_PREVIEW_APP_HOST = saved; }
}, 15_000);

test("an uncertain guest launch has no fallback, replay, or retry suggestion", async () => {
  const callsBefore = calls.length;
  const unknown = { ...target, backend: { ...target.backend!, previews: { ...target.backend!.previews!,
    startServer: async () => { throw new Error("private unknown effect"); }, stopServer: async () => {} } } };
  const tools = await resolveProviderProjectBuiltinTools(binding.projectId, unknown, undefined, { userId, conversationId });
  const result = await tools.find(tool => tool.name === "shell")!.execute("unknown-launch", { command });
  expect(result.details).toMatchObject({ isError: true });
  expect(JSON.stringify(result)).toContain("Do not repeat the launch");
  expect(JSON.stringify(result)).not.toContain("private unknown effect");
  expect(calls.length).toBe(callsBefore);
});

test("multiple real listeners owned by the launched process refuse consent and are all stopped", async () => {
  const argv = ["python3", "-c", "import socket,time; a=socket.socket(); b=socket.socket(); a.bind(('127.0.0.1',0)); b.bind(('127.0.0.1',0)); a.listen(); b.listen(); time.sleep(60)"];
  await expect(target.backend!.previews!.startServer!({ binding, userId, conversationId, argv })).rejects.toThrow("ambiguous");
  const server = processes[0]!;
  const result = await guest.call({ binding, principal: { userId }, toolCallId: "confirm-ambiguous-cleanup", action: "process.inspect", payload: server }) as { process: { state: string } };
  expect(["cancelled", "failed", "succeeded", "timed_out"]).toContain(result.process.state);
}, 15_000);
