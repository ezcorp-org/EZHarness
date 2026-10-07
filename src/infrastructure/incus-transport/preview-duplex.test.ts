import { afterAll, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { createServer } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { guestHelperSha256, GUEST_HELPER_VERSION } from "../incus-guest/protocol";
import { MAX_PREVIEW_SESSION_MS, resourceName, withSession, type Session } from "./lifecycle";
import { makeTestCertificates } from "./test-certificates";
import { connectIncusPreviewDuplex, PREVIEW_GUEST_RELAY, type IncusPreviewAuthorization,
  type IncusPreviewDuplexRequest } from "./preview-duplex";
import { openPinnedWebSocket, type PinnedWebSocket } from "./pinned-websocket";
import { PREVIEW_PYTHON } from "../incus-host-live-witness";

const certificates = makeTestCertificates();
afterAll(() => certificates.dispose());
const cert = certificates.read("server-cert.pem");
const fingerprint = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
const binding = { projectId: "project-a", workspaceId: "sandbox-a", connectionId: "connection-a", providerId: "incus",
  generation: 1, presetId: "preset-a", releaseDigest: "d".repeat(64), presetDigest: "a".repeat(64), effectiveSettingsDigest: "b".repeat(64) };
const name = resourceName(binding.connectionId, binding.workspaceId);
const instance = { name, status: "Running", profiles: ["ezharness"], config: {
  "user.ezharness.managed_by": "ezharness-incus-sandbox", "user.ezharness.connection_id": binding.connectionId,
  "user.ezharness.sandbox_id": binding.workspaceId, "user.ezharness.generation": "1",
  "user.ezharness.profile": "persistent-web-compose.v1", "user.ezharness.preset_id": binding.presetId,
  "volatile.base_image": "c".repeat(64),
} };
const request = (): IncusPreviewDuplexRequest => ({ binding, previewId: "preview-a", userId: "user-a", targetPort: 4173,
  requestPath: "/socket", search: "?foo=bar", expiresAt: new Date(Date.now() + 60_000), signal: new AbortController().signal,
  subprotocol: "vite-hmr" });
const operationId = "11111111-1111-1111-1111-111111111111";
const tokens = { "0": "a".repeat(64), "1": "b".repeat(64), "2": "c".repeat(64), control: "d".repeat(64) };
const reply = (value: unknown, status = 200) => Response.json({ type: status === 202 ? "async" : "sync", metadata: value }, { status });

function hostPython3(): string {
  const python3 = Bun.which("python3");
  if (!python3) throw new Error("Preview relay tests require python3 on PATH");
  return python3;
}

class Channel implements PinnedWebSocket {
  chunks: (Buffer | null)[] = [];
  waiting: ((value: Buffer | null) => void) | null = null;
  closed = false;
  sent: Buffer[] = [];
  onSend?: (value: Buffer) => void;
  push(value: Buffer | null) { const waiter = this.waiting; if (waiter) { this.waiting = null; waiter(value); } else this.chunks.push(value); }
  send(value: Buffer) { this.sent.push(value); this.onSend?.(value); }
  async sendBounded(value: Buffer) { this.send(value); }
  finish() { this.push(null); }
  async readChunk(): Promise<Buffer | null> { if (this.chunks.length) return this.chunks.shift()!; return new Promise(resolve => { this.waiting = resolve; }); }
  async readAll(): Promise<Buffer> { return Buffer.alloc(0); }
  close() { this.closed = true; this.push(null); }
}

function serverFrame(opcode: number, body: Buffer, final = true): Buffer {
  if (body.length < 126) return Buffer.concat([Buffer.from([(final ? 0x80 : 0) | opcode, body.length]), body]);
  const head = Buffer.from([(final ? 0x80 : 0) | opcode, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
}

function decodeClientFrame(frame: Buffer): { opcode: number; body: Buffer } {
  const header = frame[1]! & 127;
  const length = header === 126 ? frame.readUInt16BE(2) : header === 127 ? Number(frame.readBigUInt64BE(2)) : header;
  const offset = header === 126 ? 4 : header === 127 ? 10 : 2;
  const mask = frame.subarray(offset, offset + 4);
  return { opcode: frame[0]! & 15,
    body: Buffer.from(frame.subarray(offset + 4, offset + 4 + length).map((value, index) => value ^ mask[index % 4]!)) };
}

function fixture(options: { generation?: string; sandboxId?: string; selectProtocol?: string | null; onRevalidate?: () => void;
  deadlineOffsetMs?: number; stallHandshake?: boolean; setupTimeoutMs?: number } = {}) {
  const channels = [new Channel(), new Channel(), new Channel(), new Channel()];
  const calls: string[] = [];
  let lastExec: Record<string, unknown> | undefined;
  let revalidations = 0;
  const http = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    if (path.endsWith("/exec")) {
      lastExec = JSON.parse(String(init.body)) as Record<string, unknown>;
      return reply({ id: operationId, resources: { instances: [`/1.0/instances/${name}`] }, metadata: { fds: tokens } }, 202);
    }
    return reply({ ...instance, config: { ...instance.config, "user.ezharness.generation": options.generation ?? "1",
      "user.ezharness.sandbox_id": options.sandboxId ?? binding.workspaceId } });
  };
  const websocket = async (_session: Session, id: string, token: string): Promise<PinnedWebSocket> => {
    expect(id).toBe(operationId);
    const index = Object.values(tokens).indexOf(token);
    expect(index).toBeGreaterThanOrEqual(0);
    _session.signal.addEventListener("abort", () => channels[index]!.close(), { once: true });
    return channels[index]!;
  };
  channels[0]!.onSend = buffer => {
    if (buffer.subarray(0, 4).toString() === "GET ") {
      if (options.stallHandshake) return;
      const header = buffer.toString("latin1");
      const key = /Sec-WebSocket-Key: (\S+)/.exec(header)?.[1];
      expect(key).toBeDefined();
      const accept = createHash("sha1").update(key! + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      channels[1]!.push(Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${options.selectProtocol === null ? "" : `Sec-WebSocket-Protocol: ${options.selectProtocol ?? "vite-hmr"}\r\n`}\r\n`));
    } else {
      const { opcode, body } = decodeClientFrame(buffer);
      if (opcode === 1 || opcode === 2) channels[1]!.push(serverFrame(opcode, body));
    }
  };
  const authority: IncusPreviewAuthorization = {
    authorizedBinding: binding, registeredPort: 4173,
    command: { action: "endpoint.open", connectionId: binding.connectionId, deadlineMs: Date.now() + (options.deadlineOffsetMs ?? 25_000),
      pins: { connectionId: binding.connectionId, serverCertificateSha256: fingerprint, project: "sandbox", profile: "ezharness",
        helperVersion: GUEST_HELPER_VERSION, guestUser: "sandbox" },
      tags: { managedBy: "ezharness-incus-sandbox", connectionId: binding.connectionId, sandboxId: binding.workspaceId },
      sandboxName: name, payload: {} },
    scope: { providerInstallationId: "installation-a", providerReleaseId: "release-a", revision: 1,
      approvedPreset: { profile: "persistent-web-compose.v1", incusProfile: "ezharness", presetId: binding.presetId,
        presetDigest: binding.presetDigest, effectiveSettingsDigest: binding.effectiveSettingsDigest,
        imageFingerprint: "c".repeat(64), limits: { memoryBytes: 4_294_967_296, cpuMillis: 2_000, pids: 1024, diskBytes: 21_474_836_480 } },
      approvedGuest: { user: "sandbox", uid: 1000, gid: 1000, helperSha256: guestHelperSha256() } },
    connections: { resolveForHost: async () => ({ endpoint: "https://127.0.0.1:8443", project: "sandbox",
      serverCertificatePem: cert, clientCertificatePem: "client", privateKeyPem: "private" }) },
    async revalidate() { revalidations++; options.onRevalidate?.(); },
  };
  const connect = (input = request()) => connectIncusPreviewDuplex(input, async () => authority,
    { http: http as never, websocket, setupTimeoutMs: options.setupTimeoutMs });
  return { connect, authority, channels, calls, http, lastExec: () => lastExec, revalidations: () => revalidations };
}

test("fixed preview exec carries sanitized HMR duplex frames and closes channels", async () => {
  const f = fixture();
  const duplex = await f.connect();
  expect(duplex.protocol).toBe("vite-hmr");
  expect(f.calls).toEqual([`GET /1.0/instances/${name}`, `POST /1.0/instances/${name}/exec`]);
  expect(f.lastExec()?.command).toEqual(["/usr/bin/python3", "-I", "-S", "-u", "-c", PREVIEW_GUEST_RELAY]);
  expect(f.lastExec()?.user).toBe(1000);
  expect(f.lastExec()?.environment).toEqual({ HOME: "/workspace", PATH: "/usr/local/bin:/usr/bin:/bin", EZH_PREVIEW_PORT: "4173",
    EZH_PREVIEW_LIFETIME_SECONDS: expect.any(String) });
  const handshake = f.channels[0]!.sent[0]!.toString();
  expect(handshake).toContain("GET /socket?foo=bar HTTP/1.1");
  expect(handshake).toContain("Host: 127.0.0.1:4173");
  expect(handshake).not.toMatch(/Cookie|Authorization|example.com/i);
  await duplex.send("hello");
  await duplex.send(new Uint8Array([1, 2, 3]));
  const messages = duplex.messages[Symbol.asyncIterator]();
  expect((await messages.next()).value).toBe("hello");
  expect((await messages.next()).value).toEqual(new Uint8Array([1, 2, 3]));
  expect(f.revalidations()).toBeGreaterThanOrEqual(4);
  await duplex.close();
  await Bun.sleep(0);
  expect(f.channels.every(channel => channel.closed)).toBe(true);
});

test("a START changes provider generation without changing the broker preview binding epoch", async () => {
  const f = fixture({ generation: "2" });
  const duplex = await f.connect();
  expect(duplex.protocol).toBe("vite-hmr");
  expect(f.calls).toEqual([`GET /1.0/instances/${name}`, `POST /1.0/instances/${name}/exec`]);
  await duplex.close();
});

test("invalid provider generation denies before exec and wrong subprotocol denies the upgrade", async () => {
  const changed = fixture({ generation: "0" });
  await expect(changed.connect()).rejects.toThrow("Incus lifecycle request failed");
  expect(changed.calls).toEqual([`GET /1.0/instances/${name}`]);
  const wrong = fixture({ selectProtocol: null });
  await expect(wrong.connect()).rejects.toThrow("Incus lifecycle request failed");
  expect(wrong.channels.every(channel => channel.closed)).toBe(true);
});

test("a replaced instance owner still denies before guest exec", async () => {
  const replaced = fixture({ generation: "2", sandboxId: "foreign-sandbox" });
  await expect(replaced.connect()).rejects.toThrow("Incus lifecycle request failed");
  expect(replaced.calls).toEqual([`GET /1.0/instances/${name}`]);
});

test("invalid destination, stale authority, oversize frame, and revoke fail closed", async () => {
  const f = fixture();
  await expect(f.connect({ ...request(), targetPort: 22 })).rejects.toThrow("Invalid Incus preview request");
  f.authority.registeredPort = 4174;
  await expect(f.connect()).rejects.toThrow("authority changed");
  f.authority.registeredPort = 4173;
  const duplex = await f.connect();
  await expect(duplex.send(new Uint8Array(256 * 1024 + 1))).rejects.toThrow("output limit");
  await expect(duplex.send("later")).rejects.toThrow("closed");
  await duplex.close();
  let revoked = false;
  const revokedFixture = fixture({ onRevalidate: () => { if (revoked) throw new Error("revoked"); } });
  const active = await revokedFixture.connect();
  revoked = true;
  await expect(active.send("after revoke")).rejects.toThrow("revoked");
  await active.close();
});

test("fixed Python relay reaches only selected guest loopback port", async () => {
  const server = createServer(socket => socket.on("data", chunk => socket.write(chunk)));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const child = Bun.spawn([hostPython3(), "-I", "-S", "-u", "-c", PREVIEW_GUEST_RELAY], {
    env: { ...process.env, EZH_PREVIEW_PORT: String(address.port), EZH_PREVIEW_LIFETIME_SECONDS: "5" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    child.stdin.write("duplex");
    const reader = child.stdout.getReader();
    const next = await reader.read();
    expect(Buffer.from(next.value ?? []).toString()).toBe("duplex");
    reader.releaseLock();
  } finally {
    child.stdin.end();
    await child.exited;
    server.close();
  }
});

test("production preview proof server completes the Incus duplex handshake and challenge", async () => {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const port = address.port;
  const challenge = "local-preview-proof";
  const server = Bun.spawn([hostPython3(), "-u", "-c", PREVIEW_PYTHON.replace(`,4173),Handler)`, `,${port}),Handler)`) ], {
    env: { ...process.env, EZH_QUAL_CHALLENGE: challenge }, stdout: "pipe", stderr: "pipe",
  });
  const relay = Bun.spawn([hostPython3(), "-I", "-S", "-u", "-c", PREVIEW_GUEST_RELAY], {
    env: { ...process.env, EZH_PREVIEW_PORT: String(port), EZH_PREVIEW_LIFETIME_SECONDS: "15" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      ready = await fetch(`http://127.0.0.1:${port}/proof`).then(reply => reply.status === 200).catch(() => false);
      if (ready) break;
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const f = fixture();
    f.authority.registeredPort = port;
    f.channels[0]!.onSend = bytes => { relay.stdin.write(bytes); };
    const pump = (async () => {
      const reader = relay.stdout.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          f.channels[1]!.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
        f.channels[1]!.push(null);
      }
    })();
    const duplex = await f.connect({ ...request(), targetPort: port, requestPath: "/proof", search: "" });
    expect(duplex.protocol).toBe("vite-hmr");
    await duplex.send(challenge);
    expect((await duplex.messages[Symbol.asyncIterator]().next()).value).toBe(challenge);
    await duplex.close();
    relay.stdin.end();
    await pump;
  } finally {
    relay.kill();
    server.kill();
    await Promise.all([relay.exited, server.exited]);
  }
}, 20_000);

