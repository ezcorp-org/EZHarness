import { afterAll, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import { checkServerIdentity } from "node:tls";
import { openPinnedWebSocket } from "./pinned-websocket";
import { makeTestCertificates } from "./test-certificates";
import type { Session } from "./lifecycle";

const certificates = makeTestCertificates();
afterAll(() => certificates.dispose());
const cert = certificates.read("server-cert.pem");
const key = certificates.read("server-key.pem");
const otherCert = certificates.read("other-server-cert.pem");
const otherKey = certificates.read("other-server-key.pem");
const substituteCert = certificates.read("substitute-server-cert.pem");
const substituteKey = certificates.read("substitute-server-key.pem");
const clientCert = certificates.read("client-cert.pem");
const clientKey = certificates.read("client-key.pem");
const clientCa = certificates.read("client-ca-cert.pem");
const operationId = "11111111-1111-1111-1111-111111111111";
const secret = "a".repeat(64);

function session(port: number, pinnedCert = cert): Session {
  const pinnedFingerprint = createHash("sha256").update(new X509Certificate(pinnedCert).raw).digest("hex");
  return { connection: { endpoint: `https://127.0.0.1:${port}`, serverCertificatePem: pinnedCert, project: "sandbox", clientCertificatePem: clientCert, privateKeyPem: clientKey },
    origin: new URL(`https://127.0.0.1:${port}`), signal: new AbortController().signal,
    tls: { cert: clientCert, key: clientKey, ca: pinnedCert, rejectUnauthorized: true,
      checkServerIdentity: (host, peer) => checkServerIdentity(host, peer) || (peer.raw && createHash("sha256").update(peer.raw).digest("hex") === pinnedFingerprint ? undefined : new Error("pin mismatch")) },
    request: async () => { throw new Error("not used"); } };
}

async function serveWebSocket(onConnect: (socket: TLSSocket, request: string) => void, identity = { cert, key }) {
  const server = createServer({ ...identity, ca: clientCa, requestCert: true, rejectUnauthorized: true }, socket => {
    socket.once("data", data => {
      const request = data.toString("latin1");
      const wsKey = /Sec-WebSocket-Key: ([^\r\n]+)/i.exec(request)?.[1];
      if (!wsKey) { socket.destroy(); return; }
      const accept = createHash("sha1").update(wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      onConnect(socket, request);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function expectNoUpgrade(identity: { cert: string; key: string }, pinnedCert: string,
  configure: (candidate: Session) => void = () => undefined) {
  let bytes = 0;
  const server = createServer({ ...identity, ca: clientCa, requestCert: true, rejectUnauthorized: true }, socket => {
    socket.on("data", chunk => { bytes += chunk.length; });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const candidate = session((server.address() as AddressInfo).port, pinnedCert);
    configure(candidate);
    await expect(openPinnedWebSocket(candidate, operationId, secret)).rejects.toThrow();
    expect(bytes).toBe(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("exact pinned non-CA Incus leaf can open a WebSocket", async () => {
  const server = await serveWebSocket(socket => socket.write(Buffer.from([0x81, 0x00])),
    { cert: substituteCert, key: substituteKey });
  try {
    const ws = await openPinnedWebSocket(session(server.port, substituteCert), operationId, secret);
    try { expect(await ws.readAll()).toEqual(Buffer.alloc(0)); }
    finally { ws.close(); }
  } finally { await server.close(); }
}, 15_000);

test("verified WebSocket accepts bounded frames over pinned mTLS", async () => {
  const seen: string[] = [];
  const frames: Buffer[] = [];
  let received: (() => void) | undefined;
  const allFrames = new Promise<void>(resolve => { received = resolve; });
  const expectedBytes = (2 + 4 + 1) + (4 + 4 + 126) + (10 + 4 + 65_536) + 6;
  const server = await serveWebSocket((socket, request) => {
    seen.push(request.split("\r\n", 1)[0]!);
    // Incus ends the stream with an empty text barrier, then closes the TCP socket.
    socket.write(Buffer.from([0x82, 0x02, 0x6f, 0x6b, 0x81, 0x00]));
    socket.on("data", frame => {
      frames.push(Buffer.isBuffer(frame) ? frame : Buffer.from(frame));
      if (Buffer.concat(frames).length >= expectedBytes) {
        received?.();
        socket.end();
      }
    });
  });
  try {
    const ws = await openPinnedWebSocket(session(server.port), operationId, secret);
    const output = ws.readAll();
    ws.send(Buffer.from("x"));
    ws.send(Buffer.alloc(126, 1));
    ws.send(Buffer.alloc(65_536, 2));
    expect(() => ws.send(Buffer.alloc(2 * 1024 * 1024 + 1))).toThrow("request is too large");
    ws.finish();
    await allFrames;
    expect((await output).toString()).toBe("ok");
    const wire = Buffer.concat(frames);
    let offset = 0;
    for (const [length, header, marker] of [[1, 2, 1], [126, 4, 126], [65_536, 10, 127]]) {
      expect(wire[offset]).toBe(0x82);
      expect(wire[offset + 1]).toBe(0x80 | marker);
      const declared = header === 2 ? wire[offset + 1]! & 127 : header === 4 ? wire.readUInt16BE(offset + 2) : Number(wire.readBigUInt64BE(offset + 2));
      expect(declared).toBe(length);
      const mask = wire.subarray(offset + header, offset + header + 4);
      const decoded = wire.subarray(offset + header + 4, offset + header + 4 + length).map((byte, i) => byte ^ mask[i % 4]!);
      expect(decoded).toEqual(length === 1 ? Buffer.from("x") : Buffer.alloc(length, length === 126 ? 1 : 2));
      offset += header + 4 + length;
    }
    expect(wire.subarray(offset, offset + 2)).toEqual(Buffer.from([0x81, 0x80]));
    expect(wire.length).toBe(offset + 6);
    expect(seen).toEqual([`GET /1.0/operations/${operationId}/websocket?secret=${secret}&project=sandbox HTTP/1.1`]);
    ws.close();
  } finally { await server.close(); }
}, 15_000);

test("Incus ping is answered while binary output ends at the text barrier", async () => {
  const pong = Promise.withResolvers<Buffer>();
  const server = await serveWebSocket(socket => {
    socket.write(Buffer.from([0x89, 0x02, 0x68, 0x69, 0x82, 0x02, 0x6f, 0x6b, 0x81, 0x00]));
    socket.once("data", data => pong.resolve(Buffer.from(data)));
  });
  try {
    const ws = await openPinnedWebSocket(session(server.port), operationId, secret);
    try {
      expect((await ws.readAll()).toString()).toBe("ok");
      const wire = await pong.promise;
      expect(wire.subarray(0, 2)).toEqual(Buffer.from([0x8a, 0x82]));
      const payload = wire.subarray(6, 8).map((byte, i) => byte ^ wire[2 + i]!);
      expect(payload).toEqual(Buffer.from("hi"));
    } finally { ws.close(); }
  } finally { await server.close(); }
}, 15_000);

test("malformed text barriers and close before Incus EOF are rejected", async () => {
  for (const [frame, message] of [
    [Buffer.from([0x81, 0x01, 0x78]), "Invalid Incus WebSocket stream EOF"],
    [Buffer.from([0x01, 0x00]), "Invalid Incus WebSocket stream EOF"],
    [Buffer.from([0xc1, 0x00]), "Invalid Incus WebSocket stream EOF"],
    [Buffer.from([0x88, 0x00]), "Incus WebSocket closed before stream EOF"],
  ] as const) {
    const server = await serveWebSocket(socket => socket.end(frame));
    try {
      const ws = await openPinnedWebSocket(session(server.port), operationId, secret);
      try { await expect(ws.readAll()).rejects.toThrow(message); }
      finally { ws.close(); }
    } finally { await server.close(); }
  }
}, 15_000);

test("oversized Incus WebSocket frame is rejected before reading payload", async () => {
  const header = Buffer.from([0x82, 0x7f, 0, 0, 0, 0, 0, 0x20, 0, 1]);
  const server = await serveWebSocket(socket => socket.end(header));
  try {
    const ws = await openPinnedWebSocket(session(server.port), operationId, secret);
    try { await expect(ws.readAll()).rejects.toThrow("Incus WebSocket response is too large"); }
    finally { ws.close(); }
  } finally { await server.close(); }
}, 15_000);

test("wrong leaf and wrong hostname send no WebSocket upgrade bytes", async () => {
  await expectNoUpgrade({ cert: substituteCert, key: substituteKey }, cert,
    candidate => { candidate.tls.checkServerIdentity = () => undefined; });
  await expectNoUpgrade({ cert: otherCert, key: otherKey }, otherCert,
    candidate => { candidate.tls.checkServerIdentity = () => undefined; });
}, 15_000);

test("abort before and at verification sends no WebSocket upgrade bytes", async () => {
  const before = new AbortController();
  before.abort();
  await expectNoUpgrade({ cert, key }, cert, candidate => { candidate.signal = before.signal; });
  const boundary = new AbortController();
  await expectNoUpgrade({ cert, key }, cert, candidate => {
    candidate.signal = boundary.signal;
    candidate.tls.checkServerIdentity = () => { boundary.abort(); return undefined; };
  });
}, 15_000);


test("certificate fixture removes its temporary files after OpenSSL failure", () => {
  let directory: string | undefined;
  expect(() => makeTestCertificates((_command: string, ...args: unknown[]) => {
    const cwd = (args[1] as { cwd?: unknown } | undefined)?.cwd;
    if (typeof cwd !== "string") throw new Error("Missing certificate directory");
    directory = cwd;
    writeFileSync(join(directory, "partial.pem"), "partial certificate");
    throw new Error("OpenSSL unavailable");
  }))
    .toThrow("OpenSSL unavailable");
  expect(directory).toBeDefined();
  expect(existsSync(directory!)).toBe(false);
});
