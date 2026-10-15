import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-projection-attempts";

test("projection retry migration is additive, rerunnable, and run-scoped", async () => {
  const fixture = await setupTestDb();
  try {
    await up(fixture.db); await up(fixture.db);
    const table = await fixture.db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='factory_run_projection_attempts'`);
    expect((table as unknown as { rows: Array<{ tablename: string }> }).rows).toEqual([{ tablename: "factory_run_projection_attempts" }]);
    const foreignKeys = await fixture.db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_run_projection_attempts'::regclass AND contype='f'`);
    expect((foreignKeys as unknown as { rows: Array<{ definition: string }> }).rows[0]!.definition).toContain("FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs(tenant_id, project_id, run_id)");
  } finally { await fixture.pglite.close(); }
});
