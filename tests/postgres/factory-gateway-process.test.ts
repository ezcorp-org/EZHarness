/**
 * The execution gateway process composes over a real installation database.
 *
 * The gateway opens the database through the product's own connection module,
 * which reads DATABASE_URL once, at module load, and the test preload loads it
 * before any test runs. The runner must therefore name the gateway's database
 * in DATABASE_URL when the process starts: CI names its service database, and
 * the local producer names a scratch database, which this file creates when it
 * is missing and drops only if it created it.
 */
import { request as httpsRequest } from "node:https";
import { createServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { makeFactoryPrivateRoot, makeFactoryTestAuthority, removeFactoryPrivateRoot } from "../../src/__tests__/helpers/factory-private-root";
import { issueFactoryCertificate } from "../../src/factory/provisioning/certificates";
import { factoryGatewayProductionDependencies, parseFactoryGatewayProcessConfig } from "../../src/factory/gateway-process";

const url = process.env.FACTORY_TEST_POSTGRES_URL;
if (!url) throw new Error("FACTORY_TEST_POSTGRES_URL is required for the gateway process conformance.");
const gatewayUrl = process.env.DATABASE_URL;
if (!gatewayUrl) throw new Error("DATABASE_URL must name the gateway's database when the test process starts.");
const target = new URL(gatewayUrl);
const database = decodeURIComponent(target.pathname.slice(1));
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new Error("DATABASE_URL names a database this test cannot quote safely.");
let admin: SQL;
let root: string;
let created = false;

beforeAll(async () => {
  admin = new SQL(url!, { max: 1 });
  if ((await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`).length === 0) { await admin.unsafe(`CREATE DATABASE "${database}"`); created = true; }
  root = await makeFactoryPrivateRoot();
});

afterAll(async () => {
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.close();
  await removeFactoryPrivateRoot(root);
});

function call(port: number, tls: { key: string; cert: string; ca: string }): Promise<number> {
  return new Promise((settle, reject) => {
    const request = httpsRequest({ host: "127.0.0.1", port, path: "/internal/factory/v1/executions/attempt-1", method: "GET", servername: "localhost", key: tls.key, cert: tls.cert, ca: tls.ca, headers: { "x-ezcorp-factory-version": "1" } }, (response) => { response.resume(); response.once("end", () => settle(response.statusCode ?? 0)); });
    request.once("error", reject);
    request.end();
  });
}

test("the production gateway migrates its database, binds mutual TLS, and refuses a call with no attempt token", async () => {
  const authority = await makeFactoryTestAuthority(root, "gateway-test-ca");
  const server = await issueFactoryCertificate(authority, { subject: "localhost", usage: "server", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"] });
  const client = await issueFactoryCertificate(authority, { subject: "tenant-01", usage: "client" });
  // The config refuses port 0, as production must name a port; take a free one from the kernel.
  const port = await new Promise<number>((settle, reject) => {
    const probe = createServer().once("error", reject).listen(0, "127.0.0.1", () => { const bound = (probe.address() as AddressInfo).port; probe.close(() => settle(bound)); });
  });
  const config = parseFactoryGatewayProcessConfig({
    schemaVersion: "factory.gateway-process.v1", installationId: "gateway-installation", tenantId: "tenant-01", hostname: "127.0.0.1", port,
    tls: { caPath: "/unused/ca.crt", certificatePath: "/unused/server.crt", privateKeyPath: "/unused/server.key" },
    attemptTokenSecretPath: "/unused/attempt", databaseUrlPath: "/unused/db", interpreterCompatibility: "factory-kernel.v1",
  });
  const listener = await factoryGatewayProductionDependencies.start(config, { databaseUrl: target.toString(), attemptTokenSecret: "a".repeat(64), tls: { key: server.privateKeyPem, cert: server.certificatePem, ca: authority.certificatePem } });
  try {
    expect(Number(new URL(listener.url).port)).toBe(port);
    expect(await call(port, { key: client.privateKeyPem, cert: client.certificatePem, ca: authority.certificatePem })).toBe(401);
    const probe = new SQL(target.toString(), { max: 1 });
    try { expect((await probe`SELECT to_regclass('public.factory_executions') IS NOT NULL AS migrated`)[0]).toEqual({ migrated: true }); }
    finally { await probe.close(); }
  } finally {
    listener.stop();
    await listener.close();
  }
});
