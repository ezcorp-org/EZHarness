import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up as addCommands } from "./add-factory-transition-commands";
import { up as addChildren } from "./add-factory-child-runs";
import { up } from "./bind-factory-child-start-clock";

test("child start clock migration is additive and rerunnable on an empty legacy table", async () => {
  const fixture = await setupTestDb();
  try {
    await addCommands(fixture.db);
    await addChildren(fixture.db);
    await up(fixture.db);
    await up(fixture.db);
    const result = await fixture.db.execute(sql`SELECT is_nullable FROM information_schema.columns WHERE table_name='factory_child_runs' AND column_name='started_ms'`);
    expect((result as unknown as { rows: Array<{ is_nullable: string }> }).rows).toEqual([{ is_nullable: "NO" }]);
  } finally { await fixture.pglite.close(); }
});

test("child start clock migration refuses to invent a clock for existing bindings", async () => {
  const fixture = await setupTestDb();
  try {
    await fixture.db.execute(sql`DROP TABLE factory_child_runs CASCADE`);
    await fixture.db.execute(sql`CREATE TABLE factory_child_runs (legacy_id TEXT NOT NULL)`);
    await fixture.db.execute(sql`INSERT INTO factory_child_runs (legacy_id) VALUES ('binding-without-clock')`);
    await expect(up(fixture.db)).rejects.toThrow("factory_child_start_clock_backfill_required");
  } finally { await fixture.pglite.close(); }
});
