import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-task-stop-reconciliation";

test("adds the nullable reconciliation column once, and re-running changes nothing", async () => {
  const fixture = await setupTestDb();
  try {
    const column = async () => (await fixture.db.execute(sql`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name='factory_task_stops' AND column_name='reconcile_json'`) as unknown as { rows: unknown[] }).rows;
    // migrate() already ran it; a repeat must not fail or add a second column.
    expect(await column()).toEqual([{ data_type: "text", is_nullable: "YES" }]);
    await up(fixture.db);
    expect(await column()).toEqual([{ data_type: "text", is_nullable: "YES" }]);
  } finally {
    await fixture.pglite.close();
  }
});
