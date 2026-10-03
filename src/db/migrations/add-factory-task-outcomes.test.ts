import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-task-outcomes";

test("task outcome migration is repeatable and binds the exact attempt and command", async () => {
  const fixture = await setupTestDb();
  try {
    await up(fixture.db); await up(fixture.db);
    const columns = await fixture.db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name='factory_task_outcomes' ORDER BY column_name`);
    expect((columns as unknown as { rows: Array<{ column_name: string }> }).rows.map(row => row.column_name)).toEqual(expect.arrayContaining(["attempt_id", "reservation_id", "authority_json", "result_json", "evidence_digest", "receipt_digest"]));
    const foreignKeys = await fixture.db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_task_outcomes'::regclass AND contype='f' ORDER BY definition`);
    const definitions = (foreignKeys as unknown as { rows: Array<{ definition: string }> }).rows.map(row => row.definition).join("\n");
    expect(definitions).toContain("FOREIGN KEY (attempt_id, tenant_id, project_id, run_id) REFERENCES factory_executions");
    expect(definitions).toContain("FOREIGN KEY (tenant_id, project_id, run_id, interpreter_id, command_id) REFERENCES factory_transition_commands");
  } finally { await fixture.pglite.close(); }
});
