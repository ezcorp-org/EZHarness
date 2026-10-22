import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurePreviewHttpResponse } from "../runtime/preview/preview-http-policy";
import { IncusSandboxPreviewBackend } from "./incus-preview-backend";
import { createIncusPreviewTrafficDriver } from "./incus-preview-traffic";

const PREVIEW_ID = "abcdefghjkmnpqrstvwxyz0123";
const OTHER_ID = "z0123456789abcdefghjkmnpqr";
const CODE = "a".repeat(64);
const COOKIE = "__ezpreview=header.payload.signature";

function traffic(port: number, previewHost = "localhost") {
  return createIncusPreviewTrafficDriver({ env: {
    EZCORP_PUBLIC_URL: `http://127.0.0.1:${port}`,
    EZCORP_PREVIEW_APP_HOST: previewHost,
  } });
}

function boundPort(server: { port?: number }): number {
  if (!server.port) throw new Error("Test preview listener has no port");
  return server.port;
}

test("real Bun app route proves ready, one-time handoff, bounded HTTP and vite-hmr WebSocket", async () => {
  let closed = 0;
  const server = Bun.serve<{ large: boolean }>({ hostname: "127.0.0.1", port: 0,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      const previewHost = `${PREVIEW_ID}.preview.localhost:${bunServer.port}`;
      if (url.pathname === "/api/ready") return new Response("ready");
      if (request.headers.get("host") !== previewHost) return new Response("wrong preview host", { status: 404 });
      if (url.pathname === "/__open") {
        return url.searchParams.get("c") === CODE
          ? new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": `${COOKIE}; Path=/; HttpOnly; SameSite=Lax` } })
          : new Response("bad code", { status: 404 });
      }
      if (request.headers.get("cookie") !== COOKIE) return new Response("no preview cookie", { status: 403 });
      if (url.pathname === "/hmr" || url.pathname === "/hmr-large") {
        if (request.headers.get("origin") !== `http://${previewHost}`) return new Response("wrong origin", { status: 403 });
        return bunServer.upgrade(request, { headers: { "Sec-WebSocket-Protocol": "vite-hmr" },
          data: { large: url.pathname === "/hmr-large" } })
          ? undefined : new Response("upgrade denied", { status: 400 });
      }
      if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { Location: "https://outside.example/" } });
      if (url.pathname === "/large") return new Response("x".repeat(512 * 1024 + 1));
      return new Response("guest page");
    },
    websocket: { message(socket, message) { socket.send(socket.data.large
      ? "x".repeat(8 * 1024 + 1) : message); }, close() { closed++; } },
  });
  try {
    const driver = traffic(boundPort(server));
    await driver.ready();
    const handoff = await driver.handoff({ previewId: PREVIEW_ID, code: CODE });
    expect(handoff).toEqual({ status: 302, cookie: COOKIE });
    const page = await driver.http({ previewId: PREVIEW_ID, cookie: handoff.cookie, path: "/page" });
    expect(page.status).toBe(200);
    expect(Buffer.from(page.body).toString()).toBe("guest page");
    expect(page.location).toBeNull();
    const ws = await driver.webSocket({ previewId: PREVIEW_ID, cookie: handoff.cookie,
      path: "/hmr", subprotocol: "vite-hmr", challenge: "hmr-challenge" });
    expect(ws).toEqual({ status: 101, subprotocol: "vite-hmr", reply: "hmr-challenge" });
    for (let attempt = 0; attempt < 50 && closed < 1; attempt++) await Bun.sleep(10);
    expect(closed).toBe(1);
    await expect(driver.webSocket({ previewId: PREVIEW_ID, cookie: handoff.cookie,
      path: "/hmr-large", subprotocol: "vite-hmr", challenge: "hmr-challenge" }))
      .rejects.toThrow("limit");
    for (let attempt = 0; attempt < 50 && closed < 2; attempt++) await Bun.sleep(10);
    expect(closed).toBe(2);
    expect((await driver.handoff({ previewId: PREVIEW_ID, code: "b".repeat(64) })).status).toBe(404);
    expect(await driver.http({ previewId: PREVIEW_ID, cookie: handoff.cookie, path: "/redirect" }))
      .toMatchObject({ status: 302, location: "https://outside.example/" });
    await expect(driver.http({ previewId: PREVIEW_ID, cookie: handoff.cookie, path: "/large" }))
      .rejects.toThrow("limit");
    expect((await driver.http({ previewId: OTHER_ID, cookie: handoff.cookie, path: "/page" })).status).toBe(404);
    expect((await driver.http({ previewId: PREVIEW_ID, cookie: null, path: "/page" })).status).toBe(403);
    expect((await driver.http({ previewId: PREVIEW_ID, cookie: handoff.cookie, path: "/page", wrongHost: true })).status).toBe(404);
    expect((await driver.http({ previewId: PREVIEW_ID, cookie: handoff.cookie, path: "/page", malformedHost: true })).status).toBe(404);
    const denied = await driver.webSocket({ previewId: PREVIEW_ID, cookie: "__ezpreview=wrong", path: "/hmr",
      subprotocol: "vite-hmr", challenge: "no" });
    expect(denied).toEqual({ status: 403, subprotocol: null, reply: "" });
    const wrongOrigin = await driver.webSocket({ previewId: PREVIEW_ID, cookie: handoff.cookie, path: "/hmr",
      subprotocol: "vite-hmr", challenge: "no", wrongOrigin: true });
    expect(wrongOrigin).toEqual({ status: 403, subprotocol: null, reply: "" });
  } finally { server.stop(true); }
});

