import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { connect } from "node:tls";
import { certificates, rawTls, type Certificates } from "../__tests__/helpers/factory-certificates";
import { privateHttpsCall } from "../__tests__/helpers/factory-private-https-client";
import { FACTORY_PRIVATE_MAX_ENVELOPE_BYTES, startFactoryPrivateHttps } from "./private-https";

const directories: string[] = [];
let certs: Certificates;
beforeAll(async () => { certs = await certificates(directories); });
afterAll(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });

test("a real Node client receives exact immutable bytes and the Bun handler receives its verified certificate", async () => {
  const page = Buffer.from("A bounded immutable page: ".repeat(1000));
  const peers: string[] = [];
  const server = startFactoryPrivateHttps({
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    async handle(request) {
      peers.push(request.peerIdentity);
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/internal/factory/v1/page");
      expect(request.body.toString()).toBe('{"tenantId":"forged-tenant"}');
      return { status: 200, body: page };
    },
  });
  try {
    const child = Bun.spawn(["node", new URL("../__tests__/helpers/factory-node-https-client.mjs", import.meta.url).pathname], {
      stdin: new Blob([JSON.stringify({ url: `${server.url}/internal/factory/v1/page`, method: "POST", body: Buffer.from('{"tenantId":"forged-tenant"}').toString("base64"), ca: certs.ca, cert: certs.clientCert, key: certs.clientKey, headers: { "content-type": "application/json" } })]), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const received = JSON.parse(stdout);
    expect(received.status).toBe(200);
    expect(Buffer.from(received.body, "base64")).toEqual(page);
    expect(peers).toEqual(["tenant-a"]);
  } finally { server.stop(); }
});

describe("only a client certificate the listener's authority issued, and that is still valid, reaches the handler (W01k)", () => {
  // Bun 1.4 enforces rejectUnauthorized in Bun.listen: a client certificate the
  // listener's authority did not issue, or that is not valid now, fails the
  // handshake, and the connection closes with zero bytes before any request is
  // read. (Bun 1.3.14 completed the handshake and reported the failure only as
  // authorizationError, so the product answered 401 {"error":"unauthorized"}
  // itself.) The listener's handshake callback still takes a peer identity only
  // from a verified certificate, as defence in depth. The trusted case below
  // proves acceptance; each untrusted case proves refusal at the handshake.
  let trusted: Certificates;
  let outsider: Certificates;
  let server: { url: string; stop(): void };
  const peers: string[] = [];
  beforeAll(async () => {
    trusted = await certificates(directories, "tenant-a", { untrustedClients: true });
    // Same subject, unrelated authority: an impersonation attempt.
    outsider = await certificates(directories, "tenant-a");
    server = startFactoryPrivateHttps({
      tls: { key: trusted.serverKey, cert: trusted.serverCert, ca: trusted.ca },
      async handle(request) { peers.push(request.peerIdentity); return { status: 200, body: Buffer.from('{"reached":true}') }; },
    });
  });
  afterAll(() => { server.stop(); });
  const as = (cert: string | undefined, key: string | undefined) => rawTls(server.url, { ...trusted, clientCert: cert as string, clientKey: key as string }, ["GET /identity HTTP/1.1\r\n\r\n"]);
  const answer = (response: string) => ({ status: response.split("\r\n")[0], body: response.slice(response.indexOf("\r\n\r\n") + 4) });

  test("a trusted client reaches the handler with its own identity", async () => {
    peers.length = 0;
    expect(answer(await as(trusted.clientCert, trusted.clientKey)).status).toBe("HTTP/1.1 200 OK");
    expect(peers).toEqual(["tenant-a"]);
  });

  for (const [label, pick] of [
    ["from an unrelated authority (unable to verify the first certificate)", () => ({ cert: outsider.clientCert, key: outsider.clientKey })],
    ["expired (certificate has expired)", () => trusted.untrusted!.expired],
    ["not yet valid (certificate is not yet valid)", () => trusted.untrusted!.notYetValid],
    ["for serverAuth only (unsupported certificate purpose)", () => trusted.untrusted!.serverAuthOnly],
    ["self-signed (self signed certificate)", () => trusted.untrusted!.selfSigned],
  ] as const) {
    test(`a client certificate ${label} is refused in the handshake before any handler`, async () => {
      peers.length = 0;
      const { cert, key } = pick();
      // Zero bytes back and the connection closed: no 401, no response line, nothing read.
      expect(await as(cert, key)).toBe("");
      expect(peers).toEqual([]);
    });
  }

  test("a client with no certificate fails the handshake itself and reaches no handler", async () => {
    peers.length = 0;
    // Bun reports success=false and closes with no response: refused earlier than a 401.
    expect(await as(undefined, undefined)).toBe("");
    expect(peers).toEqual([]);
  });
});

test("the read deadline applies to incomplete requests and not to accepted handler work", async () => {
  let calls = 0;
  const server = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, requestTimeoutMs: 100, async handle() { calls += 1; await Bun.sleep(200); return { status: 200, body: Buffer.from('"complete"') }; } });
  try {
    expect(await rawTls(server.url, certs, ["GET /page HTTP/1.1\r\nhost: localhost\r\n\r\n"])).toContain('"complete"');
    expect(calls).toBe(1);
    expect(await rawTls(server.url, certs, ["GET /page HTTP/1.1\r\n"])).toContain("request_timeout");
    expect(calls).toBe(1);
  } finally { server.stop(); }
});

