import { afterAll, expect, spyOn, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSandboxProviderMethodExchange, type JsonValue, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import type { AddressInfo } from "node:net";
import { createServer } from "node:tls";
import type { IncusTransportRequest } from "../../../extensions/incus-sandbox/transport";
import { guestHelperSha256, GUEST_HELPER_VERSION } from "../incus-guest/protocol";
import { HostIncusGuestTransport } from "./guest";
import { resourceName, type Session } from "./lifecycle";
import type { PinnedWebSocket } from "./pinned-websocket";
import { makeTestCertificates } from "./test-certificates";

const certificates = makeTestCertificates();
afterAll(() => certificates.dispose());
const cert = certificates.read("server-cert.pem");
const substituteCert = certificates.read("substitute-server-cert.pem");
const substituteKey = certificates.read("substitute-server-key.pem");
const clientCa = certificates.read("client-ca-cert.pem");
const clientCert = certificates.read("client-cert.pem");
const clientKey = certificates.read("client-key.pem");
const fingerprint = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
const sandboxId = "sandbox-a";
const sandboxName = resourceName("connection-a", sandboxId);
const scope = { providerInstallationId: "installation-a", providerReleaseId: "release-a", revision: 1,
  approvedPreset: { profile: "linux-exec.v1", incusProfile: "ezharness", presetId: "incus-linux-exec-v1", presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64), imageFingerprint: "c".repeat(64), limits: { memoryBytes: 4_294_967_296, cpuMillis: 2_000, pids: 1024, diskBytes: 21_474_836_480 } },
  approvedGuest: { user: "sandbox", uid: 1000, gid: 1000, helperSha256: guestHelperSha256() } };
const connection = { endpoint: "https://127.0.0.1:8443", project: "sandbox", serverCertificatePem: cert, clientCertificatePem: "client", privateKeyPem: "private" };
const command: IncusTransportRequest = { action: "helper.file.stat", connectionId: "connection-a", deadlineMs: Date.now() + 30_000,
  pins: { connectionId: "connection-a", serverCertificateSha256: fingerprint, project: "sandbox", profile: "ezharness", helperVersion: GUEST_HELPER_VERSION, guestUser: "sandbox" },
  tags: { managedBy: "ezharness-incus-sandbox", connectionId: "connection-a", sandboxId }, sandboxName,
  payload: { path: "src/app.ts", user: "root", sandboxId: "forged" } };
const opId = "11111111-1111-1111-1111-111111111111";
const token = "a".repeat(64);
const envelope = (metadata: unknown, status = 200) => Response.json({ type: status === 202 ? "async" : "sync", metadata, status_code: status }, { status });
const instance = { name: sandboxName, status: "Running", profiles: ["ezharness"], config: { "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": "connection-a", "user.ezharness.sandbox_id": sandboxId, "volatile.base_image": "c".repeat(64) } };
function execResponse() { return envelope({ id: opId, resources: { instances: [`/1.0/instances/${sandboxName}`] }, metadata: { fds: { "0": token, "1": token, "2": token, control: token } } }, 202); }
function fixture(output: unknown = { version: GUEST_HELPER_VERSION, ok: true, file: { path: "src/app.ts", kind: "file", revision: "rev", sizeBytes: 1, executable: false } }) {
  const routes: string[] = [];
  let requestBytes: Buffer | undefined;
  const http = async (url: string, init: RequestInit) => {
    routes.push(`${init.method} ${new URL(url).pathname}`);
    if (new URL(url).pathname.endsWith("/exec")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.command).toEqual(["/usr/local/libexec/ezharness-helper"]);
      expect(body.user).toBe(1000);
      expect(body["record-output"]).toBe(false);
      return execResponse();
    }
    if (new URL(url).pathname.endsWith("/wait")) return envelope({ id: opId, status: "Success", metadata: { return: 0 } });
    return envelope(instance);
  };
  let channel = 0;
  const websocket = async (_session: Session, id: string, secret: string): Promise<PinnedWebSocket> => {
    expect(id).toBe(opId);
    expect(secret).toBe(token);
    const index = channel++ % 4;
    return { send(data) { requestBytes = data; }, finish() {}, readAll: async () => index === 1 ? Buffer.from(JSON.stringify(output)) : Buffer.alloc(0), close() {} };
  };
  const transport = new HostIncusGuestTransport({ resolveForHost: async () => connection }, scope, http as never, websocket);
  return { transport, routes, request: () => requestBytes };
}

