import { expect, spyOn, test } from "bun:test";
import { createProviderSandboxWorkspaceBackend, type ProviderSandboxWorkspaceCaller } from "../runtime/workspaces/provider-backend";
import { sandboxWorkspaceTarget, type SandboxPreviewConnectRequest, type SandboxPreviewServeRequest, type SandboxWorkspaceBinding } from "../runtime/workspaces/target";
import { IncusSandboxPreviewBackend } from "./incus-preview-backend";
import { hostPython3 } from "../__tests__/helpers/python-runtime";

const binding: SandboxWorkspaceBinding = {
  projectId: "project-a", workspaceId: "binding-a", connectionId: "connection-a", providerId: "incus",
  generation: 2, presetId: "compose", releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64),
  effectiveSettingsDigest: "c".repeat(64),
};
const expiresAt = new Date(Date.now() + 60_000);

function preview(request: Request, targetPort = 3000): SandboxPreviewServeRequest {
  return { binding, previewId: "preview-a", userId: "user-a", targetPort, requestPath: new URL(request.url).pathname,
    request, expiresAt };
}

function socketRequest(over: Partial<SandboxPreviewConnectRequest> = {}): SandboxPreviewConnectRequest {
  return { binding, previewId: "preview-a", userId: "user-a", targetPort: 3000, requestPath: "/hmr",
    search: "?token=x", expiresAt, signal: new AbortController().signal, subprotocol: "vite-hmr", ...over };
}

test("sandbox WebSocket stays closed without a qualified duplex factory", async () => {
  const backend = new IncusSandboxPreviewBackend({ call: async () => ({}) });
  await expect(backend.connectWebSocket(socketRequest())).rejects.toThrow("unavailable");
});

test("sandbox WebSocket passes only a bounded registered request to guest duplex", async () => {
  const calls: SandboxPreviewConnectRequest[] = [];
  const socket = { protocol: "vite-hmr", send: async () => {}, messages: (async function* () {})(), close: async () => {} };
  const backend = new IncusSandboxPreviewBackend({ call: async () => ({}) }, Date.now,
    async request => { calls.push(request); return socket; });
  expect(await backend.connectWebSocket(socketRequest())).toBe(socket);
  expect(calls).toEqual([expect.objectContaining({ binding, previewId: "preview-a", userId: "user-a",
    targetPort: 3000, requestPath: "/hmr", search: "?token=x", subprotocol: "vite-hmr" })]);
  await expect(backend.connectWebSocket(socketRequest({ targetPort: 80 }))).rejects.toThrow("port");
  await expect(backend.connectWebSocket(socketRequest({ requestPath: "//evil.example" }))).rejects.toThrow("path");
  await expect(backend.connectWebSocket(socketRequest({ expiresAt: new Date(0) }))).rejects.toThrow("expiry");
  await expect(backend.connectWebSocket(socketRequest({ subprotocol: "evil" as "vite-hmr" }))).rejects.toThrow("protocol");
  expect(calls).toHaveLength(1);
});

test("sandbox WebSocket refuses a changed guest-selected protocol and closes its stream", async () => {
  let closes = 0;
  const backend = new IncusSandboxPreviewBackend({ call: async () => ({}) }, Date.now,
    async () => ({ protocol: null, send: async () => {}, messages: (async function* () {})(),
      close: async () => { closes++; } }));
  await expect(backend.connectWebSocket(socketRequest())).rejects.toThrow("protocol changed");
  expect(closes).toBe(1);
});

test("sandbox preview open accepts only a current bounded endpoint", async () => {
  let calls = 0;
  const now = 1_000_000;
  const backend = new IncusSandboxPreviewBackend({ call: async () => { calls++; return {}; } }, () => now);
  const valid = { binding, previewId: "preview-a", userId: "user-a", conversationId: "conversation-a",
    targetPort: 3000, expiresAt: new Date(now + 60_000) };
  await backend.open(valid);
  await expect(backend.open({ ...valid, targetPort: 80 })).rejects.toThrow("port");
  await expect(backend.open({ ...valid, expiresAt: new Date(now) })).rejects.toThrow("expiry");
  await expect(backend.open({ ...valid, expiresAt: new Date(now + 24 * 60 * 60 * 1000 + 1) }))
    .rejects.toThrow("expiry");
  expect(calls).toBe(0);
});

