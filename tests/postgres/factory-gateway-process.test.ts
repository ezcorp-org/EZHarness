/**
 * The execution gateway process composes over a real installation database.
 *
 * The gateway opens the database through the product's own connection module,
 * which reads DATABASE_URL at module load; this file therefore never imports
 * that module itself before the gateway does, and it creates and drops its own
 * scratch database rather than sharing one.
 */
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { makeFactoryPrivateRoot, makeFactoryTestAuthority, removeFactoryPrivateRoot } from "../../src/__tests__/helpers/factory-private-root";
import { issueFactoryCertificate } from "../../src/factory/provisioning/certificates";
import { factoryGatewayProductionDependencies, parseFactoryGatewayProcessConfig } from "../../src/factory/gateway-process";

const url = process.env.FACTORY_TEST_POSTGRES_URL;
if (!url) throw new Error("FACTORY_TEST_POSTGRES_URL is required for the gateway process conformance.");
const database = `factory_gateway_${randomUUID().replaceAll("-", "")}`;
let admin: SQL;
let root: string;

beforeAll(async () => {
  admin = new SQL(url!, { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  root = await makeFactoryPrivateRoot();
});

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
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
  const target = new URL(url!); target.pathname = `/${database}`;
  const config = parseFactoryGatewayProcessConfig({
    schemaVersion: "factory.gateway-process.v1", installationId: "gateway-installation", tenantId: "tenant-01", hostname: "127.0.0.1", port: 0,
    tls: { caPath: "/unused/ca.crt", certificatePath: "/unused/server.crt", privateKeyPath: "/unused/server.key" },
    attemptTokenSecretPath: "/unused/attempt", databaseUrlPath: "/unused/db", interpreterCompatibility: "factory-kernel.v1",
  });
  const listener = await factoryGatewayProductionDependencies.start(config, { databaseUrl: target.toString(), attemptTokenSecret: "a".repeat(64), tls: { key: server.privateKeyPem, cert: server.certificatePem, ca: authority.certificatePem } });
  try {
    const port = Number(new URL(listener.url).port);
    expect(await call(port, { key: client.privateKeyPem, cert: client.certificatePem, ca: authority.certificatePem })).toBe(401);
    const probe = new SQL(target.toString(), { max: 1 });
    try { expect((await probe`SELECT to_regclass('public.factory_executions') IS NOT NULL AS migrated`)[0]).toEqual({ migrated: true }); }
    finally { await probe.close(); }
  } finally {
    listener.stop();
    await listener.close();
  }
});
