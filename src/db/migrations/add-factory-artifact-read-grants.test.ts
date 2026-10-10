import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-artifact-read-grants";

test("artifact read grants migration is additive, rerunnable, and source-target scoped", async () => {
  const fixture = await setupTestDb();
  try {
    await up(fixture.db); await up(fixture.db);
    const table = await fixture.db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='factory_artifact_read_grants'`);
    expect((table as unknown as { rows: Array<{ tablename: string }> }).rows).toEqual([{ tablename: "factory_artifact_read_grants" }]);
    const foreignKeys = await fixture.db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_artifact_read_grants'::regclass AND contype='f' ORDER BY oid`);
    const definitions = (foreignKeys as unknown as { rows: Array<{ definition: string }> }).rows.map(row => row.definition);
    expect(definitions).toContain("FOREIGN KEY (tenant_id, source_project_id, source_artifact_id) REFERENCES factory_artifacts(tenant_id, project_id, object_id) ON DELETE RESTRICT");
    expect(definitions).toContain("FOREIGN KEY (tenant_id, target_project_id) REFERENCES factory_projects(tenant_id, project_id) ON DELETE RESTRICT");
  } finally { await fixture.pglite.close(); }
});
