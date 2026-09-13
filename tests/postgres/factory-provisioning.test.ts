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
const options = (afterExternalResourceCreated?: (resource: "role" | "database") => Promise<void>) => ({ controlDatabaseUrl: controlUrl, productDatabaseAdminUrl: url!, ordinaryConfigPath: join(root, "ordinary.json"), archiveConfigPath: join(root, "archive.json"), secretsRoot: join(root, "installations"), temporal, afterExternalResourceCreated });
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
  const identities = ["tenant-91", "tenant-92", "tenant-93", "tenant-94", "tenant-95", "tenant-96", "tenant-97"].map(name => ({ name, credentials: [{ accessKey: `${name}-key`, secretKey: `${name}-secret` }] }));
  await writeFile(ordinary, JSON.stringify({ identities }), { mode: 0o600 }); await writeFile(archive, JSON.stringify({ identities }), { mode: 0o600 });
  admin = new SQL(url!, { max: 2 }); await admin.unsafe(`CREATE DATABASE "${controlName}"`);
  const isolated = new URL(url!); isolated.pathname = `/${controlName}`; controlUrl = isolated.toString();
  provisioner = new LocalFactoryProvisioner(options());
});
afterAll(async () => {
  await provisioner?.close();
  for (const tenantId of ["tenant-91", "tenant-92", "tenant-93", "tenant-94", "tenant-95", "tenant-96", "tenant-97"]) {
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

test("recovers marked role and database after external DDL crashes without adopting foreign resources", async () => {
  for (const [tenantId, interrupted] of [["tenant-96", "role"], ["tenant-97", "database"]] as const) {
    const crashing = new LocalFactoryProvisioner(options(async (resource) => { if (resource === interrupted) throw new Error(`injected ${resource} crash`); }));
    try { await expect(crashing.provision(request(tenantId))).rejects.toThrow(`injected ${interrupted} crash`); }
    finally { await crashing.close(); }
    const control = new SQL(controlUrl);
    const partial = (await control`SELECT installation_id, role_oid::text, database_oid::text, role_plan, database_plan FROM factory_installations WHERE tenant_id = ${tenantId}`)[0] as { installation_id: string; role_oid: string | null; database_oid: string | null; role_plan: string; database_plan: string };
    expect(partial.role_plan).toBeTruthy(); expect(partial.database_plan).toBeTruthy();
    if (interrupted === "role") expect(partial.role_oid).toBe(null); else expect(partial.role_oid).toBeTruthy();
    expect(partial.database_oid).toBe(null);
    const role = localName("factory_role", tenantId), database = localName("factory_product", tenantId);
    const roleMarker = (await admin`SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = ${role}`)[0] as { marker: string } | undefined;
    if (interrupted === "role") expect(roleMarker).toBeUndefined(); else expect(roleMarker?.marker).toBe(`factory-provisioner-role:${partial.installation_id}:${partial.role_plan}:${partial.database_plan}`);
    if (interrupted === "database") {
      const databaseMarker = (await admin`SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = ${database}`)[0] as { marker: string | null };
      expect(databaseMarker.marker).toBeNull();
    }
    await control.close();
    const restarted = new LocalFactoryProvisioner(options());
    try {
      const recovered = await restarted.provision(request(tenantId));
      expect(recovered.installationId).toBe(partial.installation_id); expect(recovered.state).toBe("ready");
      if (interrupted === "role") {
        await writeFile(join(recovered.secretBundlePath, "installation.json"), JSON.stringify({ tenantId }) + "\n", { mode: 0o600 });
        await expect(restarted.provision(request(tenantId))).rejects.toThrow("Ready installation bundle does not match");
      }
    } finally { await restarted.close(); }
  }
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


test("does not adopt an unmarked pre-existing database outside its creation phase", async () => {
  const tenantId = "tenant-95", role = localName("factory_role", tenantId), database = localName("factory_product", tenantId);
  await admin.unsafe(`CREATE ROLE "${role}" LOGIN`); await admin.unsafe(`CREATE DATABASE "${database}" OWNER "${role}"`);
  const installationId = randomUUID(), rolePlan = randomUUID(), databasePlan = randomUUID();
  await admin.unsafe(`COMMENT ON ROLE "${role}" IS 'factory-provisioner-role:${installationId}:${rolePlan}:${databasePlan}'`);
  const roleOid = (await admin`SELECT oid::text FROM pg_roles WHERE rolname = ${role}`)[0] as { oid: string };
  const control = new SQL(controlUrl);
  await control`INSERT INTO factory_installations(tenant_id, installation_id, hostname, administrator_email, product_database, product_role, temporal_namespace, secret_bundle_path, state, current_step, invitation_id, role_oid, role_plan, database_plan) VALUES (${tenantId}, ${installationId}, ${`${tenantId}.factory.test`}, ${`${tenantId}@example.test`}, ${database}, ${role}, ${tenantId}, ${join(root, "installations", tenantId)}, 'partial', 'role', ${randomUUID()}, ${roleOid.oid}::oid, ${rolePlan}, ${databasePlan})`;
  await control.close();
  await expect(provisioner.provision(request(tenantId))).rejects.toThrow("database exists without recorded provisioning provenance");
  await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.unsafe(`DROP ROLE "${role}"`);
});
