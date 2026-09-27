import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-usage-epoch-stale";

function rows<Row>(result: unknown): Row[] {
  return (result as { rows: Row[] }).rows;
}

type Database = Awaited<ReturnType<typeof setupTestDb>>["db"];

async function column(database: Database): Promise<{ data_type: string; is_nullable: string } | undefined> {
  return rows<{ data_type: string; is_nullable: string }>(await database.execute(sql`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'factory_budget_reservations' AND column_name = 'epoch_stale_json'`))[0];
}

test("an uncertain hold can carry its stale-epoch mark, and re-running changes nothing", async () => {
  const fixture = await setupTestDb();
  try {
    // migrate() already ran it; a repeat must not fail.
    expect(await column(fixture.db)).toEqual({ data_type: "jsonb", is_nullable: "YES" });
    await up(fixture.db);
    expect(await column(fixture.db)).toEqual({ data_type: "jsonb", is_nullable: "YES" });
  } finally { await fixture.pglite.close(); }
});

test("a table created before the mark existed gains the column", async () => {
  const fixture = await setupTestDb();
  try {
    await fixture.db.execute(sql`ALTER TABLE factory_budget_reservations DROP COLUMN epoch_stale_json`);
    expect(await column(fixture.db)).toBeUndefined();
    await up(fixture.db);
    expect(await column(fixture.db)).toEqual({ data_type: "jsonb", is_nullable: "YES" });
  } finally { await fixture.pglite.close(); }
});
