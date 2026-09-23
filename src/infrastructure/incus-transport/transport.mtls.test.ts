import { expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { IncusTransportError, type IncusTransportRequest } from "../../../extensions/incus-sandbox/transport";
import { HostIncusProbeTransport } from "./transport";

const fixture = (name: string) => readFileSync(new URL(`./mtls-fixtures/${name}`, import.meta.url), "utf8");
const serverCert = fixture("server-cert.pem");
const serverKey = fixture("server-key.pem");
const otherServerCert = fixture("other-server-cert.pem");
const otherServerKey = fixture("other-server-key.pem");
const substituteServerCert = fixture("substitute-server-cert.pem");
const substituteServerKey = fixture("substitute-server-key.pem");
const clientCa = fixture("client-ca.pem");
const clientCert = fixture("client-cert.pem");
const clientKey = fixture("client-key.pem");
const wrongClientCert = fixture("wrong-client-cert.pem");
const wrongClientKey = fixture("wrong-client-key.pem");
const fingerprint = (pem: string) => createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");

const scope = { providerInstallationId: "installation-a", providerReleaseId: "release-a", revision: 1 };

async function localIncusServer(
  cert = serverCert,
  key = serverKey,
  responseMode: "normal" | "chunked" | "oversized-header" | "oversized-body" = "normal",
): Promise<{
  endpoint: string;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server: Server = createServer({
    cert, key, ca: clientCa, requestCert: true, rejectUnauthorized: true,
  }, (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const path = new URL(request.url ?? "/", "https://127.0.0.1").pathname;
    const metadata = path === "/1.0"
      ? { api_version: "1.0", environment: { kernel_architecture: "x86_64", server_version: "6.0.6" } }
      : path === "/1.0/projects/sandbox"
        ? { name: "sandbox", config: { restricted: "true" } }
        : { name: "ezharness" };
    response.setHeader("content-type", "application/json");
    const body = JSON.stringify({ type: "sync", status_code: 200, metadata });
    if (responseMode === "oversized-header") response.setHeader("x-padding", "x".repeat(70_000));
    if (responseMode === "oversized-body") {
      response.end("x".repeat(70_000));
    } else if (responseMode === "chunked") {
      response.setHeader("transfer-encoding", "chunked");
      response.write(body.slice(0, 12));
      response.end(body.slice(12));
    } else {
      response.end(body);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `https://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function probe(endpoint: string, cert = serverCert, clientIdentity = {
  clientCertificatePem: clientCert, privateKeyPem: clientKey,
}, pin = fingerprint(cert)) {
  const transport = new HostIncusProbeTransport({ resolveForHost: async () => ({
    endpoint,
    serverCertificatePem: cert,
    project: "sandbox",
    ...clientIdentity,
  }) }, scope);
  const command: IncusTransportRequest = {
    action: "probe",
    connectionId: "connection-a",
    deadlineMs: Date.now() + 10_000,
    pins: { connectionId: "connection-a", serverCertificateSha256: pin, project: "sandbox", profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" },
    tags: { managedBy: "ezharness-incus-sandbox", connectionId: "connection-a" },
    payload: { allocate: false },
  };
  return transport.request(command);
}

test("real TLS probe accepts a pinned server and approved client identity", async () => {
  const server = await localIncusServer();
  try {
    const result = await probe(server.endpoint);
    expect(result.backendVersion).toBe("6.0.6");
    expect(result.serverCertificateSha256).toBe(fingerprint(serverCert));
    expect(server.requests).toEqual([
      "GET /1.0?project=sandbox",
      "GET /1.0/projects/sandbox",
      "GET /1.0/profiles/ezharness?project=sandbox",
    ]);
  } finally {
    await server.close();
  }
}, 15_000);

test("real TLS probe rejects missing and unapproved client certificates", async () => {
  const server = await localIncusServer();
  try {
    for (const identity of [
      { clientCertificatePem: "", privateKeyPem: "" },
      { clientCertificatePem: wrongClientCert, privateKeyPem: wrongClientKey },
    ]) {
      await expect(probe(server.endpoint, serverCert, identity)).rejects.toMatchObject({ kind: "unavailable" });
    }
    expect(server.requests).toHaveLength(0);
  } finally {
    await server.close();
  }
}, 15_000);

test("real TLS probe rejects a certificate pin mismatch before network I/O", async () => {
  const server = await localIncusServer();
  try {
    await expect(probe(server.endpoint, serverCert, undefined, fingerprint(otherServerCert))).rejects.toMatchObject({ kind: "permission" });
    expect(server.requests).toHaveLength(0);
  } finally {
    await server.close();
  }
}, 15_000);

test("real TLS probe rejects a peer certificate that differs from the stored pin", async () => {
  const server = await localIncusServer(otherServerCert, otherServerKey);
  try {
    await expect(probe(server.endpoint)).rejects.toMatchObject({ kind: "unavailable" });
    expect(server.requests).toHaveLength(0);
  } finally {
    await server.close();
  }
}, 15_000);

test("real TLS probe rejects a different leaf signed by the pinned certificate", async () => {
  const server = await localIncusServer(substituteServerCert, substituteServerKey);
  try {
    await expect(probe(server.endpoint)).rejects.toMatchObject({ kind: "unavailable" });
    expect(server.requests).toHaveLength(0);
  } finally {
    await server.close();
  }
}, 15_000);

test("real TLS probe rejects a server certificate with the wrong hostname", async () => {
  const server = await localIncusServer(otherServerCert, otherServerKey);
  try {
    const failure = await probe(server.endpoint, otherServerCert).catch((error: unknown) => error) as IncusTransportError;
    expect(failure).toBeInstanceOf(IncusTransportError);
    expect(failure.kind).toBe("permission");
    expect(server.requests).toHaveLength(0);
  } finally {
    await server.close();
  }
}, 15_000);

test("real TLS probe accepts chunked Incus JSON over the verified socket", async () => {
  const server = await localIncusServer(serverCert, serverKey, "chunked");
  try {
    const result = await probe(server.endpoint);
    expect(result.backendVersion).toBe("6.0.6");
    expect(server.requests).toHaveLength(3);
  } finally {
    await server.close();
  }
}, 15_000);

test("real TLS probe bounds response headers and body", async () => {
  for (const responseMode of ["oversized-header", "oversized-body"] as const) {
    const server = await localIncusServer(serverCert, serverKey, responseMode);
    try {
      await expect(probe(server.endpoint)).rejects.toMatchObject({ kind: "resource_exhausted", effect: "none" });
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }
}, 15_000);