test("sandbox preview uses only the approved guest process and a pinned loopback port", async () => {
  const body = Buffer.from(JSON.stringify({ status: 200, headers: [["content-type", "text/plain"], ["set-cookie", "site=ok; Domain=app.example"]],
    body: Buffer.from("guest page").toString("base64") }));
  const calls: Array<Parameters<ProviderSandboxWorkspaceCaller["call"]>[0]> = [];
  const caller: ProviderSandboxWorkspaceCaller = { call: async input => {
    calls.push(input);
    if (input.action === "process.start") return { ok: true, processId: "process-a", bootId: "boot-a" };
    if (input.action === "process.inspect") return { ok: true, process: { state: "succeeded" } };
    if (input.action === "process.readOutput") return { ok: true, chunks: [{ stream: "stdout", dataBase64: body.toString("base64") }], eof: true };
    throw new Error("Unexpected guest action");
  } };
  const backend = new IncusSandboxPreviewBackend(caller);
  const request = new Request("https://preview.example/page?x=1", { headers: {
    Accept: "text/html", Cookie: "app-session=secret", Authorization: "Bearer secret", "X-Forwarded-Host": "attacker.example",
  } });
  const response = await backend.serve(preview(request));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("guest page");
  expect(calls.map(call => call.action)).toEqual(["process.start", "process.inspect", "process.readOutput"]);
  expect(calls.every(call => call.binding === binding)).toBe(true);
  const start = calls[0]!.payload;
  expect(start.argv).toBeArray();
  expect((start.argv as string[])[2]).toContain('HTTPConnection("127.0.0.1"');
  const encoded = (start.env as Array<{ value: string }>)[0]!.value;
  const sent = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  expect(sent).toMatchObject({ port: 3000, method: "GET", path: "/page?x=1", headers: [["accept", "text/html"]] });
  expect(JSON.stringify(sent)).not.toContain("secret");
  expect(JSON.stringify(sent)).not.toContain("attacker.example");
});

test("sandbox preview refuses unsafe ports, methods, expiry, and oversized bodies before guest effects", async () => {
  let calls = 0;
  const backend = new IncusSandboxPreviewBackend({ call: async () => { calls++; return {}; } });
  await expect(backend.serve(preview(new Request("https://preview.example/"), 844))).rejects.toThrow("port");
  await expect(backend.serve(preview(new Request("https://preview.example/", { method: "OPTIONS" })))).rejects.toThrow("unavailable");
  await expect(backend.serve({ ...preview(new Request("https://preview.example/")), expiresAt: new Date(0) })).rejects.toThrow("unavailable");
  await expect(backend.serve(preview(new Request("https://preview.example/", { method: "POST", body: "x".repeat(4097) })))).rejects.toThrow("too large");
  expect(calls).toBe(0);
});

test("sandbox preview rejects truncated guest output and never returns it as a browser response", async () => {
  const backend = new IncusSandboxPreviewBackend({ call: async input => {
    if (input.action === "process.start") return { ok: true, processId: "process-a", bootId: "boot-a" };
    if (input.action === "process.inspect") return { ok: true, process: { state: "succeeded" } };
    return { ok: true, chunks: [], eof: true, gap: { reason: "overflow" } };
  } });
  await expect(backend.serve(preview(new Request("https://preview.example/")))).rejects.toThrow("incomplete");
});

test("fixed guest script makes one real loopback request and does not follow a redirect", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    requests++;
    return new Response("go", { status: 302, headers: { Location: "https://outside.example/" } });
  } });
  try {
    let output = "";
    const caller: ProviderSandboxWorkspaceCaller = { call: async input => {
      if (input.action === "process.start") {
        const argv = input.payload.argv as string[];
        const env = input.payload.env as Array<{ name: string; value: string }>;
        const child = Bun.spawn(argv, { env: { ...process.env, [env[0]!.name]: env[0]!.value }, stdout: "pipe", stderr: "pipe" });
        output = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        return { ok: true, processId: "process-a", bootId: "boot-a" };
      }
      if (input.action === "process.inspect") return { ok: true, process: { state: "succeeded" } };
      return { ok: true, chunks: [{ stream: "stdout", dataBase64: Buffer.from(output).toString("base64") }], eof: true };
    } };
    const response = await new IncusSandboxPreviewBackend(caller).serve(preview(new Request("https://preview.example/"), server.port));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://outside.example/");
    expect(requests).toBe(1);
  } finally { server.stop(true); }
});

