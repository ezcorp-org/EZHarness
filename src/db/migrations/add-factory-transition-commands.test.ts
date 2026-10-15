import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-transition-commands";

test("transition command lookup migration is additive, rerunnable, and audit-scoped", async () => {
  const fixture = await setupTestDb();
  try {
    await up(fixture.db); await up(fixture.db);
    const table = await fixture.db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='factory_transition_commands'`);
    expect((table as unknown as { rows: Array<{ tablename: string }> }).rows).toEqual([{ tablename: "factory_transition_commands" }]);
    const foreignKeys = await fixture.db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_transition_commands'::regclass AND contype='f'`);
    expect((foreignKeys as unknown as { rows: Array<{ definition: string }> }).rows[0]!.definition).toContain("FOREIGN KEY (tenant_id, project_id, run_id, interpreter_id, source_sequence) REFERENCES factory_audit_batches(tenant_id, project_id, run_id, interpreter_id, source_sequence)");
  } finally { await fixture.pglite.close(); }
});
