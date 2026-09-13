import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-child-runs";
import { up as addFactoryTransitionCommands } from "./add-factory-transition-commands";

test("child run binding migration is additive, rerunnable, and seals both runs to the committed command", async () => {
  const fixture = await setupTestDb();
  try {
    await addFactoryTransitionCommands(fixture.db);
    await up(fixture.db); await up(fixture.db);
    const table = await fixture.db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='factory_child_runs'`);
    expect((table as unknown as { rows: Array<{ tablename: string }> }).rows).toEqual([{ tablename: "factory_child_runs" }]);
    const foreignKeys = await fixture.db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_child_runs'::regclass AND contype='f' ORDER BY oid`);
    const definitions = (foreignKeys as unknown as { rows: Array<{ definition: string }> }).rows.map(row => row.definition);
    expect(definitions).toContain("FOREIGN KEY (tenant_id, project_id, parent_run_id, parent_interpreter_id, parent_command_id) REFERENCES factory_transition_commands(tenant_id, project_id, run_id, interpreter_id, command_id) ON DELETE RESTRICT");
    expect(definitions).toContain("FOREIGN KEY (tenant_id, project_id, child_run_id, child_envelope_id) REFERENCES factory_budget_envelopes(tenant_id, project_id, run_id, envelope_id) ON DELETE RESTRICT");
  } finally { await fixture.pglite.close(); }
});