function serverHarness(options: { identity?: string; identityEof?: boolean; ports?: unknown; gap?: boolean;
  emptyIdentity?: boolean; failedProbe?: boolean; cancelDenied?: boolean; cancellationNeverSettles?: boolean; lateIdentity?: boolean } = {}) {
  const calls: Array<Parameters<ProviderSandboxWorkspaceCaller["call"]>[0]> = [];
  let sequence = 0;
  let identityReads = 0;
  const caller: ProviderSandboxWorkspaceCaller = { call: async input => {
    calls.push(input);
    expect(input.binding).toBe(binding);
    expect(input.principal).toEqual({ userId: "user-a" });
    if (input.action === "process.start") return { ok: true, processId: ++sequence === 1 ? "server" : `probe-${sequence}`, bootId: "boot-a" };
    if (input.action === "process.cancel") return { ok: !options.cancelDenied };
    if (input.action === "process.inspect") return { ok: true, process: { state: options.cancellationNeverSettles ? "running" : options.failedProbe ? "failed" : "succeeded" } };
    const identity = options.identity ?? "EZH_PREVIEW_PROCESS 1234 5678\n";
    const output = input.payload.processId === "server" ? options.emptyIdentity || (options.lateIdentity && identityReads++ === 0) ? "" : identity : JSON.stringify(options.ports ?? [5173]);
    return { ok: true, gap: options.gap, eof: input.payload.processId !== "server" || options.identityEof,
      chunks: [{ stream: "stdout", dataBase64: Buffer.from(output).toString("base64") }] };
  } };
  return { calls, backend: new IncusSandboxPreviewBackend(caller, () => 1000), request: {
    binding, userId: "user-a", conversationId: "conversation-a", argv: ["/bin/sh", "-c", "PORT=5173 bun run dev"],
  } };
}

test("durable preview launch preserves guest argv, pins kernel listener identity, and independently reaps its probe and server", async () => {
  const { backend, calls, request } = serverHarness({ lateIdentity: true });
  const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
  try {
    const server = await backend.startServer(request);
    expect(server).toEqual({ processId: "server", bootId: "boot-a", port: 5173, expiresAt: 901000 });
    expect(calls[0]!.payload).toMatchObject({ processDeadlineMs: 901000, env: [{ name: "EZH_PREVIEW_ARGV", value: JSON.stringify(request.argv) }] });
    const probe = calls.find(call => call.action === "process.start" && call.payload.processDeadlineMs === 6000)!;
    expect(probe.payload).toMatchObject({ env: [{ name: "EZH_PREVIEW_PROCESS", value: "[1234,\"5678\"]" }] });
    expect(String((probe.payload.argv as string[])[2])).toContain("os.getpgid");
    await backend.stopServer({ ...request, signal: AbortSignal.abort(), server });
    const cleanup = calls.filter(call => call.action === "process.cancel");
    expect(cleanup.map(call => call.payload.processId)).toEqual(["probe-2", "server"]);
    expect(cleanup.every(call => call.signal && !call.signal.aborted)).toBe(true);
  } finally { sleep.mockRestore(); }
});

test("preview launch rejects invalid requests before any guest dispatch", async () => {
  const { backend, request, calls } = serverHarness();
  for (const patch of [{ userId: "" }, { conversationId: "" }, { argv: [] }, { argv: ["x\0"] }, { argv: ["x".repeat(8193)] }, { argv: Array(129).fill("x") }, { signal: AbortSignal.abort() }]) {
    await expect(backend.startServer({ ...request, ...patch })).rejects.toThrow();
  }
  expect(calls).toHaveLength(0);
});

test("preview discovery refuses missing, malformed, ambiguous, unsafe, or incomplete listener evidence and cancels owned effects", async () => {
  const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
  try {
    for (const options of [{ identity: "http://unrelated:5173", identityEof: true }, { emptyIdentity: true }, { gap: true },
      { ports: [3000, 5173] }, { ports: [80] }, { ports: { port: 5173 } }, { ports: [] }, { failedProbe: true }]) {
      const { backend, request, calls } = serverHarness(options);
      await expect(backend.startServer(request)).rejects.toThrow();
      expect(calls.filter(call => call.action === "process.cancel").at(-1)?.payload.processId).toBe("server");
      expect(calls.at(-1)?.action).toBe("process.inspect");
    }
  } finally { sleep.mockRestore(); }
});