test("global connection cap and abort release every exec channel", async () => {
  const fixtures = Array.from({ length: 9 }, () => fixture());
  const duplexes = [];
  for (let index = 0; index < 8; index++) {
    duplexes.push(await fixtures[index]!.connect({ ...request(), previewId: `preview-${index}` }));
  }
  await expect(fixtures[8]!.connect({ ...request(), previewId: "preview-over-limit" })).rejects.toThrow("connection limit");
  await Promise.all(duplexes.map(duplex => duplex.close()));
  expect(fixtures.slice(0, 8).every(f => f.channels.every(channel => channel.closed))).toBe(true);
  const controller = new AbortController();
  const replacement = await fixtures[8]!.connect({ ...request(), previewId: "preview-after-release", signal: controller.signal });
  controller.abort();
  await Bun.sleep(0);
  await expect(replacement.send("closed")).rejects.toThrow("closed");
  expect(fixtures[8]!.channels.every(channel => channel.closed)).toBe(true);
});

test("an idle preview closes after authority is revoked", async () => {
  let revoked = false;
  const f = fixture({ onRevalidate: () => { if (revoked) throw new Error("revoked"); } });
  const duplex = await f.connect();
  revoked = true;
  await Bun.sleep(2_100);
  expect(f.channels.every(channel => channel.closed)).toBe(true);
  await expect(duplex.send("too late")).rejects.toThrow("closed");
});

