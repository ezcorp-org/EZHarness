import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./allow-factory-artifact-regrant";

type Database = Awaited<ReturnType<typeof setupTestDb>>["db"];
const tenantId = "regrant-tenant";
const digest = `sha256:${"a".repeat(64)}`;
const seal = `sha256:${"c".repeat(64)}`;
const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;
const attempt = (database: Database, statement: ReturnType<typeof sql>) => database.execute(statement).then(() => null, (error: unknown) => error);

/** The table exactly as `add-factory-artifact-read-grants` left it, before W04b: keyed by the share itself. */
async function oldShape(database: Database): Promise<void> {
  await database.execute(sql`DROP INDEX IF EXISTS idx_factory_artifact_read_grants_active`);
  await database.execute(sql`ALTER TABLE factory_artifact_read_grants DROP CONSTRAINT factory_artifact_read_grants_pkey`);
  await database.execute(sql`ALTER TABLE factory_artifact_read_grants DROP COLUMN grant_revision`);
  await database.execute(sql`ALTER TABLE factory_artifact_read_grants ADD CONSTRAINT factory_artifact_read_grants_pkey PRIMARY KEY (tenant_id, source_project_id, source_artifact_id, target_project_id)`);
}

async function world(database: Database): Promise<void> {
  await database.execute(sql`INSERT INTO factory_installation(singleton, tenant_id) VALUES (1, ${tenantId})`);
  for (const projectId of ["regrant-source", "regrant-a", "regrant-b"]) {
    await database.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, ${projectId}, ${`/${projectId}`})`);
    await database.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${tenantId}, ${projectId})`);
  }
  await database.execute(sql`INSERT INTO users(id, email, password_hash, name, role) VALUES ('regrant-owner', 'regrant@example.test', 'not-a-login', 'Regrant owner', 'admin')`);
  await database.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${tenantId}, 'regrant-source', 'regrant-run', ${digest}, 'immutable-build', 1, ${`sha256:${"b".repeat(64)}`}, '{}')`);
  await database.execute(sql`INSERT INTO factory_artifacts(object_id, tenant_id, project_id, run_id, interpreter_id, kind, digest, blob_digest, storage_version, encoded_bytes) VALUES ('regrant-artifact', ${tenantId}, 'regrant-source', 'regrant-run', NULL, 'execution_manifest', ${digest}, ${"a".repeat(64)}, 'version-1', 10)`);
}

/** One share row. `revision` is omitted on the old shape, which has no such column. */
function share(target: string, revoked: boolean, revision?: number) {
  const columns = sql`tenant_id, source_project_id, source_run_id, source_artifact_id, target_project_id, artifact_digest, artifact_bytes, artifact_kind, storage_version, media_type, issuer_id, issuer_grant_revision, protected_digest, revoked_at`;
  const values = sql`${tenantId}, 'regrant-source', 'regrant-run', 'regrant-artifact', ${target}, ${digest}, 10, 'execution_manifest', 'version-1', 'application/json', 'regrant-owner', 1, ${seal}, ${revoked ? sql`NOW()` : sql`NULL`}`;
  return revision === undefined
    ? sql`INSERT INTO factory_artifact_read_grants (${columns}) VALUES (${values})`
    : sql`INSERT INTO factory_artifact_read_grants (${columns}, grant_revision) VALUES (${values}, ${revision})`;
}

test("the upgrade keeps a revoked share, numbers it, and lets only an active grant be unique", async () => {
  const fixture = await setupTestDb();
  const database = fixture.db;
  try {
    await oldShape(database);
    await world(database);
    // On the old shape the revoked row occupies the share's key: a second row is impossible.
    await database.execute(share("regrant-a", true));
    await database.execute(share("regrant-b", false));
    expect(await attempt(database, share("regrant-a", false))).toBeInstanceOf(Error);

    const constraints = async () => rowsOf<{ conname: string; oid: number; definition: string }>(await database.execute(sql`SELECT conname, oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_artifact_read_grants'::regclass ORDER BY conname`));
    const index = async () => rowsOf<{ indexdef: string }>(await database.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname='idx_factory_artifact_read_grants_active'`));
    await up(database);
    const first = await constraints();
    await up(database);
    // A second boot re-creates nothing, so every constraint keeps its catalog entry.
    expect(await constraints()).toEqual(first);
    expect(first.find(row => row.conname === "factory_artifact_read_grants_pkey")?.definition).toBe("PRIMARY KEY (tenant_id, source_project_id, source_artifact_id, target_project_id, grant_revision)");
    expect(first.find(row => row.conname === "factory_artifact_read_grants_grant_revision_check")?.definition).toContain("grant_revision > 0");
    expect((await index())[0]?.indexdef).toContain("WHERE (revoked_at IS NULL)");

    // Both old rows survive as grant 1, the revoked one still revoked.
    const kept = rowsOf<{ target_project_id: string; grant_revision: number | string; revoked: boolean }>(await database.execute(sql`SELECT target_project_id, grant_revision, revoked_at IS NOT NULL AS revoked FROM factory_artifact_read_grants ORDER BY target_project_id, grant_revision`));
    expect(kept.map(row => [row.target_project_id, Number(row.grant_revision), row.revoked])).toEqual([["regrant-a", 1, true], ["regrant-b", 1, false]]);

    // The revoked share takes a new active grant; the active share takes no second one.
    expect(await attempt(database, share("regrant-a", false, 2))).toBeNull();
    expect(await attempt(database, share("regrant-b", false, 2))).toBeInstanceOf(Error);
    expect(await attempt(database, share("regrant-a", false, 3))).toBeInstanceOf(Error);
    expect(await attempt(database, share("regrant-a", true, 0))).toBeInstanceOf(Error);
  } finally { await fixture.pglite.close(); }
});
