import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import testImages from "../../../scripts/test-images.json";
import { up as addExtensionReleases } from "../../db/migrations/add-extension-releases";
import { up as addProviderConnections } from "../../db/migrations/add-provider-connections";
import { ProviderConnectionStore } from "./store";

const container = `provider-connection-postgres-${crypto.randomUUID()}`;
let client: SQL | undefined;
let reopened: SQL | undefined;
let postgresUri: string;

async function podman(...args: string[]): Promise<string> {
  const child = Bun.spawn(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

beforeAll(async () => {
  await podman("run", "-d", "--name", container, "--pull=never", "--log-driver=none", "--memory=256m", "-e", "POSTGRES_PASSWORD=fixture", "-p", "127.0.0.1::5432", testImages.postgres);
  const port = (await podman("port", container, "5432/tcp")).split(":").at(-1);
  await podman("exec", container, "sh", "-c", "for attempt in $(seq 1 100); do pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1");
  postgresUri = `postgres://postgres:fixture@127.0.0.1:${port}/postgres`;
  client = new SQL(postgresUri, { max: 2, connectionTimeout: 10 });
  await client`SELECT 1`;
  await addExtensionReleases(drizzle(client));
  await addProviderConnections(drizzle(client));
  await addProviderConnections(drizzle(client));
  await client`INSERT INTO extension_release_installations (id, owner_id, scope, payload)
    VALUES ('installation', 'owner', 'global', ${JSON.stringify({ id: "installation", ownerId: "owner", scope: "global", activeReleaseId: "release", generation: 2, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 2 })})`;
  await client`INSERT INTO extension_release_records (installation_id, kind, id, payload)
    VALUES ('installation', 'releases', 'release', ${JSON.stringify({ id: "release", releaseDigest: "sha256:test" })}),
      ('installation', 'approvals', 'approval', ${JSON.stringify({ id: "approval", installationId: "installation", releaseId: "release", releaseDigest: "sha256:test", principalId: "owner", scope: "global", status: "consumed", expectedGeneration: 1 })})`;
}, 30_000);

afterAll(async () => {
  await reopened?.close({ timeout: 1 });
  await client?.close({ timeout: 1 });
  await podman("rm", "-f", "--ignore", container);
}, 10_000);

test("provider connection migration and credentials survive a PostgreSQL client reopen", async () => {
  if (!client) throw new Error("PostgreSQL test client was not initialized");
  const store = new ProviderConnectionStore(drizzle(client));
  const configuration = { kind: "incus" as const, profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" };
  await store.create({ id: "connection", providerInstallationId: "installation", providerReleaseId: "release", endpoint: "https://incus.example:8443", serverCertificatePem: "server", project: "sandbox", configuration, clientCertificatePem: "client", privateKeyPem: "private-key-secret" });
  const rows = await client`SELECT private_key_ciphertext FROM provider_connections`;
  expect(JSON.stringify(rows)).not.toContain("private-key-secret");
  reopened = new SQL(postgresUri, { max: 2, connectionTimeout: 10 });
  const reopenedStore = new ProviderConnectionStore(drizzle(reopened));
  expect(await reopenedStore.resolveForHost({ connectionId: "connection", providerInstallationId: "installation", providerReleaseId: "release", revision: 1 })).toMatchObject({ privateKeyPem: "private-key-secret", configuration });
  expect(JSON.stringify(await reopenedStore.getMetadata("connection"))).not.toContain("private-key-secret");
}, 30_000);