test("helper invocation fixes path, UID, guest user, and sandbox ID", async () => {
  const { transport, routes, request } = fixture();
  const result = await transport.request(command) as Record<string, unknown>;
  expect(result.ok).toBe(true);
  expect(routes).toEqual([`GET /1.0/instances/${sandboxName}`, `POST /1.0/instances/${sandboxName}/exec`, `GET /1.0/operations/${opId}/wait`]);
  expect(JSON.parse(request()!.toString())).toMatchObject({ action: "file.stat", user: "sandbox", sandboxId });
});

async function pinnedGuestFixture(execute: (request: Buffer) => Promise<Buffer>, guest = scope.approvedGuest) {
  const secrets = { "0": "a".repeat(64), "1": "b".repeat(64), "2": "c".repeat(64), control: "d".repeat(64) };
  const routes: string[] = [];
  const channels = new Map<string, import("node:net").Socket>();
  const sockets = new Set<import("node:net").Socket>();
  let requestBytes: Buffer | undefined;
  const server = createServer({ cert: substituteCert, key: substituteKey, ca: clientCa,
    requestCert: true, rejectUnauthorized: true }, socket => {
    sockets.add(socket);
    let headerBytes = Buffer.alloc(0);
    const readHeader = (chunk: Buffer) => {
      headerBytes = Buffer.concat([headerBytes, chunk]);
      const end = headerBytes.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", readHeader);
      const header = headerBytes.toString("latin1", 0, end);
      const [method, path] = header.split("\r\n", 1)[0]!.split(" ");
      if (!method || !path) { socket.destroy(); return; }
      if (/^Upgrade: websocket$/im.test(header)) upgrade(path, header, socket);
      else respond(method, path, socket);
    };
    socket.on("data", readHeader);
  });
  const respond = (method: string, pathWithQuery: string, socket: import("node:tls").TLSSocket) => {
    const path = new URL(pathWithQuery, "https://127.0.0.1").pathname;
    routes.push(`${method} ${path}`);
    const metadata = path === `/1.0/instances/${sandboxName}` ? instance
      : path.endsWith("/exec") ? { id: opId, resources: { instances: [`/1.0/instances/${sandboxName}`] }, metadata: { fds: secrets } }
        : { id: opId, status: "Success", metadata: { return: 0 } };
    const status = path.endsWith("/exec") ? 202 : 200;
    const body = JSON.stringify({ type: status === 202 ? "async" : "sync", status_code: status, metadata });
    socket.end(`HTTP/1.1 ${status} ${status === 202 ? "Accepted" : "OK"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  };
  const upgrade = (path: string, header: string, socket: import("node:tls").TLSSocket) => {
    const url = new URL(path, "https://127.0.0.1");
    const channel = Object.entries(secrets).find(([, value]) => value === url.searchParams.get("secret"))?.[0];
    const key = /^Sec-WebSocket-Key: (\S+)$/im.exec(header)?.[1];
    if (!channel || !key) { socket.destroy(); return; }
    channels.set(channel, socket);
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (channel !== "0") return;
    let wire = Buffer.alloc(0);
    socket.on("data", chunk => {
      wire = Buffer.concat([wire, Buffer.from(chunk)]);
      for (;;) {
        if (wire.length < 6) return;
        const lengthCode = wire[1]! & 127;
        const header = lengthCode === 126 ? 4 : 2;
        if (lengthCode === 127 || wire.length < header + 4) return;
        const length = lengthCode === 126 ? wire.readUInt16BE(2) : lengthCode;
        if (wire.length < header + 4 + length) return;
        const opcode = wire[0]! & 15;
        const mask = wire.subarray(header, header + 4);
        const payload = Buffer.from(wire.subarray(header + 4, header + 4 + length).map((byte, index) => byte ^ mask[index % 4]!));
        wire = wire.subarray(header + 4 + length);
        if (opcode === 2) requestBytes = payload;
        if (opcode === 1 && length === 0) {
          const stdout = channels.get("1");
          const stderr = channels.get("2");
          if (!stdout || !stderr) throw new Error("Incus output channels are missing");
          void execute(requestBytes!).then(output => {
            const binaryHeader = output.length < 126 ? Buffer.from([0x82, output.length]) : Buffer.from([0x82, 126, output.length >> 8, output.length & 255]);
            stdout.write(Buffer.concat([binaryHeader, output, Buffer.from([0x81, 0x00])]));
            stderr.write(Buffer.from([0x81, 0x00]));
          }, () => { stdout.destroy(); stderr.destroy(); });
        }
      }
    });
  };
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport = new HostIncusGuestTransport({ resolveForHost: async () => ({ endpoint, project: "sandbox",
    serverCertificatePem: substituteCert, clientCertificatePem: clientCert, privateKeyPem: clientKey }) },
  { ...scope, approvedGuest: guest });
  const scopedCommand = { ...command, deadlineMs: Date.now() + 30_000,
    pins: { ...command.pins, guestUser: guest.user,
      serverCertificateSha256: createHash("sha256").update(new X509Certificate(substituteCert).raw).digest("hex") } };
  return { transport, command: scopedCommand, routes, channels, request: () => requestBytes,
    dispose: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}

test("file.stat crosses real pinned HTTP and four Incus WebSocket streams", async () => {
  const fixture = await pinnedGuestFixture(async () => Buffer.from(JSON.stringify({ version: GUEST_HELPER_VERSION, ok: true,
    file: { path: "src/app.ts", kind: "file", revision: "rev", sizeBytes: 1, executable: false } })));
  try {
    expect(await fixture.transport.request(fixture.command)).toMatchObject({ ok: true, file: { path: "src/app.ts", revision: "rev" } });
    expect(fixture.routes).toEqual([`GET /1.0/instances/${sandboxName}`, `POST /1.0/instances/${sandboxName}/exec`, `GET /1.0/operations/${opId}/wait`]);
    expect([...fixture.channels.keys()].sort()).toEqual(["0", "1", "2", "control"]);
    expect(JSON.parse(fixture.request()!.toString())).toMatchObject({ action: "file.stat", sandboxId });
  } finally { await fixture.dispose(); }
}, 30_000);

test("process identity and output cross pinned TLS/WebSockets and the real guest helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "ezh-transport-helper-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  await mkdir(workspace);
  await mkdir(state);
  const user = (await Bun.$`id -un`.text()).trim();
  const guest = { ...scope.approvedGuest, user, uid: process.getuid!(), gid: process.getgid!() };
  const helper = new URL("../incus-guest/helper.py", import.meta.url).pathname;
  const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('helper',sys.argv[1])
h=importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
print(json.dumps(h.handle(json.load(sys.stdin),sys.argv[2],sys.argv[3])))`;
  const fixture = await pinnedGuestFixture(async request => {
    const child = Bun.spawn(["python3", "-c", script, helper, workspace, state], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(request);
    child.stdin.end();
    const [output, errors, exit] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    expect(exit, errors).toBe(0);
    return Buffer.from(output);
  }, guest);
  const call = async (operation: SandboxProtocolOperation, payload: Record<string, JsonValue>) => {
    const rpcDeadlineMs = Math.min(Date.now() + 30_000, Number(payload.processDeadlineMs ?? Number.MAX_SAFE_INTEGER));
    const input = { providerId: "incus", connectionId: command.connectionId, sandboxId, rpcDeadlineMs, ...payload };
    const result = await fixture.transport.request({ ...fixture.command, deadlineMs: rpcDeadlineMs,
      action: `helper.${operation.replace("processes.", "process.")}` as IncusTransportRequest["action"], payload,
      ...(operation === "processes.start" ? { idempotency: { requestId: "process-proof", key: "process-proof" } } : {}) });
    return validateSandboxProviderMethodExchange(operation, input, result).result as Record<string, any>;
  };
  try {
    const processDeadlineMs = Date.now() + 30_000;
    const startClock = spyOn(Date, "now").mockReturnValue(processDeadlineMs - 29_999);
    let started: Record<string, any>;
    try {
      started = await call("processes.start", { argv: ["sh", "-c", "printf guest-stdout; printf guest-stderr >&2"],
        cwd: ".", user, env: [], processDeadlineMs, requestId: "process-proof", idempotencyKey: "process-proof" });
    } finally { startClock.mockRestore(); }
    expect(started.ok).toBe(true);
    expect(started.processId).toMatch(/^[a-f0-9]{32}$/);
    expect(started.bootId).toMatch(/^[a-f0-9-]{36}$/);
    const identity = { processId: started.processId, bootId: started.bootId };
    let inspected: Record<string, any> | undefined;
    while (Date.now() < processDeadlineMs) {
      inspected = await call("processes.inspect", identity);
      if (inspected.process.state === "succeeded") break;
      await Bun.sleep(40);
    }
    expect(inspected?.process).toMatchObject({ ...identity, sandboxId, state: "succeeded", exitCode: 0 });
    const output = await call("processes.readOutput", { ...identity,
      cursor: { ...identity, sandboxId, offsetBytes: 0 }, maxBytes: 65536 });
    expect(output.eof).toBe(true);
    expect(output.nextCursor).toEqual({ ...identity, sandboxId, offsetBytes: 24 });
    for (const [stream, expected] of [["stdout", "guest-stdout"], ["stderr", "guest-stderr"]]) {
      expect(output.chunks.filter((chunk: Record<string, unknown>) => chunk.stream === stream)
        .map((chunk: Record<string, unknown>) => Buffer.from(String(chunk.dataBase64), "base64").toString()).join("")).toBe(expected);
    }
    expect([...fixture.channels.keys()].sort()).toEqual(["0", "1", "2", "control"]);
  } finally {
    await fixture.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("missing helper approval, wrong version, and forged sandbox name fail before HTTP", async () => {
  for (const changed of [
    { scope: { ...scope, approvedGuest: undefined }, command },
    { scope, command: { ...command, pins: { ...command.pins, helperVersion: "changed" } } },
    { scope, command: { ...command, sandboxName: "forged" } },
  ]) {
    let calls = 0;
    const transport = new HostIncusGuestTransport({ resolveForHost: async () => connection }, changed.scope,
      (async () => { calls++; return envelope(instance); }) as never);
    await expect(transport.request(changed.command)).rejects.toMatchObject({ kind: "permission", effect: "none" });
    expect(calls).toBe(0);
  }
});

test("helper version mismatch and oversized response fail closed", async () => {
  for (const output of [{ version: "other", ok: true }, Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    const { transport } = fixture(output);
    await expect(transport.request(command)).rejects.toMatchObject({ kind: output instanceof Buffer ? "resource_exhausted" : "unsupported" });
  }
});

test("stopped or replaced image never executes helper", async () => {
  for (const value of [{ ...instance, status: "Stopped" }, { ...instance, config: { ...instance.config, "volatile.base_image": "d".repeat(64) } }]) {
    let requests = 0;
    const transport = new HostIncusGuestTransport({ resolveForHost: async () => connection }, scope,
      (async () => { requests++; return envelope(value); }) as never);
    await expect(transport.request(command)).rejects.toMatchObject({ kind: "permission" });
    expect(requests).toBe(1);
  }
});

test("missing helper executable fails closed after fixed exec", async () => {
  const http = async (url: string) => {
    const route = new URL(url).pathname;
    if (route.endsWith("/exec")) return execResponse();
    if (route.endsWith("/wait")) return envelope({ id: opId, status: "Failure", metadata: { return: 127 } });
    return envelope(instance);
  };
  const websocket = async (_session: Session, _id: string, _secret: string): Promise<PinnedWebSocket> => ({
    send() {}, finish() {}, readAll: async () => Buffer.alloc(0), close() {},
  });
  const transport = new HostIncusGuestTransport({ resolveForHost: async () => connection }, scope, http as never, websocket);
  await expect(transport.request(command)).rejects.toMatchObject({ kind: "unsupported" });
});

test("guest mutation timeout has stable unknown identity", async () => {
  let execCalls = 0;
  const http = async (url: string) => {
    if (new URL(url).pathname.endsWith("/exec")) { execCalls++; return new Promise<Response>(() => undefined); }
    return envelope(instance);
  };
  const transport = new HostIncusGuestTransport({ resolveForHost: async () => connection }, scope, http as never);
  const failure = await transport.request({ ...command, action: "helper.process.start", deadlineMs: Date.now() + 50,
    idempotency: { requestId: "request-a", key: "key-a" }, payload: { argv: ["bun", "test"], cwd: ".", env: [], processDeadlineMs: Date.now() + 1000 } })
    .catch((error: unknown) => error) as { kind: string; effect: string; operationId: string };
  expect(failure).toMatchObject({ kind: "deadline", effect: "unknown" });
  expect(failure.operationId).toMatch(/^ezh-guest-/);
  expect(execCalls).toBe(1);
}, 2_000);

test("file removal returns a scoped provider receipt", async () => {
  const { transport, request } = fixture({ version: GUEST_HELPER_VERSION, ok: true, removedRevision: "old-revision" });
  const result = await transport.request({ ...command, action: "helper.file.remove", idempotency: { requestId: "request-a", key: "key-a" },
    payload: { path: "src/app.ts", expectedRevision: "old-revision", recursive: false } }) as { receipt: Record<string, unknown> };
  expect(result.receipt).toMatchObject({ kind: "fileRemove", sandboxId, requestId: "request-a", idempotencyKey: "key-a" });
  expect(JSON.parse(request()!.toString())).toMatchObject({ requestId: "request-a", idempotencyKey: "key-a", sandboxId });
});

test("malformed process start response after exec acceptance remains unknown", async () => {
  const { transport } = fixture({ version: "wrong", ok: true, processId: "untrusted" });
  const failure = await transport.request({ ...command, action: "helper.process.start", idempotency: { requestId: "request-a", key: "key-a" },
    payload: { argv: ["bun", "test"], cwd: ".", env: [], processDeadlineMs: Date.now() + 60_000 } })
    .catch((error: unknown) => error) as { kind: string; effect: string; operationId: string };
  expect(failure).toMatchObject({ kind: "unsupported", effect: "unknown" });
  expect(failure.operationId).toMatch(/^ezh-guest-/);
});
