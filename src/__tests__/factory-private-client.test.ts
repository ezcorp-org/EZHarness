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
