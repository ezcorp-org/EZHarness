import { expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { IncusTransportError, type IncusTransportRequest } from "../../../extensions/incus-sandbox/transport";
import { HostIncusProbeTransport } from "./transport";

const certificate = readFileSync(new URL("./test-server.pem", import.meta.url), "utf8");
const fingerprint = createHash("sha256").update(new X509Certificate(certificate).raw).digest("hex");
const secret = "private-key-must-never-escape";
const pins = { connectionId: "connection-a", serverCertificateSha256: fingerprint, project: "sandbox", profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" };
const command: IncusTransportRequest = { action: "probe", connectionId: "connection-a", deadlineMs: Date.now() + 30_000, pins, tags: { managedBy: "ezharness-incus-sandbox", connectionId: "connection-a" }, payload: { allocate: false } };
const scope = { providerInstallationId: "installation-a", providerReleaseId: "release-a", revision: 1 };
const connection = { endpoint: "https://incus.example:8443", serverCertificatePem: certificate, project: "sandbox", clientCertificatePem: "client-cert", privateKeyPem: secret };

type ProbeFetch = NonNullable<ConstructorParameters<typeof HostIncusProbeTransport>[2]>;

function fixture(options: { resolve?: () => Promise<typeof connection>; fetch?: ProbeFetch } = {}) {
  const calls: unknown[] = [];
  const resolver = { resolveForHost: async (input: unknown) => { calls.push(input); return options.resolve ? options.resolve() : connection; } };
  const transport = new HostIncusProbeTransport(resolver, scope, options.fetch);
  return { transport, calls };
}

const liveServerEnvironment = {
  kernel_architecture: "x86_64",
  architectures: ["x86_64", "i686"],
  server_architecture: null,
  server_version: "6.0.6",
};

function readOnlyProbeResponse(url: string, environment: Record<string, unknown> = liveServerEnvironment): Response {
  const path = new URL(url).pathname;
  const metadata = path === "/1.0" ? { api_version: "1.0", environment }
    : path.includes("projects") ? { name: "sandbox", config: { restricted: "true" } }
    : { name: "ezharness" };
  return Response.json({ type: "sync", status_code: 200, metadata });
}

test("unsupported mutation is rejected before credential lookup or HTTP", async () => {
  let requests = 0;
  const { transport, calls } = fixture({ fetch: async () => { requests++; throw new Error("unreachable"); } });
  await expect(transport.request({ ...command, action: "instance.create" })).rejects.toMatchObject({ kind: "unsupported", effect: "none" });
  expect(calls).toHaveLength(0);
  expect(requests).toBe(0);
});

test("an allocating probe payload is denied before credential lookup", async () => {
  const { transport, calls } = fixture();
  await expect(transport.request({ ...command, payload: { allocate: true } })).rejects.toMatchObject({ kind: "invalid", effect: "none" });
  expect(calls).toHaveLength(0);
});

test("unknown connection fails closed before HTTP and sanitizes resolver errors", async () => {
  let requests = 0;
  const { transport } = fixture({ resolve: async () => { throw new Error(`unknown ${secret}`); }, fetch: async () => { requests++; throw new Error("unreachable"); } });
  const failure = await transport.request(command).catch((error: unknown) => error) as IncusTransportError;
  expect(failure).toBeInstanceOf(IncusTransportError);
  expect(failure.kind).toBe("not_found");
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect(String(failure)).not.toContain(secret);
  expect(requests).toBe(0);
});

test("a server certificate pin mismatch fails before HTTP", async () => {
  let requests = 0;
  const { transport } = fixture({ fetch: async () => { requests++; throw new Error("unreachable"); } });
  await expect(transport.request({ ...command, pins: { ...pins, serverCertificateSha256: "a".repeat(64) } })).rejects.toMatchObject({ kind: "permission" });
  expect(requests).toBe(0);
});

test("a pinned certificate for another endpoint is rejected before HTTP", async () => {
  let requests = 0;
  const { transport } = fixture({
    resolve: async () => ({ ...connection, endpoint: "https://127.0.0.1:8443" }),
    fetch: async () => { requests++; throw new Error("unreachable"); },
  });
  await expect(transport.request(command)).rejects.toMatchObject({ kind: "permission", effect: "none" });
  expect(requests).toBe(0);
});

test("redirect is rejected and private key never reaches the error sink", async () => {
  const { transport } = fixture({ fetch: async () => new Response(null, { status: 302, headers: { location: `https://evil.example/${secret}` } }) });
  const failure = await transport.request(command).catch((error: unknown) => error) as IncusTransportError;
  expect(failure.kind).toBe("permission");
  expect(JSON.stringify(failure)).not.toContain(secret);
});

test("oversized response is rejected while streaming", async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(70_000)); controller.close(); } });
  const { transport } = fixture({ fetch: async () => new Response(body) });
  await expect(transport.request(command)).rejects.toMatchObject({ kind: "resource_exhausted" });
});

