import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-assurance";
import { up as strengthen } from "./strengthen-factory-assurance";
import { up as bindSnapshots } from "./bind-factory-assurance-contract-snapshots";

test("factory assurance migration is additive and rerunnable", async () => {
  const fixture = await setupTestDb();
  try {
    await up(fixture.db); await strengthen(fixture.db); await strengthen(fixture.db); await bindSnapshots(fixture.db); await bindSnapshots(fixture.db);
    const tables = await fixture.db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('factory_acceptance_contracts', 'factory_acceptance_evidence', 'factory_acceptance_decisions', 'factory_release_approvals') ORDER BY tablename`);
    expect((tables as unknown as { rows: Array<{ tablename: string }> }).rows.map(row => row.tablename)).toEqual(["factory_acceptance_contracts", "factory_acceptance_decisions", "factory_acceptance_evidence", "factory_release_approvals"]);
    const columns = await fixture.db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name='factory_acceptance_decisions' AND column_name IN ('run_id', 'node_instance_id', 'candidate_generation', 'execution_epoch', 'cancellation_epoch') ORDER BY column_name`);
    expect((columns as unknown as { rows: Array<{ column_name: string }> }).rows.map(row => row.column_name)).toEqual(["cancellation_epoch", "candidate_generation", "execution_epoch", "node_instance_id", "run_id"]);
    const protectedColumns = await fixture.db.execute(sql`SELECT table_name, column_name FROM information_schema.columns WHERE (table_name='factory_acceptance_contracts' AND column_name='protected_snapshot_digest') OR (table_name='factory_acceptance_decisions' AND column_name='contract_snapshot_digest') ORDER BY table_name, column_name`);
    expect((protectedColumns as unknown as { rows: Array<{ table_name: string; column_name: string }> }).rows).toEqual([{ table_name: "factory_acceptance_contracts", column_name: "protected_snapshot_digest" }, { table_name: "factory_acceptance_decisions", column_name: "contract_snapshot_digest" }]);
  } finally { await fixture.pglite.close(); }
});
