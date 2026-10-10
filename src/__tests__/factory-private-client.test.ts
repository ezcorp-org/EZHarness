import { afterAll, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGatewayTransport } from "@ezcorp/factory-transport";
import { certificates } from "./helpers/factory-certificates";
import { startFactoryPrivateHttps } from "../factory/private-https";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });

test("the Bun client uses the shared mTLS transport against the production private server", async () => {
  const certs = await certificates(directories);
  const directory = directories.at(-1)!;
  const tokenPath = join(directory, "service-token");
  await writeFile(tokenPath, "fixture-service-token", { mode: 0o600 });
  const server = startFactoryPrivateHttps({
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    async handle(request) {
      if (request.peerIdentity !== "tenant-a" || request.headers.authorization !== "Bearer fixture-service-token") return { status: 403, body: Buffer.from("{}") };
      return { status: 200, body: Buffer.from(JSON.stringify({ path: request.path, method: request.method, body: JSON.parse(request.body.toString("utf8")) })) };
    },
  });
  try {
    const tls = { caPath: join(directory, "ca.pem"), certificatePath: join(directory, "client.pem"), privateKeyPath: join(directory, "client.key"), serviceTokenPath: tokenPath };
    const client = await createGatewayTransport({ baseUrl: server.url, tls, serverName: "localhost", requestTimeoutMs: 2000 });
    const response = await client.request("POST", "/v1/pool/requests", { reservationId: "reservation-1" });
    expect(JSON.parse(response.body.toString("utf8"))).toEqual({ path: "/v1/pool/requests", method: "POST", body: { reservationId: "reservation-1" } });
    await expect(client.request("POST", `${server.url}/foreign`, {})).rejects.toThrow("path");
    const foreign = await createGatewayTransport({ baseUrl: server.url, tls: { ...tls, certificatePath: join(directory, "foreign.pem"), privateKeyPath: join(directory, "foreign.key") }, serverName: "localhost" });
    await expect(foreign.request("POST", "/v1/pool/requests", {})).rejects.toThrow("HTTP 403");
    await writeFile(tokenPath, "revoked-token", { mode: 0o600 });
    await expect(client.request("POST", "/v1/pool/requests", {})).rejects.toThrow("HTTP 403");
  } finally { server.stop(); }
});

test("a request its peer never answers fails at its timeout rather than hanging", async () => {
  const certs = await certificates(directories);
  const directory = directories.at(-1)!;
  const tokenPath = join(directory, "service-token");
  await writeFile(tokenPath, "fixture-service-token", { mode: 0o600 });
  let arrived: () => void = () => {};
  const received = new Promise<void>((resolve) => { arrived = resolve; });
  const silent = startFactoryPrivateHttps({
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    handle: () => { arrived(); return new Promise(() => {}); },
  });
  try {
    const tls = { caPath: join(directory, "ca.pem"), certificatePath: join(directory, "client.pem"), privateKeyPath: join(directory, "client.key"), serviceTokenPath: tokenPath };
    const client = await createGatewayTransport({ baseUrl: silent.url, tls, serverName: "localhost", requestTimeoutMs: 200 });
    const waiting = client.request("POST", "/v1/pool/requests", {});
    await received;
    await expect(waiting).rejects.toThrow("factory gateway request timed out");
  } finally { silent.stop(); }
});

// An IP endpoint with no DNS server name: node:https must verify the listener's certificate against the IP itself.
// Bun 1.4 (like Node) refuses an IP literal as the TLS server name (ERR_INVALID_ARG_VALUE, RFC 6066), so the
// transport sends no server name for the endpoint's own IP; the certificate check against that IP is unchanged.
async function ipEndpoint(serverAltNames?: string) {
  const certs = await certificates(directories, "tenant-a", serverAltNames ? { serverAltNames } : {});
  const directory = directories.at(-1)!;
  const tokenPath = join(directory, "service-token");
  await writeFile(tokenPath, "fixture-service-token", { mode: 0o600 });
  const server = startFactoryPrivateHttps({
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    handle: async () => ({ status: 200, body: Buffer.from("{\"ok\":true}") }),
  });
  const tls = { caPath: join(directory, "ca.pem"), certificatePath: join(directory, "client.pem"), privateKeyPath: join(directory, "client.key"), serviceTokenPath: tokenPath };
  return { server, tls, baseUrl: server.url };
}

test("an IP endpoint with no server name is verified against the certificate's IP and answered", async () => {
  const { server, tls, baseUrl } = await ipEndpoint();
  try {
    expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
    const client = await createGatewayTransport({ baseUrl, tls, requestTimeoutMs: 2000 });
    expect((await client.request("GET", "/v1/health")).statusCode).toBe(200);
    // The endpoint's own IP given explicitly is the same identity: answered too.
    const explicit = await createGatewayTransport({ baseUrl, tls, serverName: "127.0.0.1", requestTimeoutMs: 2000 });
    expect((await explicit.request("GET", "/v1/health")).statusCode).toBe(200);
  } finally { server.stop(); }
});

test("an IP endpoint whose certificate does not name that IP is still refused", async () => {
  const { server, tls, baseUrl } = await ipEndpoint("DNS:localhost");
  try {
    const client = await createGatewayTransport({ baseUrl, tls, requestTimeoutMs: 2000 });
    await expect(client.request("GET", "/v1/health")).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  } finally { server.stop(); }
});

test("an explicit IP server name that differs from the endpoint host fails by name", async () => {
  const { server, tls, baseUrl } = await ipEndpoint();
  try {
    await expect(createGatewayTransport({ baseUrl, tls, serverName: "127.0.0.2", requestTimeoutMs: 2000 }))
      .rejects.toThrow("factory_transport_server_name_ip_mismatch");
  } finally { server.stop(); }
});