test("probe uses only fixed GET routes and reports unverified guest controls as false", async () => {
  const routes: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    routes.push(`${init.method} ${new URL(url).pathname}${new URL(url).search}`);
    expect(init.redirect).toBe("manual");
    return readOnlyProbeResponse(url);
  };
  const { transport } = fixture({ fetch: fetcher as ProbeFetch });
  const result = await transport.request({ ...command, payload: { url: "https://evil.example", method: "POST", path: "/1.0/instances" } });
  expect(routes).toEqual(["GET /1.0?project=sandbox", "GET /1.0/projects/sandbox", "GET /1.0/profiles/ezharness?project=sandbox"]);
  expect(result.helperVersion).toBe("unverified");
  expect(result.backendApi).toBe("incus.v1");
  expect(result.architecture).toBe("amd64");
  expect(result.controls.atomicFileReplace).toBe(false);
  expect(result.controls.durableProcesses).toBe(false);
  expect(result.nestedCompose).toBe(false);
});

test("probe rejects a server response without supported kernel architecture", async () => {
  const { transport } = fixture({ fetch: (url) => Promise.resolve(readOnlyProbeResponse(url, {
    server_architecture: "x86_64", server_version: "6.0.6",
  })) });
  await expect(transport.request(command)).rejects.toMatchObject({ kind: "unavailable" });
});

test("HTTP failures do not leak client key through thrown error", async () => {
  const { transport } = fixture({ fetch: async () => { throw new Error(`TLS failed: ${secret}`); } });
  const failure = await transport.request(command).catch((error: unknown) => error) as IncusTransportError;
  expect(failure.kind).toBe("unavailable");
  expect(String(failure)).not.toContain(secret);
  expect(JSON.stringify(failure)).not.toContain(secret);
});

test("TLS options require the pinned peer certificate and the stored client identity", async () => {
  let checked = false;
  const fetcher = async (_url: string, init: RequestInit & { tls: { key: string; cert: string; ca: string; checkServerIdentity: (host: string, peer: unknown) => Error | undefined } }) => {
    checked = true;
    expect(init.tls.key).toBe(secret);
    expect(init.tls.cert).toBe("client-cert");
    expect(init.tls.ca).toBe(certificate);
    expect(init.tls.checkServerIdentity("incus.example", { subject: { CN: "incus.example" }, raw: Buffer.from("wrong") })).toBeInstanceOf(Error);
    return new Response(null, { status: 503 });
  };
  const { transport } = fixture({ fetch: fetcher as ProbeFetch });
  await expect(transport.request(command)).rejects.toMatchObject({ kind: "unavailable" });
  expect(checked).toBe(true);
});

test("host cancellation bounds a stalled request", async () => {
  const cancellation = new AbortController();
  const transport = new HostIncusProbeTransport(
    { resolveForHost: async () => connection },
    { ...scope, signal: cancellation.signal },
    async () => new Promise<Response>(() => undefined),
  );
  const pending = transport.request(command);
  await Promise.resolve();
  cancellation.abort();
  await expect(pending).rejects.toMatchObject({ kind: "deadline" });
});
