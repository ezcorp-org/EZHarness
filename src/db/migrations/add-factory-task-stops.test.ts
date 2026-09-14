import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { FACTORY_PHYSICAL_STOP_TIMEOUT_MS, FACTORY_STOP_ABORT_GRACE_MS, FACTORY_TASK_STOP_CODES, FactoryTaskStopError } from "../../factory/task-stops";
import { up } from "./add-factory-task-stops";

function rows<Row>(result: unknown): Row[] {
  return (result as { rows: Row[] }).rows;
}

test("task stop migration is repeatable and admits a live stop without a terminal outcome", async () => {
  const fixture = await setupTestDb();
  try {
    await up(fixture.db); await up(fixture.db);
    const columns = rows<{ column_name: string; is_nullable: string; column_default: string | null }>(await fixture.db.execute(sql`SELECT column_name,is_nullable,column_default FROM information_schema.columns WHERE table_name='factory_task_stops' ORDER BY column_name`));
    expect(columns.map(row => row.column_name)).toEqual(expect.arrayContaining(["cancel_command_id", "attempt_command_id", "source", "request_digest", "uncertain_event_digest", "stop_receipt_digest", "stopped_event_digest", "accepted_at_ms"]));
    expect(columns.find(row => row.column_name === "attempt_command_id")?.is_nullable).toBe("YES");
    expect(columns.find(row => row.column_name === "source")?.column_default).toContain("'terminal-outcome'");
    const definitions = rows<{ conname: string; definition: string }>(await fixture.db.execute(sql`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_task_stops'::regclass ORDER BY conname`));
    const joined = definitions.map(row => row.definition).join("\n");
    expect(joined).toContain("FOREIGN KEY (tenant_id, project_id, run_id, interpreter_id, attempt_command_id) REFERENCES factory_task_outcomes");
    expect(joined).toContain("FOREIGN KEY (tenant_id, project_id, run_id, interpreter_id, cancel_command_id) REFERENCES factory_transition_commands");
    expect(joined).toContain("FOREIGN KEY (attempt_id) REFERENCES factory_attempt_launches(attempt_id)");
    expect(joined).toContain("state = 'stopped'::text) = ((stop_receipt_json IS NOT NULL) AND (stopped_event_json IS NOT NULL))");
    expect(joined).toContain("accepted_at_ms >= 0");
    expect(joined).toContain("source <> 'terminal-outcome'::text) OR (attempt_command_id IS NOT NULL)");
    // Every constraint carries the name this module declares, so a fresh
    // database and an upgraded one hold identical catalog entries.
    expect(definitions.every(row => row.conname.startsWith("factory_task_stops_"))).toBe(true);
  } finally { await fixture.pglite.close(); }
});

test("the stop code union, its constant, and the two contract timeouts agree", () => {
  expect(FACTORY_STOP_ABORT_GRACE_MS).toBe(10_000);
  expect(FACTORY_PHYSICAL_STOP_TIMEOUT_MS).toBe(20_000);
  expect(FACTORY_PHYSICAL_STOP_TIMEOUT_MS).toBeGreaterThan(FACTORY_STOP_ABORT_GRACE_MS);
  expect(new Set(FACTORY_TASK_STOP_CODES).size).toBe(FACTORY_TASK_STOP_CODES.length);
  expect(FACTORY_TASK_STOP_CODES).toEqual([
    "factory_task_stop_scope", "factory_task_stop_key_invalid", "factory_task_stop_invalid", "factory_task_stop_corrupt",
    "factory_task_stop_not_found", "factory_task_stop_conflict", "factory_task_stop_stale", "factory_task_stop_pool_mismatch",
    "factory_task_stop_proof_invalid", "factory_task_stop_clock_invalid", "factory_task_stop_timeout",
  ]);
  for (const code of FACTORY_TASK_STOP_CODES) {
    const error = new FactoryTaskStopError(code);
    expect({ name: error.name, code: error.code, message: error.message }).toEqual({ name: "FactoryTaskStopError", code, message: code });
  }
});