test("path whitespace is denied before guest exec", async () => {
  const f = fixture();
  await expect(f.connect({ ...request(), requestPath: "/bad path" })).rejects.toThrow("Invalid Incus preview path");
  expect(f.calls).toEqual([]);
});

test("ping frames recheck authority and a control-frame flood is bounded", async () => {
  let revoked = false;
  const f = fixture({ onRevalidate: () => { if (revoked) throw new Error("revoked"); } });
  const duplex = await f.connect();
  revoked = true;
  f.channels[1]!.push(serverFrame(9, Buffer.alloc(0)));
  await expect(duplex.messages[Symbol.asyncIterator]().next()).rejects.toThrow("revoked");
  expect(f.channels.every(channel => channel.closed)).toBe(true);

  const flood = fixture();
  const active = await flood.connect();
  for (let index = 0; index < 1025; index++) flood.channels[1]!.push(serverFrame(9, Buffer.alloc(0)));
  await expect(active.messages[Symbol.asyncIterator]().next()).rejects.toThrow("input limit");
  expect(flood.channels.every(channel => channel.closed)).toBe(true);
});

test("pinned Incus WebSocket bounded write crosses a real mTLS channel", async () => {
  const controller = new AbortController();
  const server = createTlsServer({ cert: certificates.read("substitute-server-cert.pem"),
    key: certificates.read("substitute-server-key.pem"), ca: certificates.read("client-ca-cert.pem"),
    requestCert: true, rejectUnauthorized: true }, socket => {
    let upgrade = false;
    socket.on("data", chunk => {
      if (upgrade) return;
      const header = chunk.toString("latin1");
      const key = /Sec-WebSocket-Key: (\S+)/i.exec(header)?.[1];
      if (!key) return;
      upgrade = true;
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const session = { connection: { endpoint: `https://127.0.0.1:${address.port}`, project: "sandbox",
    serverCertificatePem: certificates.read("substitute-server-cert.pem"), clientCertificatePem: certificates.read("client-cert.pem"),
    privateKeyPem: certificates.read("client-key.pem") }, origin: new URL(`https://127.0.0.1:${address.port}`),
  tls: { cert: certificates.read("client-cert.pem"), key: certificates.read("client-key.pem"),
    ca: certificates.read("substitute-server-cert.pem"), rejectUnauthorized: true as const,
    checkServerIdentity: () => undefined }, signal: controller.signal,
  request: async () => { throw new Error("No HTTP request expected"); } } satisfies Session;
  try {
    const socket = await openPinnedWebSocket(session, operationId, tokens["0"]);
    await socket.sendBounded?.(Buffer.from("bounded"));
    socket.close();
    await expect(socket.sendBounded?.(Buffer.from("closed"))).rejects.toThrow("closed");
  } finally {
    controller.abort();
    server.close();
  }
});

test("fragmented guest messages are assembled and stray continuation closes", async () => {
  const f = fixture();
  const duplex = await f.connect();
  const messages = duplex.messages[Symbol.asyncIterator]();
  f.channels[1]!.push(serverFrame(1, Buffer.from("he"), false));
  f.channels[1]!.push(serverFrame(9, Buffer.alloc(0)));
  f.channels[1]!.push(serverFrame(0, Buffer.from("llo")));
  expect((await messages.next()).value).toBe("hello");
  const pong = decodeClientFrame(f.channels[0]!.sent.at(-1)!);
  expect(pong.opcode).toBe(10);
  f.channels[1]!.push(serverFrame(0, Buffer.from("orphan")));
  await expect(messages.next()).rejects.toThrow("Unexpected preview continuation");
  expect(f.channels.every(channel => channel.closed)).toBe(true);
});

test("preview-only session accepts a long HMR stream without widening ordinary RPC", async () => {
  const f = fixture({ deadlineOffsetMs: 5 * 60_000 });
  const input = { ...request(), expiresAt: new Date(Date.now() + 10 * 60_000) };
  const duplex = await f.connect(input);
  const environment = f.lastExec()?.environment as Record<string, string> | undefined;
  expect(Number(environment?.EZH_PREVIEW_LIFETIME_SECONDS)).toBeGreaterThan(240);
  await expect(withSession(f.authority.connections, f.authority.scope, f.http as never,
    f.authority.command, async () => true)).rejects.toThrow("Invalid Incus lifecycle scope");
  await duplex.close();
  expect(MAX_PREVIEW_SESSION_MS).toBe(900_000);
});

test("stalled guest handshakes release the global slot after the short setup deadline", async () => {
  const stalled = Array.from({ length: 8 }, () => fixture({ stallHandshake: true, setupTimeoutMs: 25 }));
  await Promise.all(stalled.map((f, index) => expect(f.connect({ ...request(), previewId: `stall-${index}` })).rejects.toThrow()));
  expect(stalled.every(f => f.channels.every(channel => channel.closed))).toBe(true);
  const next = fixture();
  const duplex = await next.connect({ ...request(), previewId: "after-stall" });
  await duplex.close();
});

test("established duplex stays open after its short setup timer", async () => {
  const f = fixture({ setupTimeoutMs: 25 });
  const duplex = await f.connect();
  await Bun.sleep(60);
  await duplex.send("still open");
  expect((await duplex.messages[Symbol.asyncIterator]().next()).value).toBe("still open");
  await duplex.close();
});

test("fixed guest relay exits before opening a socket when no Incus stdin arrives", async () => {
  const child = Bun.spawn([hostPython3(), "-I", "-S", "-u", "-c", PREVIEW_GUEST_RELAY], {
    env: { ...process.env, EZH_PREVIEW_PORT: "4173", EZH_PREVIEW_LIFETIME_SECONDS: "20" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const exitCode = await Promise.race([child.exited, Bun.sleep(12_000).then(() => { throw new Error("Guest attach watchdog did not exit"); })]);
    expect(exitCode).toBe(1);
  } finally {
    child.kill();
    child.stdin.end();
  }
}, 15_000);