test("malformed framing cannot reach the handler and fragmented requests keep exact bytes", async () => {
  const accepted: string[] = [];
  const server = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, maxBodyBytes: 16, async handle(request) { accepted.push(request.body.toString()); return { status: 200, body: Buffer.from('"accepted"') }; } });
  try {
    for (const request of [
      "GET / HTTP/1.0\r\n\r\n",
      "GET //foreign/ HTTP/1.1\r\n\r\n",
      "GET /bad\0path HTTP/1.1\r\n\r\n",
      "GET / HTTP/1.1\r\nx-invalid: a\0b\r\n\r\n",
      "GET / HTTP/1.1\r\nBad Header: x\r\n\r\n",
      "GET / HTTP/1.1\r\nHost: a\r\nhost: b\r\n\r\n",
      "POST / HTTP/1.1\r\ncontent-length: -1\r\n\r\n",
      "POST / HTTP/1.1\r\ncontent-length: 1e1\r\n\r\n",
      "POST / HTTP/1.1\r\ntransfer-encoding: chunked\r\n\r\n",
      "GET / HTTP/1.1\r\n\r\nGET /again HTTP/1.1\r\n\r\n",
    ]) expect(await rawTls(server.url, certs, [request])).toContain("400 Bad Request");
    expect(await rawTls(server.url, certs, ["POST / HTTP/1.1\r\ncontent-length: 17\r\n\r\n"])).toContain("413 Payload Too Large");
    const prefix = "GET / HTTP/1.1\r\nx-long: ";
    expect(await rawTls(server.url, certs, [prefix + "x".repeat(16 * 1024 - Buffer.byteLength(prefix) + 1)])).toContain("header_too_large");
    expect(accepted).toEqual([]);
    expect(await rawTls(server.url, certs, ["POST / HTTP/1.1\r\n", "content-length: 5\r\n\r\n", "ab", "cde"])).toContain('"accepted"');
    expect(accepted).toEqual(["abcde"]);
  } finally { server.stop(); }
});

test("handler failures and invalid responses stay bounded and do not disclose internal errors", async () => {
  const server = startFactoryPrivateHttps({
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    async handle(request) {
      if (request.path === "/throw") throw new Error("internal credential details");
      if (request.path === "/large") return { status: 200, body: Buffer.alloc(64 * 1024 + 1) };
      if (request.path === "/status") return { status: 700, body: Buffer.alloc(0) };
      if (request.path === "/header") return { status: 200, body: Buffer.alloc(0), contentType: "bad\r\nx-injected: true" as "application/json" };
      return { status: 200, body: Buffer.alloc(64 * 1024, "z"), contentType: "application/octet-stream" };
    },
  });
  try {
    for (const path of ["/throw", "/large", "/status", "/header"]) {
      const response = await rawTls(server.url, certs, [`GET ${path} HTTP/1.1\r\n\r\n`]);
      expect(response).toContain("500 Internal Server Error");
      expect(response).not.toContain("credential");
      expect(response).not.toContain("x-injected");
    }
    const response = await rawTls(server.url, certs, ["GET /limit HTTP/1.1\r\n\r\n"]);
    expect(response).toContain("content-type: application/octet-stream\r\n");
    expect(response.split("\r\n\r\n")[1]).toBe("z".repeat(64 * 1024));
  } finally { server.stop(); }
});

/**
 * A raw TLS client that writes `first`, waits for `entered` (the handler is running), then writes `second`, and reports
 * how the peer closed: "end" (an orderly close) or "reset" (ECONNRESET). Bun 1.4's terminate() sends a bare reset
 * without close_notify (oven-sh/bun#39632), and its TLS client reports a peer reset as ECONNRESET (#39600); 1.3.14
 * surfaced both as an orderly end. Any other error, or no close within 5 s, rejects. The wait is on the handler, not on
 * time: two requests the server reads in one chunk are the pipelining refusal (400), a different case (W4G-7).
 */
