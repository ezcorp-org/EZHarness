import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-assurance";
import { up as strengthen } from "./strengthen-factory-assurance";

test("factory assurance migration is additive and rerunnable", async () => {
  const fixture = await setupTestDb();
  try {
    await up(fixture.db); await strengthen(fixture.db); await strengthen(fixture.db);
    const tables = await fixture.db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('factory_acceptance_contracts', 'factory_acceptance_evidence', 'factory_acceptance_decisions', 'factory_release_approvals') ORDER BY tablename`);
    expect((tables as { rows: Array<{ tablename: string }> }).rows.map(row => row.tablename)).toEqual(["factory_acceptance_contracts", "factory_acceptance_decisions", "factory_acceptance_evidence", "factory_release_approvals"]);
    const columns = await fixture.db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name='factory_acceptance_decisions' AND column_name IN ('run_id', 'node_instance_id', 'candidate_generation', 'execution_epoch', 'cancellation_epoch') ORDER BY column_name`);
    expect((columns as { rows: Array<{ column_name: string }> }).rows.map(row => row.column_name)).toEqual(["cancellation_epoch", "candidate_generation", "execution_epoch", "node_instance_id", "run_id"]);
  } finally { await fixture.pglite.close(); }
});
