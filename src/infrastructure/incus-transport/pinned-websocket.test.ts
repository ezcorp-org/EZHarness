import { afterAll, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:tls";
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
const clientCert = certificates.read("client-cert.pem");
const clientKey = certificates.read("client-key.pem");
const clientCa = certificates.read("client-ca-cert.pem");
const fingerprint = createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
const operationId = "11111111-1111-1111-1111-111111111111";
const secret = "a".repeat(64);

function session(port: number): Session {
  return { connection: { endpoint: `https://127.0.0.1:${port}`, serverCertificatePem: cert, project: "sandbox", clientCertificatePem: clientCert, privateKeyPem: clientKey },
    origin: new URL(`https://127.0.0.1:${port}`), signal: new AbortController().signal,
    tls: { cert: clientCert, key: clientKey, ca: cert, rejectUnauthorized: true,
      checkServerIdentity: (host, peer) => checkServerIdentity(host, peer) || (peer.raw && createHash("sha256").update(peer.raw).digest("hex") === fingerprint ? undefined : new Error("pin mismatch")) },
    request: async () => { throw new Error("not used"); } };
}

test("verified WebSocket accepts bounded frames over pinned mTLS", async () => {
  const seen: string[] = [];
  const frames: Buffer[] = [];
  let received: (() => void) | undefined;
  const allFrames = new Promise<void>(resolve => { received = resolve; });
  const expectedBytes = (2 + 4 + 1) + (4 + 4 + 126) + (10 + 4 + 65_536);
  const server = createServer({ cert, key, ca: clientCa, requestCert: true, rejectUnauthorized: true }, socket => {
    socket.once("data", data => {
      const request = data.toString("latin1");
      seen.push(request.split("\r\n", 1)[0]!);
      const wsKey = /Sec-WebSocket-Key: ([^\r\n]+)/i.exec(request)?.[1];
      if (!wsKey) { socket.destroy(); return; }
      const accept = createHash("sha1").update(wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.write(Buffer.from([0x82, 0x02, 0x6f, 0x6b, 0x88, 0x00]));
      socket.on("data", frame => {
        frames.push(Buffer.isBuffer(frame) ? frame : Buffer.from(frame));
        if (Buffer.concat(frames).length >= expectedBytes) received?.();
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const ws = await openPinnedWebSocket(session((server.address() as AddressInfo).port), operationId, secret);
    expect((await ws.readAll()).toString()).toBe("ok");
    ws.send(Buffer.from("x"));
    ws.send(Buffer.alloc(126, 1));
    ws.send(Buffer.alloc(65_536, 2));
    expect(() => ws.send(Buffer.alloc(2 * 1024 * 1024 + 1))).toThrow("request is too large");
    await allFrames;
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
    expect(seen).toEqual([`GET /1.0/operations/${operationId}/websocket?secret=${secret}&project=sandbox HTTP/1.1`]);
    ws.close();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15_000);

test("wrong TLS leaf sends no WebSocket upgrade bytes", async () => {
  let bytes = 0;
  const server = createServer({ cert: otherCert, key: otherKey, ca: clientCa, requestCert: true, rejectUnauthorized: true }, socket => {
    socket.on("data", chunk => { bytes += chunk.length; });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await expect(openPinnedWebSocket(session((server.address() as AddressInfo).port), operationId, secret)).rejects.toThrow();
    expect(bytes).toBe(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15_000);


test("certificate fixture removes its temporary files after OpenSSL failure", () => {
  const directories = () => readdirSync(tmpdir()).filter(name => name.startsWith("ez-incus-tls-test-")).sort();
  const before = directories();
  expect(() => makeTestCertificates(() => { throw new Error("OpenSSL unavailable"); }))
    .toThrow("OpenSSL unavailable");
  expect(directories()).toEqual(before);
});