test("traffic driver refuses missing preview origin and an unready app before any preview action", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => new Response("not ready", { status: 503 }) });
  try {
    await expect(traffic(boundPort(server), "").ready()).rejects.toThrow("not configured");
    const driver = traffic(boundPort(server));
    await expect(driver.ready()).rejects.toThrow("not ready");
    await expect(driver.handoff({ previewId: PREVIEW_ID, code: CODE })).rejects.toThrow("not ready");
  } finally { server.stop(true); }
});

test("traffic driver rejects caller paths, credentials and oversized challenges before network effects", async () => {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: request => { hits++; return new Response(new URL(request.url).pathname === "/api/ready" ? "ready" : "effect"); } });
  try {
    const driver = traffic(boundPort(server));
    await driver.ready();
    expect(hits).toBe(1);
    await expect(driver.http({ previewId: PREVIEW_ID, cookie: "evil=secret", path: "/page" })).rejects.toThrow("cookie");
    await expect(driver.http({ previewId: PREVIEW_ID, cookie: COOKIE, path: "//outside.example" })).rejects.toThrow("path");
    await expect(driver.http({ previewId: PREVIEW_ID, cookie: COOKIE, path: "/page",
      wrongHost: true, malformedHost: true })).rejects.toThrow("Host mode");
    await expect(driver.handoff({ previewId: PREVIEW_ID, code: "wrong" })).rejects.toThrow("code");
    await expect(driver.webSocket({ previewId: PREVIEW_ID, cookie: COOKIE, path: "/hmr",
      subprotocol: "vite-hmr", challenge: "x".repeat(257) })).rejects.toThrow("challenge");
    await expect(driver.webSocket({ previewId: PREVIEW_ID, cookie: "evil=secret", path: "/hmr",
      subprotocol: "vite-hmr", challenge: "x" })).rejects.toThrow("cookie");
    expect(hits).toBe(1);
  } finally { server.stop(true); }
});