function rawTlsCloseDuringWork(url: string, first: string, entered: Promise<void>, second: string): Promise<{ bytes: string; closed: "end" | "reset" }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(new URL(url).port), ca: certs.ca, cert: certs.clientCert, key: certs.clientKey, servername: "localhost", rejectUnauthorized: true });
    socket.setTimeout(5_000, () => socket.destroy(new Error("TLS test request timed out")));
    let bytes = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { bytes += chunk; });
    socket.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "ECONNRESET") resolve({ bytes, closed: "reset" }); else reject(error); });
    socket.once("end", () => resolve({ bytes, closed: "end" }));
    socket.once("secureConnect", async () => { socket.write(first); await entered; socket.write(second); });
  });
}

test("an extra request during accepted work closes the connection before any response", async () => {
  let calls = 0;
  const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
  const server = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, async handle() { calls += 1; enter(); await Bun.sleep(50); return { status: 200, body: Buffer.from("sensitive result") }; } });
  try {
    // The property is the close, not its mechanism: zero bytes, closed within 5 s, whether by end or by reset.
    const outcome = await rawTlsCloseDuringWork(server.url, "GET / HTTP/1.1\r\n\r\n", entered, "GET /again HTTP/1.1\r\n\r\n");
    expect(outcome.bytes).toBe("");
    expect(["end", "reset"]).toContain(outcome.closed);
    await Bun.sleep(75);
    expect(calls).toBe(1);
  } finally { server.stop(); }
});

test("private transport limits reject unsafe configuration before opening a port", () => {
  for (const maxResponseBytes of [0, 1.5, FACTORY_PRIVATE_MAX_ENVELOPE_BYTES + 1]) expect(() => startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, maxResponseBytes, async handle() { throw new Error("must not run"); } })).toThrow("Invalid private HTTPS limits");
  for (const [maxBodyBytes, requestTimeoutMs] of [[0, 1], [FACTORY_PRIVATE_MAX_ENVELOPE_BYTES + 1, 1], [1.5, 1], [1, 0], [1, 60_001], [1, 1.5]]) {
    expect(() => startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, maxBodyBytes, requestTimeoutMs, async handle() { throw new Error("must not run"); } })).toThrow("Invalid private HTTPS limits");
  }
});

test("the exact envelope ceiling opens a port and a large body arrives whole", async () => {
  const ceiling = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, maxBodyBytes: FACTORY_PRIVATE_MAX_ENVELOPE_BYTES, maxResponseBytes: FACTORY_PRIVATE_MAX_ENVELOPE_BYTES, async handle() { return { status: 200, body: Buffer.from("ok") }; } });
  try { expect(ceiling.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/u); } finally { ceiling.stop(); }

  const bodies: Buffer[] = [];
  const server = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, maxBodyBytes: 4 * 1024 * 1024, maxResponseBytes: 4 * 1024 * 1024, async handle({ body, method, path }) { bodies.push(Buffer.from(body)); return { status: method === "PUT" && path === "/internal/factory/v1/large" ? 200 : 400, body, contentType: "application/octet-stream" }; } });
  try {
    const payload = Buffer.alloc(3 * 1024 * 1024);
    for (let index = 0; index < payload.byteLength; index++) payload[index] = index % 251;
    const received = await privateHttpsCall(`${server.url}/internal/factory/v1/large`, certs, { method: "PUT", body: payload, headers: { "content-type": "application/octet-stream" } });
    expect(received.status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.equals(payload)).toBe(true);
    expect(received.body.equals(payload)).toBe(true);
    const refused = await privateHttpsCall(`${server.url}/internal/factory/v1/large`, certs, { method: "PUT", body: Buffer.alloc(4 * 1024 * 1024 + 1), headers: { "content-type": "application/octet-stream" } });
    expect(refused.status).toBe(413);
    expect(bodies).toHaveLength(1);
  } finally { server.stop(); }
}, 30_000);

// Bound: requestTimeoutMs, 100 ms here. On Bun 1.4 end() only half-closes TLS, so the listener's timer cuts the peer.
test("a peer that keeps its write side open cannot retain a completed server connection", async () => {
  const server = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, requestTimeoutMs: 100, async handle() { return { status: 200, body: Buffer.from("complete") }; } });
  try {
    const child = Bun.spawn(["node", new URL("../__tests__/helpers/factory-node-half-close.mjs", import.meta.url).pathname], { stdin: new Blob([JSON.stringify({ url: server.url, ca: certs.ca, cert: certs.clientCert, key: certs.clientKey })]), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ received: true, closedByServer: true });
  } finally { server.stop(); }
});