test("preview cancellation reports unconfirmed cleanup rather than claiming the process ended", async () => {
  const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
  try {
    for (const options of [{ cancelDenied: true }, { cancellationNeverSettles: true }]) {
      const { backend, request } = serverHarness(options);
      await expect(backend.stopServer({ ...request, server: { processId: "server", bootId: "boot-a", port: 5173, expiresAt: 901000 } })).rejects.toThrow("unconfirmed");
    }
  } finally { sleep.mockRestore(); }
});

const PUBLICATION_PAUSE = `import importlib.util,json,os,pwd,sys,time
spec=importlib.util.spec_from_file_location('helper',sys.argv[1])
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
original=h.update_state
def update(directory,values):
 if values.get('state') in ('succeeded','failed'):
  with open(sys.argv[4],'w') as stream: json.dump(values,stream)
  until=time.monotonic()+8
  while not os.path.exists(sys.argv[5]):
   if time.monotonic()>until: raise RuntimeError('Fixture publication deadline')
   time.sleep(.01)
 return original(directory,values)
h.update_state=update
request=json.load(sys.stdin);request['user']=pwd.getpwuid(os.geteuid()).pw_name
print(json.dumps(h.handle(request,sys.argv[2],sys.argv[3])))`;

test("preview HTTP waits for the real helper's terminal publication without repeating the guest request", async () => {
  const { mkdtemp, mkdir, rm, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { handlePreviewRequest } = await import("../runtime/preview/preview-proxy");
  const python3 = hostPython3();
  const root = await mkdtemp(join(tmpdir(), "ez-preview-publication-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const published = join(root, "pending.json");
  const release = join(root, "release");
  await mkdir(workspace); await mkdir(state);
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    requests++;
    return new Response("retained guest marker", { headers: { "Content-Type": "text/plain" } });
  } });
  const calls: Array<{ action: string; handle: Record<string, unknown>; observed?: string }> = [];
  let process: { processId: string; bootId: string } | undefined;
  let released: Promise<void> | undefined;
  let lastObserved: string | undefined;
  const caller: ProviderSandboxWorkspaceCaller = { async call(input) {
    const child = Bun.spawn([python3, "-B", "-c", PUBLICATION_PAUSE,
      new URL("./incus-guest/helper.py", import.meta.url).pathname, workspace, state, published, release],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify({ version: "0.1.0", action: input.action, sandboxId: binding.workspaceId,
      requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), ...input.payload }));
    child.stdin.end();
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, error).toBe(0);
    const result = JSON.parse(output);
    calls.push({ action: input.action, handle: input.payload, observed: result.process?.state });
    if (input.action === "process.start") process = { processId: result.processId, bootId: result.bootId };
    if (input.action === "process.inspect") {
      lastObserved = result.process.state;
      if (lastObserved === "unknown" && !released) {
        expect(JSON.parse(await readFile(published, "utf8"))).toMatchObject({ state: "succeeded", exitCode: 0 });
        released = writeFile(release, "release\n");
        await released;
      }
    }
    if (input.action === "process.readOutput") expect(lastObserved).toBe("succeeded");
    return result;
  } };
  try {
    const backend = new IncusSandboxPreviewBackend(caller);
    const target = sandboxWorkspaceTarget(binding, { ...createProviderSandboxWorkspaceBackend(caller), previews: backend });
    const previewId = "0".repeat(26);
    const response = await handlePreviewRequest({ previewId, requestPath: "/", cookieToken: "fixture-only",
      request: new Request(`http://${previewId}.preview.localhost/`) }, {
      verifyToken: async () => ({ previewId, userId: "user-a" }),
      getServable: async () => ({ id: previewId, userId: "user-a", kind: "dynamic", staticPath: null, targetPort: server.port ?? null,
        workspaceTarget: { kind: "sandbox", binding }, expiresAt: new Date(Date.now() + 60_000) }),
      readFile: async () => { throw new Error("No host fallback"); }, resolveWorkspaceTarget: async () => target,
    });
    const receipt = { status: response.status, body: await response.text(), calls, requests,
      terminalPending: JSON.parse(await readFile(published, "utf8")) };
    if (globalThis.process.env.EZH_PREVIEW_PUBLICATION_RECEIPT) await writeFile(globalThis.process.env.EZH_PREVIEW_PUBLICATION_RECEIPT,
      JSON.stringify(receipt, null, 2));
    expect(receipt.status).toBe(200);
    expect(receipt.body).toBe("retained guest marker");
    expect(calls.filter(call => call.action === "process.start")).toHaveLength(1);
    expect(requests).toBe(1);
    expect(calls.some(call => call.observed === "unknown")).toBe(true);
    expect(calls.some(call => call.observed === "succeeded")).toBe(true);
    expect(calls.filter(call => call.action === "process.inspect" || call.action === "process.readOutput")
      .every(call => call.handle.processId === process?.processId && call.handle.bootId === process?.bootId)).toBe(true);
  } finally {
    await writeFile(release, "release\n");
    await released;
    if (process) {
      await caller.call({ binding, principal: { userId: "user-a" }, toolCallId: "owned-cleanup",
        action: "process.cancel", payload: process });
      let ended = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await caller.call({ binding, principal: { userId: "user-a" }, toolCallId: "owned-inspect",
          action: "process.inspect", payload: process }) as { process: { state: string } };
        if (["succeeded", "failed", "cancelled", "timed_out"].includes(result.process.state)) { ended = true; break; }
        await Bun.sleep(100);
      }
      expect(ended).toBe(true);
    }
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("a permanently unknown preview handle stays bounded, cancels once and never reads output or starts again", async () => {
  const calls: Array<Parameters<ProviderSandboxWorkspaceCaller["call"]>[0]> = [];
  const backend = new IncusSandboxPreviewBackend({ async call(input) {
    calls.push(input);
    if (input.action === "process.start") return { ok: true, processId: "same-process", bootId: "same-boot" };
    if (input.action === "process.inspect") return { ok: true, process: { state: "unknown" } };
    if (input.action === "process.cancel") return { ok: true };
    throw new Error("Output cannot prove completion");
  } });
  const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
  try {
    await expect(backend.serve(preview(new Request("https://preview.example/")))).rejects.toThrow("deadline");
    expect(calls.filter(call => call.action === "process.start")).toHaveLength(1);
    expect(calls.filter(call => call.action === "process.inspect")).toHaveLength(24);
    expect(calls.filter(call => call.action === "process.cancel")).toHaveLength(1);
    expect(calls.some(call => call.action === "process.readOutput")).toBe(false);
    expect(calls.slice(1).every(call => call.payload.processId === "same-process" && call.payload.bootId === "same-boot")).toBe(true);
    expect(sleep.mock.calls.every(([delay]) => delay === 500)).toBe(true);
  } finally { sleep.mockRestore(); }
});

