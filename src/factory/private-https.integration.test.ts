import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { certificates, rawTls, type Certificates } from "../__tests__/helpers/factory-certificates";
import { startFactoryPrivateHttps } from "./private-https";

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

test("an extra request during accepted work closes the connection before any response", async () => {
  let calls = 0;
  const server = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, async handle() { calls += 1; await Bun.sleep(50); return { status: 200, body: Buffer.from("sensitive result") }; } });
  try {
    expect(await rawTls(server.url, certs, ["GET / HTTP/1.1\r\n\r\n", "GET /again HTTP/1.1\r\n\r\n"])).toBe("");
    await Bun.sleep(75);
    expect(calls).toBe(1);
  } finally { server.stop(); }
});

test("private transport limits reject unsafe configuration before opening a port", () => {
  for (const [maxBodyBytes, requestTimeoutMs] of [[0, 1], [1024 * 1024 + 1, 1], [1.5, 1], [1, 0], [1, 60_001], [1, 1.5]]) {
    expect(() => startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, maxBodyBytes, requestTimeoutMs, async handle() { throw new Error("must not run"); } })).toThrow("Invalid private HTTPS limits");
  }
});
