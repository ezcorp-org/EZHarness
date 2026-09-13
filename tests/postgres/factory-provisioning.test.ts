import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { LocalFactoryProvisioner, type TemporalNamespaces } from "../../src/factory/provisioning/local";

const url = process.env.FACTORY_TEST_POSTGRES_URL;
if (!url) throw new Error("FACTORY_TEST_POSTGRES_URL is required for real PostgreSQL provisioning conformance.");
const root = `/run/user/${process.getuid?.()}/factory-provisioning-test-${randomUUID()}`;
const controlName = `factory_control_${randomUUID().replaceAll("-", "")}`;
const localName = (prefix: string, tenantId: string) => `${prefix}_${createHash("sha256").update(tenantId).digest("hex").slice(0, 20)}`;
let admin: SQL;
let controlUrl: string;
let provisioner: LocalFactoryProvisioner;
let failOnce = false;
const temporal: TemporalNamespaces = {
  async create({ tenantId, namespace, secretDirectory }) {
    if (failOnce) { failOnce = false; throw new Error("injected Temporal interruption"); }
    await writeFile(join(secretDirectory, "temporal-token"), "test-token\n", { mode: 0o600 });
    await writeFile(join(secretDirectory, "temporal.json"), `${JSON.stringify({ tenantId, namespace })}\n`, { mode: 0o600 });
  },
};
const request = (tenantId: string) => ({ tenantId, hostname: `${tenantId}.factory.test`, administratorEmail: `${tenantId}@example.test` });

beforeAll(async () => {
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const ordinary = join(root, "ordinary.json"), archive = join(root, "archive.json");
  const identities = ["tenant-91", "tenant-92", "tenant-93", "tenant-94", "tenant-95"].map(name => ({ name, credentials: [{ accessKey: `${name}-key`, secretKey: `${name}-secret` }] }));
  await writeFile(ordinary, JSON.stringify({ identities }), { mode: 0o600 }); await writeFile(archive, JSON.stringify({ identities }), { mode: 0o600 });
  admin = new SQL(url!, { max: 2 }); await admin.unsafe(`CREATE DATABASE "${controlName}"`);
  const isolated = new URL(url!); isolated.pathname = `/${controlName}`; controlUrl = isolated.toString();
  provisioner = new LocalFactoryProvisioner({ controlDatabaseUrl: controlUrl, productDatabaseAdminUrl: url!, ordinaryConfigPath: ordinary, archiveConfigPath: archive, secretsRoot: join(root, "installations"), temporal });
});
afterAll(async () => {
  await provisioner?.close();
  for (const tenantId of ["tenant-91", "tenant-92", "tenant-93", "tenant-94", "tenant-95"]) {
    const database = localName("factory_product", tenantId), role = localName("factory_role", tenantId);
    const exists = (await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`)[0];
    if (exists) await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    const roleExists = (await admin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`)[0];
    if (roleExists) await admin.unsafe(`DROP ROLE "${role}"`);
  }
  await admin.unsafe(`DROP DATABASE "${controlName}" WITH (FORCE)`); await admin.close();
});

test("serializes concurrent installation, persists external-fault recovery, and denies changed requests", async () => {
  const concurrent = await Promise.all([provisioner.provision(request("tenant-91")), provisioner.provision(request("tenant-91"))]);
  expect(concurrent[0].installationId).toBe(concurrent[1].installationId);
  await expect(provisioner.provision({ ...request("tenant-91"), hostname: "changed.factory.test" })).rejects.toThrow("conflicts");
  failOnce = true;
  await expect(provisioner.provision(request("tenant-92"))).rejects.toThrow("injected Temporal interruption");
  const control = new SQL(controlUrl); const partial = (await control`SELECT state, role_oid::text, database_oid::text FROM factory_installations WHERE tenant_id = 'tenant-92'`)[0] as { state: string; role_oid: string; database_oid: string };
  expect(partial.state).toBe("partial"); expect(partial.role_oid).toBeTruthy(); expect(partial.database_oid).toBeTruthy(); await control.close();
  expect((await provisioner.provision(request("tenant-92"))).state).toBe("ready");
});

test("does not adopt a pre-existing product role and revokes public database access", async () => {
  const tenantId = "tenant-93", role = localName("factory_role", tenantId);
  await admin.unsafe(`CREATE ROLE "${role}" LOGIN`);
  await expect(provisioner.provision(request(tenantId))).rejects.toThrow("provenance");
  await admin.unsafe(`DROP ROLE "${role}"`);
  const installation = await provisioner.provision(request(tenantId));
  const publicConnect = (await admin`SELECT has_database_privilege('public', ${installation.productDatabase}, 'CONNECT') AS allowed`)[0] as { allowed: boolean };
  expect(publicConnect.allowed).toBe(false);
});


test("rejects a symlinked secret ancestor before it can create a product resource", async () => {
  const unsafeRoot = join(root, "unsafe-root");
  await symlink(root, unsafeRoot);
  const unsafe = new LocalFactoryProvisioner({ controlDatabaseUrl: controlUrl, productDatabaseAdminUrl: url!, ordinaryConfigPath: join(root, "ordinary.json"), archiveConfigPath: join(root, "archive.json"), secretsRoot: unsafeRoot, temporal });
  try { await expect(unsafe.provision(request("tenant-94"))).rejects.toThrow(); }
  finally { await unsafe.close(); }
  const role = localName("factory_role", "tenant-94");
  expect((await admin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`).length).toBe(0);
});


test("does not adopt a database whose owner differs from recorded role provenance", async () => {
  const tenantId = "tenant-95", role = localName("factory_role", tenantId), database = localName("factory_product", tenantId), foreignRole = `factory_foreign_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE ROLE "${role}" LOGIN`); await admin.unsafe(`CREATE ROLE "${foreignRole}" LOGIN`); await admin.unsafe(`CREATE DATABASE "${database}" OWNER "${foreignRole}"`);
  const roleOid = (await admin`SELECT oid::text FROM pg_roles WHERE rolname = ${role}`)[0] as { oid: string };
  const control = new SQL(controlUrl);
  await control`INSERT INTO factory_installations(tenant_id, installation_id, hostname, administrator_email, product_database, product_role, temporal_namespace, secret_bundle_path, state, current_step, invitation_id, role_oid) VALUES (${tenantId}, ${randomUUID()}, ${`${tenantId}.factory.test`}, ${`${tenantId}@example.test`}, ${database}, ${role}, ${tenantId}, ${join(root, "installations", tenantId)}, 'partial', 'role', ${randomUUID()}, ${roleOid.oid}::oid)`;
  await control.close();
  await expect(provisioner.provision(request(tenantId))).rejects.toThrow("database exists without recorded provisioning provenance");
  await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.unsafe(`DROP ROLE "${foreignRole}"`); await admin.unsafe(`DROP ROLE "${role}"`);
});
