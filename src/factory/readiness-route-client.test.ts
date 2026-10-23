import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { certificates } from "../__tests__/helpers/factory-certificates";
import { startFactoryPrivateHttps, type FactoryPrivateRequest, type FactoryPrivateResponse } from "./private-https";
import { createFactoryReadinessRouteClient, factoryHostReadinessSources } from "./readiness-route-client";

const directories: string[] = [];
const record = { schemaVersion: "factory.pool-readiness.v2", poolId: "pool-a", lifecycle: "ready", observedAtMs: 1, databaseReady: true, schemaReady: true, listenerReady: true };
let server: ReturnType<typeof startFactoryPrivateHttps>;
let answer: FactoryPrivateResponse;
let calls: FactoryPrivateRequest[];
let tls: { caPath: string; certificatePath: string; privateKeyPath: string; serviceTokenPath: string };

beforeAll(async () => {
  const certs = await certificates(directories);
  const directory = directories.at(-1)!;
  await writeFile(join(directory, "token"), "readiness-token", { mode: 0o600 });
  calls = [];
  server = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, async handle(input) { calls.push(input); return answer; } });
  tls = { caPath: join(directory, "ca.pem"), certificatePath: join(directory, "client.pem"), privateKeyPath: join(directory, "client.key"), serviceTokenPath: join(directory, "token") };
});
afterAll(async () => { server?.stop(); await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))); });

describe("createFactoryReadinessRouteClient (W4H-35)", () => {
  test("reads a shared service's own record with one bodiless GET over mutual TLS and the service token", async () => {
    const client = await createFactoryReadinessRouteClient({ baseUrl: server.url, serverName: "localhost", requestTimeoutMs: 2_000, tls }, "/v1/pool/readiness");
    answer = { status: 200, body: Buffer.from(JSON.stringify(record)) };
    expect(await client.read(new AbortController().signal)).toEqual(record);
    expect(calls.map((call) => [call.method, call.path, call.body.byteLength, call.peerIdentity, call.headers.authorization])).toEqual([["GET", "/v1/pool/readiness", 0, "tenant-a", "Bearer readiness-token"]]);
  });

  test("any other answer is a failure, never a record", async () => {
    const client = await createFactoryReadinessRouteClient({ baseUrl: server.url, serverName: "localhost", requestTimeoutMs: 2_000, tls }, "/v1/host/readiness");
    for (const response of [{ status: 503, body: Buffer.from('{"error":"unavailable"}') }, { status: 200, body: Buffer.from("not json") }, { status: 204, body: Buffer.alloc(0) }]) {
      answer = response;
      await expect(client.read(new AbortController().signal)).rejects.toThrow();
    }
  });
});

describe("factoryHostReadinessSources (W4H-35)", () => {
  test("the pool's record over the pool transport and the supervisor's over the host launch transport", async () => {
    const config = {
      pool: { baseUrl: server.url, serviceTokenPath: tls.serviceTokenPath, tls: { caPath: tls.caPath, certificatePath: tls.certificatePath, privateKeyPath: tls.privateKeyPath } },
      hostLaunch: { baseUrl: server.url, serverName: "localhost", attemptTokenSecretPath: "/unused", tls },
    };
    const sources = await factoryHostReadinessSources(config);
    answer = { status: 200, body: Buffer.from(JSON.stringify(record)) };
    const before = calls.length;
    await sources.pool.read(new AbortController().signal);
    await sources.supervisor.read(new AbortController().signal);
    expect(calls.slice(before).map((call) => call.path)).toEqual(["/v1/pool/readiness", "/v1/host/readiness"]);
  });

  test("a document with no host launch transport cannot compose the supervisor's source", async () => {
    const config = { pool: { baseUrl: server.url, serviceTokenPath: tls.serviceTokenPath, tls: { caPath: tls.caPath, certificatePath: tls.certificatePath, privateKeyPath: tls.privateKeyPath } } };
    await expect(factoryHostReadinessSources(config)).rejects.toThrow("factory_host_readiness_transport_missing");
  });
});
