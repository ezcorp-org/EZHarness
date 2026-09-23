import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { up as addExtensionReleases } from "../../db/migrations/add-extension-releases";
import { up as addProviderConnections } from "../../db/migrations/add-provider-connections";
import { ProviderConnectionStore } from "./store";

const installation = { id: "provider-installation", ownerId: "owner", scope: "global", activeReleaseId: "release-a", generation: 2, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 2 };
const release = { id: "release-a", releaseDigest: "sha256:test" };
const approval = { id: "approval-a", installationId: installation.id, releaseId: release.id, releaseDigest: release.releaseDigest, principalId: "owner", scope: "global", status: "consumed", expectedGeneration: 1 };

async function fixture(directory: string) {
  const client = new PGlite(directory);
  await client.waitReady;
  const db = drizzle(client);
  await addExtensionReleases(db);
  await addProviderConnections(db);
  await client.query("INSERT INTO extension_release_installations (id, owner_id, scope, payload) VALUES ($1, $2, $3, $4)", [installation.id, installation.ownerId, installation.scope, JSON.stringify(installation)]);
  for (const [kind, record] of [["releases", release], ["approvals", approval]] as const) {
    await client.query("INSERT INTO extension_release_records (installation_id, kind, id, payload) VALUES ($1, $2, $3, $4)", [installation.id, kind, record.id, JSON.stringify(record)]);
  }
  return { client, db };
}

const configuration = { kind: "incus" as const, profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" };
const input = { id: "connection-a", providerInstallationId: installation.id, providerReleaseId: release.id, endpoint: "https://incus.example:8443", serverCertificatePem: "server-cert", project: "sandbox", configuration, clientCertificatePem: "client-cert", privateKeyPem: "private-key-secret" };

test("provider credentials survive reopen but metadata excludes the private key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-connection-"));
  try {
    let { client, db } = await fixture(directory);
    const store = new ProviderConnectionStore(db);
    const created = await store.create(input);
    expect(created).toMatchObject({ id: input.id, revision: 1, endpoint: input.endpoint, project: input.project, configuration });
    expect(JSON.stringify(created)).not.toContain(input.privateKeyPem);
    const rows = await client.query<{ private_key_ciphertext: string }>("SELECT private_key_ciphertext FROM provider_connections");
    expect(JSON.stringify(rows.rows)).not.toContain(input.privateKeyPem);
    await client.close();
    client = new PGlite(directory);
    await client.waitReady;
    db = drizzle(client);
    await addProviderConnections(db);
    const reopened = new ProviderConnectionStore(db);
    expect(JSON.stringify(await reopened.getMetadata(input.id))).not.toContain(input.privateKeyPem);
    expect(await reopened.resolveForHost({ connectionId: input.id, providerInstallationId: installation.id, providerReleaseId: release.id, revision: 1 })).toMatchObject({ privateKeyPem: input.privateKeyPem, configuration });
    await client.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("provider host access rejects stale, revoked and swapped credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-connection-"));
  try {
    const { client, db } = await fixture(directory);
    const store = new ProviderConnectionStore(db);
    await store.create(input);
    await store.create({ ...input, id: "connection-b", privateKeyPem: "other-secret" });
    const scope = { connectionId: input.id, providerInstallationId: installation.id, providerReleaseId: release.id, revision: 1 };
    await expect(store.resolveForHost({ ...scope, revision: 2 })).rejects.toThrow();
    await expect(store.resolveForHost({ ...scope, providerInstallationId: "another-installation" })).rejects.toThrow();
    await expect(store.resolveForHost({ ...scope, providerReleaseId: "another-release" })).rejects.toThrow();
    await client.query("UPDATE provider_connections SET private_key_ciphertext = (SELECT private_key_ciphertext FROM provider_connections WHERE id = 'connection-b') WHERE id = 'connection-a'");
    await expect(store.resolveForHost(scope)).rejects.toThrow();
    await store.revoke(input.id, 1);
    await expect(store.resolveForHost(scope)).rejects.toThrow();
    await client.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("provider host access follows the live approved release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-connection-"));
  try {
    const { client, db } = await fixture(directory);
    const store = new ProviderConnectionStore(db);
    await store.create(input);
    const scope = { connectionId: input.id, providerInstallationId: installation.id, providerReleaseId: release.id, revision: 1 };
    await client.query("UPDATE extension_release_records SET payload = $1 WHERE installation_id = $2 AND kind = 'approvals'", [JSON.stringify({ ...approval, status: "revoked" }), installation.id]);
    await expect(store.resolveForHost(scope)).rejects.toThrow("not active and approved");
    await client.query("UPDATE extension_release_records SET payload = $1 WHERE installation_id = $2 AND kind = 'approvals'", [JSON.stringify(approval), installation.id]);
    await client.query("UPDATE extension_release_installations SET payload = $1 WHERE id = $2", [JSON.stringify({ ...installation, activeReleaseId: "release-b", generation: 3, acknowledgedGeneration: 3 }), installation.id]);
    await expect(store.resolveForHost(scope)).rejects.toThrow("not active and approved");
    await expect(store.create({ ...input, id: "new-connection" })).rejects.toThrow("not active and approved");
    await client.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("reviewed configuration is bounded and ciphertext-authenticated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-connection-"));
  try {
    const { client, db } = await fixture(directory);
    const store = new ProviderConnectionStore(db);
    await expect(store.create({ ...input, configuration: { ...configuration, profile: "default" } })).rejects.toThrow("Invalid provider configuration");
    await expect(store.create({ ...input, configuration: { ...configuration, helperVersion: "latest" } })).rejects.toThrow("Invalid provider configuration");
    await expect(store.create({ ...input, configuration: { ...configuration, guestUser: "root!" } })).rejects.toThrow("Invalid provider configuration");
    await expect(store.create({ ...input, configuration: { ...configuration, extra: "unexpected" } as typeof configuration })).rejects.toThrow("Invalid provider configuration");
    await expect(store.create({ ...input, project: "default" })).rejects.toThrow("Invalid provider connection");
    await store.create(input);
    const scope = { connectionId: input.id, providerInstallationId: installation.id, providerReleaseId: release.id, revision: 1 };
    await client.query("UPDATE provider_connections SET configuration = $1::jsonb WHERE id = $2", [JSON.stringify({ ...configuration, guestUser: "another" }), input.id]);
    await expect(store.resolveForHost(scope)).rejects.toThrow("authentication failed");
    await client.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
