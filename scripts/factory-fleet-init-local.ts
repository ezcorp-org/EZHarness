#!/usr/bin/env bun
/**
 * Write a local fleet's settings for this host, and create its control database.
 *
 *   FACTORY_TEST_POSTGRES_URL=... EZCORP_FACTORY_STORAGE_SECRETS_DIR=... \
 *     bun scripts/factory-fleet-init-local.ts --fleet w16 --root /run/user/$UID/ezcorp-factory-w16 \
 *       --image localhost/ezcorp-factory@sha256:... --revision <sha> [--port-base 31000]
 *
 * Only this host's references go into the settings document; the two URLs
 * that carry credentials are written beside it as private files, and the
 * document names their paths. The control database is created with its own
 * login role, so the control plane never connects as the cluster admin.
 *
 * The shared stores are used as they are: their server identity files are
 * read, never written, and nothing here starts, stops, or reconfigures them.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { SQL } from "bun";
import { openFactoryPrivateDirectory, replaceFactoryPrivateFile, ensureFactoryPrivateFile, readFactoryPrivateText, factoryPrivatePath } from "../src/factory/provisioning/secret-files";
import { parseFactoryFleetSettings, type FactoryFleetSettings } from "../src/factory/provisioning/fleet";

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? fallback : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const fleetId = flag("--fleet");
const root = resolve(flag("--root"));
const image = flag("--image");
const revision = flag("--revision");
const portBase = Number(flag("--port-base", "31000"));
const adminUrl = process.env.FACTORY_TEST_POSTGRES_URL;
const storageSecrets = process.env.EZCORP_FACTORY_STORAGE_SECRETS_DIR;
if (!adminUrl || !storageSecrets) throw new Error("FACTORY_TEST_POSTGRES_URL and EZCORP_FACTORY_STORAGE_SECRETS_DIR are required");

const operator = resolve(root, "operator");
const directory = await openFactoryPrivateDirectory(operator);
try {
  await replaceFactoryPrivateFile(factoryPrivatePath(operator, "product-admin-url"), `${adminUrl}\n`);
  await ensureFactoryPrivateFile(directory, "control-password", () => `${randomBytes(32).toString("base64url")}\n`);
  const controlPassword = (await readFactoryPrivateText(directory, "control-password")).trim();
  const controlDatabase = `factory_control_${fleetId.replaceAll("-", "_")}`;
  const controlRole = `${controlDatabase}_role`;
  const admin = new SQL(adminUrl, { max: 1 });
  try {
    const role = (await admin`SELECT 1 FROM pg_roles WHERE rolname = ${controlRole}`)[0];
    const statement = (await admin`SELECT format(${role ? "ALTER ROLE %I LOGIN PASSWORD %L" : "CREATE ROLE %I LOGIN PASSWORD %L"}, ${controlRole}::text, ${controlPassword}::text) AS statement`)[0] as { statement: string };
    await admin.unsafe(statement.statement);
    if (!(await admin`SELECT 1 FROM pg_database WHERE datname = ${controlDatabase}`)[0]) await admin.unsafe(`CREATE DATABASE "${controlDatabase}" OWNER "${controlRole}"`);
    await admin.unsafe(`REVOKE ALL ON DATABASE "${controlDatabase}" FROM PUBLIC`);
  } finally { await admin.close(); }
  const controlUrl = new URL(adminUrl); controlUrl.pathname = `/${controlDatabase}`; controlUrl.username = controlRole; controlUrl.password = controlPassword;
  await replaceFactoryPrivateFile(factoryPrivatePath(operator, "control-database-url"), `${controlUrl.toString()}\n`);
} finally { await directory.close(); }

const database = new URL(adminUrl);
const settings: FactoryFleetSettings = parseFactoryFleetSettings({
  schemaVersion: "factory.fleet.v1",
  fleetId,
  profile: "compose",
  roots: { operator, secrets: resolve(root, "installations"), runtime: resolve(root, "runtime") },
  control: { databaseUrlPath: factoryPrivatePath(operator, "control-database-url") },
  database: { adminUrlPath: factoryPrivatePath(operator, "product-admin-url"), serviceHost: database.hostname, servicePort: Number(database.port) },
  storage: {
    ordinary: { endpoint: "http://127.0.0.1:18333", prefix: "ordinary", issuer: { kind: "seeded", serverIdentityPath: resolve(storageSecrets, "ordinary.json") } },
    archive: { endpoint: "http://127.0.0.1:18334", prefix: "archive", issuer: { kind: "seeded", serverIdentityPath: resolve(storageSecrets, "archive.json") } },
    failureDomain: "same-host-not-independent",
  },
  temporal: { port: portBase + 1_001, serverName: "temporal.local" },
  ingress: { address: "127.0.0.1", port: portBase + 1_005, domain: `${fleetId}.factory.test` },
  installations: {
    portBase,
    cpuCapacity: 2,
    interpreterCompatibility: "factory-kernel.v1",
    runnerProfiles: {
      brokerAudience: "factory-gateway",
      profiles: [{
        runner: { package: "@ezcorp/w09b-guest", manifestName: "w09b-guest", version: "1.0.0", digest: "sha256:c429b84ec4dbed709188115598db538a06f07887d9b900bd8cdc7c188c531121", export: "run" },
        resourceClass: "cpu",
        allocation: { resources: { cpu: 1 }, memoryBytes: 1_073_741_824, budget: { costMicros: "1000000", tokens: 1_000, computeMs: 600_000 } },
        allowedCapabilities: [],
      }],
    },
  },
  image: { reference: image, revision },
  release: { directory: resolve(import.meta.dir, ".."), bun: process.execPath, path: `${resolve(process.execPath, "..")}:/run/current-system/sw/bin:/usr/bin:/bin` },
});
await Bun.write(resolve(root, "fleet.json"), `${JSON.stringify(settings, null, 2)}\n`);
console.log(JSON.stringify({ settings: resolve(root, "fleet.json"), fleetId, portBase }));
