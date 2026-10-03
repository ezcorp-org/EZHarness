import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up as addChildRuns } from "./add-factory-child-runs";
import { up as addFactoryTransitionCommands } from "./add-factory-transition-commands";
import { up } from "./bind-factory-child-definition-source";

test("child definition source migration is additive and rerunnable", async () => {
  const fixture = await setupTestDb();
  try {
    await addFactoryTransitionCommands(fixture.db);
    await addChildRuns(fixture.db);
    await up(fixture.db); await up(fixture.db);
    const column = await fixture.db.execute(sql`SELECT column_name,is_nullable,column_default FROM information_schema.columns WHERE table_name='factory_child_runs' AND column_name='definition_json'`);
    expect((column as unknown as { rows: Array<{ column_name: string; is_nullable: string; column_default: string }> }).rows).toEqual([{ column_name: "definition_json", is_nullable: "NO", column_default: "'{}'::text" }]);
  } finally { await fixture.pglite.close(); }
});