test("an unknown preview that becomes failed, timed-out or cancelled never exposes output", async () => {
  const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
  try {
  for (const state of ["failed", "timed_out", "cancelled"]) {
    const calls: string[] = [];
    let inspected = 0;
    const backend = new IncusSandboxPreviewBackend({ async call(input) {
      calls.push(input.action);
      if (input.action === "process.start") return { ok: true, processId: "same-process", bootId: "same-boot" };
      if (input.action === "process.inspect") return { ok: true, process: { state: inspected++ === 0 ? "unknown" : state } };
      throw new Error("No output from a refused process");
    } });
    await expect(backend.serve(preview(new Request("https://preview.example/")))).rejects.toThrow("failed");
    expect(calls).toEqual(["process.start", "process.inspect", "process.inspect"]);
  }
  } finally { sleep.mockRestore(); }
});

test("cancellation during unknown polling cancels the same handle without another start or output", async () => {
  const controller = new AbortController();
  const calls: Array<Parameters<ProviderSandboxWorkspaceCaller["call"]>[0]> = [];
  const backend = new IncusSandboxPreviewBackend({ async call(input) {
    calls.push(input);
    if (input.action === "process.start") return { ok: true, processId: "same-process", bootId: "same-boot" };
    if (input.action === "process.inspect") return { ok: true, process: { state: "unknown" } };
    if (input.action === "process.cancel") return { ok: true };
    throw new Error("Unexpected output");
  } });
  const sleep = spyOn(Bun, "sleep").mockImplementation(async () => { controller.abort(); });
  try {
    await expect(backend.serve(preview(new Request("https://preview.example/", { signal: controller.signal })))).rejects.toThrow("cancelled");
    expect(calls.map(call => call.action)).toEqual(["process.start", "process.inspect", "process.cancel"]);
    expect(calls[2]!.payload).toEqual({ processId: "same-process", bootId: "same-boot" });
    expect(calls[2]!.signal).toBeUndefined();
  } finally { sleep.mockRestore(); }
});

test("preview helper fixtures refuse a missing portable Python interpreter", () => {
  const which = spyOn(Bun, "which").mockReturnValue(null);
  try { expect(() => hostPython3()).toThrow("require python3 on PATH"); }
  finally { which.mockRestore(); }
});
