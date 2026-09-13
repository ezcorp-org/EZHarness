import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-assurance";

test("factory assurance migration is additive and rerunnable", async () => {
  const fixture = await setupTestDb();
  try {
    await up(fixture.db); await up(fixture.db);
    const tables = await fixture.db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('factory_acceptance_contracts', 'factory_acceptance_evidence', 'factory_acceptance_decisions', 'factory_release_approvals') ORDER BY tablename`);
    expect((tables as { rows: Array<{ tablename: string }> }).rows.map(row => row.tablename)).toEqual(["factory_acceptance_contracts", "factory_acceptance_decisions", "factory_acceptance_evidence", "factory_release_approvals"]);
  } finally { await fixture.pglite.close(); }
});
