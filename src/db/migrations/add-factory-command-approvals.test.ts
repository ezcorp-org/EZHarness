import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-command-approvals";

test("factory command approval migration is repeatable and keeps exact run and transition foreign keys", async () => {
  const fixture = await setupTestDb();
  try {
    await up(fixture.db); await up(fixture.db);
    const columns = await fixture.db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name='factory_command_approvals' ORDER BY column_name`);
    expect((columns as unknown as { rows: Array<{ column_name: string }> }).rows.map(row => row.column_name)).toEqual(expect.arrayContaining(["approval_id", "run_id", "interpreter_id", "command_id", "source_sequence", "protected_digest", "event_digest"]));
    const foreignKeys = await fixture.db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_command_approvals'::regclass AND contype='f' ORDER BY definition`);
    const definitions = (foreignKeys as unknown as { rows: Array<{ definition: string }> }).rows.map(row => row.definition).join("\n");
    expect(definitions).toContain("FOREIGN KEY (tenant_id, project_id, run_id) REFERENCES factory_runs");
    expect(definitions).toContain("FOREIGN KEY (tenant_id, project_id, run_id, interpreter_id, source_sequence) REFERENCES factory_audit_batches");
  } finally { await fixture.pglite.close(); }
});