test("HTTPS Host denials retain the approved TLS identity and reject a wrong certificate name", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ez-preview-host-tls-"));
  const cert = join(directory, "cert.pem");
  const key = join(directory, "key.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
      "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,DNS:*.preview.localhost"], { stdio: "ignore" });
    // Extra CAs are read at process startup. Exercise the real driver without
    // disabling verification or changing the HTTP Host denial cases.
    const source = `
      import { strict as assert } from "node:assert";
      import { readFileSync } from "node:fs";
      import { configurePreviewHttpResponse } from "../runtime/preview/preview-http-policy";
import { IncusSandboxPreviewBackend } from "./incus-preview-backend";
import { createIncusPreviewTrafficDriver } from ${JSON.stringify(import.meta.dir + "/incus-preview-traffic.ts")};
      const id = ${JSON.stringify(PREVIEW_ID)};
      const hosts = [];
      const server = Bun.serve({hostname: "::", port: 0,
        tls: {cert: readFileSync(process.env.TEST_CERT), key: readFileSync(process.env.TEST_KEY)},
        fetch(request) {
          const host = request.headers.get("host"); hosts.push(host);
          return new Response("proof", {status: new URL(request.url).pathname === "/api/ready"
            || host === id + ".preview.localhost:" + server.port ? 200 : 404});
        }});
      try {
        const driver = base => createIncusPreviewTrafficDriver({env: {
          EZCORP_PUBLIC_URL: "https://localhost:" + server.port, EZCORP_PREVIEW_APP_HOST: base}});
        const traffic = driver("localhost"); await traffic.ready();
        const request = {previewId: id, cookie: null, path: "/proof"};
        assert.equal((await traffic.http(request)).status, 200);
        assert.equal((await traffic.http({...request, wrongHost: true})).status, 404);
        assert.equal((await traffic.http({...request, malformedHost: true})).status, 404);
        assert(hosts.includes("invalid.preview.invalid:" + server.port));
        assert(hosts.includes("invalid!.preview.localhost:" + server.port));
        const wrongCertificate = driver("wrong.example"); await wrongCertificate.ready();
        const before = hosts.length;
        await assert.rejects(wrongCertificate.http(request), /Preview request failed/);
        assert.equal(hosts.length, before);
      } finally { server.stop(true); }
    `;
    const child = Bun.spawn([process.execPath, "-e", source], { env: { ...process.env,
      NODE_EXTRA_CA_CERTS: cert, TEST_CERT: cert, TEST_KEY: key }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);


test("plain HTTP relay preserves its largest supported body across real delayed RPCs and Bun ingress", async () => {
  const body = "x".repeat(512 * 1024);
  const output = Buffer.from(JSON.stringify({ status: 200, headers: [], body: Buffer.from(body).toString("base64") }));
  const calls: string[] = [];
  const binding = { projectId: "p", workspaceId: "b", connectionId: "c", providerId: "incus" as const,
    generation: 1, presetId: "compose", releaseDigest: "a".repeat(64), presetDigest: "b".repeat(64), effectiveSettingsDigest: "c".repeat(64) };
  const backend = new IncusSandboxPreviewBackend({ async call(input) {
    calls.push(input.action);
    expect(input.signal?.aborted).toBe(false);
    await Bun.sleep(3_100);
    if (input.action === "process.start") return { ok: true, processId: "p", bootId: "boot" };
    if (input.action === "process.inspect") return { ok: true, process: { state: "succeeded" } };
    const offset = (input.payload.cursor as { offsetBytes: number }).offsetBytes;
    expect(input.payload.maxBytes).toBe(64 * 1024);
    const page = output.subarray(offset, offset + 64 * 1024);
    return { ok: true, chunks: [{ stream: "stdout", dataBase64: page.toString("base64") }],
      eof: offset + page.length === output.length, nextCursor: { offsetBytes: offset + page.length } };
  } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 10, async fetch(request, bunServer) {
    if (new URL(request.url).pathname === "/api/ready") return new Response("ready");
    configurePreviewHttpResponse({ server: bunServer, request });
    return backend.serve({ binding, previewId: PREVIEW_ID, userId: "owner", targetPort: 3000,
      requestPath: "/proof", request, expiresAt: new Date(Date.now() + 90_000) });
  } });
  try {
    const driver = traffic(boundPort(server));
    await driver.ready();
    const started = Date.now();
    const response = await driver.http({ previewId: PREVIEW_ID, cookie: COOKIE, path: "/proof" });
    expect(response.status).toBe(200);
    expect(Buffer.from(response.body).toString()).toBe(body);
    expect(calls).toEqual(["process.start", "process.inspect", ...Array(11).fill("process.readOutput")]);
    expect(Date.now() - started).toBeGreaterThan(40_000);
  } finally { server.stop(true); }
}, 65_000);


test("HTTP transport diagnostics retain only a fixed phase and safe error code", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/api/ready") { response.end("ready"); return; }
    request.socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test listener");
    const driver = traffic(address.port);
    await driver.ready();
    await expect(driver.http({ previewId: PREVIEW_ID, cookie: COOKIE, path: "/private-path" }))
      .rejects.toThrow("Preview request failed [http:ECONNRESET]");
  } finally { server.close(); }
});
