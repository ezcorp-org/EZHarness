import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../schema";
import { up as addPreparations } from "./add-factory-package-preparations";
import { up } from "./add-factory-package-quarantine";

const digest = `sha256:${"a".repeat(64)}`;
const raw = "b".repeat(64);

async function fixture() {
  const client = new PGlite({ extensions: { vector, pg_trgm } });
  await client.waitReady;
  const database = drizzle(client, { schema });
  await database.execute(sql`CREATE TABLE users (id TEXT PRIMARY KEY)`);
  await database.execute(sql`CREATE TABLE factory_projects (tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY (tenant_id, project_id))`);
  await database.execute(sql`CREATE TABLE extension_release_installations (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
  await addPreparations(database);
  await database.execute(sql`INSERT INTO users(id) VALUES ('quarantine-user')`);
  await database.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES ('t','p')`);
  await database.execute(sql`INSERT INTO extension_release_installations(id,payload) VALUES ('i', ${JSON.stringify({ id: "i", generation: 7 })})`);
  await database.execute(sql`INSERT INTO factory_runner_package_bindings (tenant_id,project_id,package_name,package_version,package_digest,export_name,reference_digest,reference_json,installation_id,release_id,release_digest,source_digest,artifact_digest,image_digest,manifest_digest,issuer_id,issuer_grant_revision,protected_digest) VALUES ('t','p','pkg','1.0.0',${digest},'run',${digest},'{}','i','r',${raw},${raw},${raw},'image',${raw},'quarantine-user',1,${digest})`);
  return { client, database };
}

type Database = Awaited<ReturnType<typeof fixture>>["database"];

/** A revision written the way an older boot wrote one, with no generation column. */
async function insertRevision(database: Database, revision: number, state: string): Promise<void> {
  await database.execute(sql`INSERT INTO factory_runner_package_trust_revisions (tenant_id,project_id,package_name,package_version,package_digest,export_name,reference_digest,revision,state,package_trust_digest,approved_by,approval_grant_revision,protected_digest) VALUES ('t','p','pkg','1.0.0',${digest},'run',${digest},${revision},${state},${digest},'quarantine-user',1,${digest})`);
}

/** A revision written after the upgrade, which must name its own fence. */
async function insertFenced(database: Database, revision: number, state: string, generation = 7): Promise<void> {
  await database.execute(sql`INSERT INTO factory_runner_package_trust_revisions (tenant_id,project_id,package_name,package_version,package_digest,export_name,reference_digest,revision,state,package_trust_digest,approved_by,approval_grant_revision,installation_generation,protected_digest) VALUES ('t','p','pkg','1.0.0',${digest},'run',${digest},${revision},${state},${digest},'quarantine-user',1,${generation},${digest})`);
}

test("the upgrade path backfills the v4 generation from the binding's installation and forbids a NULL", async () => {
  const { client, database } = await fixture();
  try {
    await insertRevision(database, 1, "active");
    for (let boot = 0; boot < 2; boot++) {
      await up(database);
      const rows = (await database.execute(sql`SELECT installation_generation FROM factory_runner_package_trust_revisions WHERE revision=1`)).rows as Array<{ installation_generation: number | string }>;
      expect(Number(rows[0]!.installation_generation)).toBe(7);
      const nullable = (await database.execute(sql`SELECT is_nullable FROM information_schema.columns WHERE table_name='factory_runner_package_trust_revisions' AND column_name='installation_generation'`)).rows as Array<{ is_nullable: string }>;
      expect(nullable.map(column => column.is_nullable)).toEqual(["NO"]);
    }
  } finally { await client.close(); }
});

test("a revision whose binding has no installation generation backfills to zero rather than staying NULL", async () => {
  const { client, database } = await fixture();
  try {
    await database.execute(sql`UPDATE extension_release_installations SET payload=${JSON.stringify({ id: "i" })} WHERE id='i'`);
    await insertRevision(database, 1, "active");
    await up(database);
    const rows = (await database.execute(sql`SELECT installation_generation FROM factory_runner_package_trust_revisions WHERE revision=1`)).rows as Array<{ installation_generation: number | string }>;
    expect(Number(rows[0]!.installation_generation)).toBe(0);
  } finally { await client.close(); }
});

test("the state CHECK admits quarantined only after the migration, and still refuses an unknown state", async () => {
  const { client, database } = await fixture();
  try {
    await expect(insertRevision(database, 1, "quarantined")).rejects.toThrow();
    await up(database);
    await insertFenced(database, 1, "quarantined");
    await insertFenced(database, 2, "revoked");
    await insertFenced(database, 3, "active");
    await expect(insertFenced(database, 4, "suspended")).rejects.toThrow();
    // The upgraded column has no default, so a row that names no fence fails closed.
    await expect(insertRevision(database, 5, "active")).rejects.toThrow();
    const constraints = (await database.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid='factory_runner_package_trust_revisions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%state%'`)).rows as Array<{ conname: string }>;
    expect(constraints.map(row => row.conname)).toEqual(["factory_runner_package_trust_state_check"]);
  } finally { await client.close(); }
});

test("a negative generation is refused by its own named CHECK", async () => {
  const { client, database } = await fixture();
  try {
    await up(database);
    await expect(insertFenced(database, 1, "active", -1)).rejects.toThrow();
    await insertFenced(database, 1, "active", 0);
    const named = (await database.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid='factory_runner_package_trust_revisions'::regclass AND conname='factory_runner_package_trust_generation_check'`)).rows;
    expect(named).toHaveLength(1);
  } finally { await client.close(); }
});

test("a fresh database reaches the same shape as an upgraded one", async () => {
  const { client, database } = await fixture();
  try {
    await up(database);
    await up(database);
    const columns = (await database.execute(sql`SELECT column_name,is_nullable,data_type FROM information_schema.columns WHERE table_name='factory_runner_package_trust_revisions' AND column_name='installation_generation'`)).rows as Array<{ column_name: string; is_nullable: string; data_type: string }>;
    expect(columns).toEqual([{ column_name: "installation_generation", is_nullable: "NO", data_type: "bigint" }]);
    const checks = (await database.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid='factory_runner_package_trust_revisions'::regclass AND contype='c' ORDER BY conname`)).rows as Array<{ conname: string }>;
    expect(checks.map(row => row.conname)).toContain("factory_runner_package_trust_state_check");
    expect(checks.map(row => row.conname)).toContain("factory_runner_package_trust_generation_check");
  } finally { await client.close(); }
});
