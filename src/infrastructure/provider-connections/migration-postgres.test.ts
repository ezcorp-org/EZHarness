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
      ('installation', 'approvals', 'approval', ${JSON.stringify({ id: "approval", installationId: "installation", releaseId: "release", releaseDigest: "sha256:test", principalId: "owner", scope: "global", status: "consumed", expectedGeneration: 1, grants: [] })})`;
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

test("fenced cleanup migration backfills consumed nonces and serializes cross-binding claims", async () => {
  if (!client) throw new Error("PostgreSQL test client was not initialized");
  const { up } = await import("../../db/migrations/add-incus-fenced-cleanup-recoveries");
  await client`CREATE TABLE sandbox_bindings (id TEXT PRIMARY KEY)`;
  await client`CREATE TABLE provider_sandbox_operations (id TEXT PRIMARY KEY)`;
  await client`INSERT INTO sandbox_bindings (id) VALUES ('legacy'), ('claim-a'), ('claim-b')`;
  await client`INSERT INTO provider_sandbox_operations (id) VALUES ('unknown'), ('destroy'), ('operation-a'), ('operation-b')`;
  await up(drizzle(client));
  await client`INSERT INTO incus_fenced_cleanup_recoveries
    (operation_id,binding_id,fixture_operation_id,nonce,review_id,generation,provider_generation,
     original_operation,receipt,receipt_sha256,cleanup_operation_id)
    VALUES ('unknown','legacy','fixture','legacy-nonce','review',1,2,'{}','{}','legacy-sha','destroy')`;
  await up(drizzle(client)); await up(drizzle(client));
  const ledger = await client`SELECT nonce,action,binding_id,operation_id,receipt_sha256 FROM incus_fenced_cleanup_nonce_claims`;
  expect(Array.from(ledger, row => ({ ...(row as Record<string, unknown>) }))).toEqual([{ nonce: "legacy-nonce", action: "recovery", binding_id: "legacy", operation_id: "unknown", receipt_sha256: "legacy-sha" }]);
  const database = client;
  let arrived = 0;
  let release!: () => void;
  const simultaneousTransactions = new Promise<void>(resolve => { release = resolve; });
  const claim = (binding: string, operation: string) => database.begin(async tx => {
    if (++arrived === 2) release();
    await simultaneousTransactions;
    await tx`INSERT INTO incus_fenced_cleanup_nonce_claims (nonce,action,binding_id,operation_id,receipt_sha256)
      VALUES ('competing-nonce','abort',${binding},${operation},${binding}) ON CONFLICT (nonce) DO NOTHING`;
    const rows = await tx`SELECT binding_id,operation_id,receipt_sha256 FROM incus_fenced_cleanup_nonce_claims
      WHERE nonce='competing-nonce' FOR UPDATE`;
    if (rows[0]?.binding_id !== binding || rows[0]?.operation_id !== operation || rows[0]?.receipt_sha256 !== binding) {
      throw new Error("nonce already consumed by another binding");
    }
    return binding;
  });
  const results = await Promise.allSettled([claim("claim-a", "operation-a"), claim("claim-b", "operation-b")]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(await client`SELECT nonce FROM incus_fenced_cleanup_nonce_claims WHERE nonce='competing-nonce'`).toHaveLength(1);
}, 30_000);
