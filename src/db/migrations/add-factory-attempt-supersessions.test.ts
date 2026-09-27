import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-attempt-supersessions";

function rows<Row>(result: unknown): Row[] {
  return (result as { rows: Row[] }).rows;
}

type Database = Awaited<ReturnType<typeof setupTestDb>>["db"];

async function statusCheck(database: Database): Promise<{ oid: number; definition: string } | undefined> {
  return rows<{ oid: number; definition: string }>(await database.execute(sql`SELECT oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'factory_executions'::regclass AND conname = 'factory_executions_status_check'`))[0];
}

async function table(database: Database): Promise<string[]> {
  return rows<{ column_name: string }>(await database.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'factory_attempt_supersessions' ORDER BY ordinal_position`)).map(row => row.column_name);
}

test("an execution can end superseded, the record table exists, and re-running churns nothing", async () => {
  const fixture = await setupTestDb();
  try {
    const installed = await statusCheck(fixture.db);
    expect(installed?.definition).toContain("superseded");
    expect(await table(fixture.db)).toEqual(["tenant_id", "project_id", "run_id", "attempt_id", "reservation_id", "interpreter_id", "superseded_epoch", "execution_epoch", "restore_id", "restore_digest", "event_json", "superseded_at_ms"]);
    // A stop can end superseded, naming its restore.
    const stopState = rows<{ oid: number; definition: string }>(await fixture.db.execute(sql`SELECT oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'factory_task_stops'::regclass AND conname = 'factory_task_stops_state_check'`))[0];
    expect(stopState?.definition).toContain("superseded");
    await up(fixture.db);
    // The same constraints, not dropped-and-re-added ones.
    expect((await statusCheck(fixture.db))?.oid).toBe(installed?.oid);
    expect(rows<{ oid: number }>(await fixture.db.execute(sql`SELECT oid FROM pg_constraint WHERE conrelid = 'factory_task_stops'::regclass AND conname = 'factory_task_stops_state_check'`))[0]?.oid).toBe(stopState?.oid);
  } finally { await fixture.pglite.close(); }
});

test("a store still holding the status check without superseded has it replaced", async () => {
  const fixture = await setupTestDb();
  try {
    await fixture.db.execute(sql`ALTER TABLE factory_executions DROP CONSTRAINT factory_executions_status_check`);
    await fixture.db.execute(sql`ALTER TABLE factory_executions ADD CONSTRAINT factory_executions_status_check CHECK (status IN ('admitted','running','completed','cancel_accepted','stopped','failed'))`);
    await up(fixture.db);
    expect((await statusCheck(fixture.db))?.definition).toContain("superseded");
    // A store with no status check at all gets one.
    await fixture.db.execute(sql`ALTER TABLE factory_executions DROP CONSTRAINT factory_executions_status_check`);
    await up(fixture.db);
    expect((await statusCheck(fixture.db))?.definition).toContain("superseded");
  } finally { await fixture.pglite.close(); }
});

test("a record whose kernel event has no interpreter, or whose epochs do not advance, is refused", async () => {
  const fixture = await setupTestDb();
  try {
    const refused = async (statement: ReturnType<typeof sql>) => {
      let message = "";
      try { await fixture.db.execute(statement); } catch (error) { for (let current: unknown = error; current instanceof Error; current = current.cause) message += current.message; }
      return message;
    };
    // CHECK constraints are evaluated before the foreign key, so each row fails on its CHECK.
    expect(await refused(sql`INSERT INTO factory_attempt_supersessions VALUES ('t','p','r','a',NULL,'root',1,2,'restore',${`sha256:${"a".repeat(64)}`},NULL,0)`)).toContain("factory_attempt_supersessions_event_check");
    expect(await refused(sql`INSERT INTO factory_attempt_supersessions VALUES ('t','p','r','a',NULL,NULL,2,2,'restore',${`sha256:${"a".repeat(64)}`},NULL,0)`)).toContain("factory_attempt_supersessions_epoch_check");
    // A superseded stop must name its restore, and only a superseded stop may.
    // The pairing check is what refuses these; the accepted-state check admits a bare superseded stop.
    // An uncertain row carries its uncertain event, so only the pairing check can refuse it.
    const stop = (state: string, restoreId: string | null) => {
      const event = state === "uncertain" ? "{}" : null, digest = state === "uncertain" ? `sha256:${"a".repeat(64)}` : null;
      return sql`INSERT INTO factory_task_stops (tenant_id, project_id, run_id, interpreter_id, cancel_command_id, attempt_id, reservation_id, request_json, request_digest, source, state, accepted_at_ms, superseded_restore_id, uncertain_event_json, uncertain_event_digest)
        VALUES ('t','p','r','i','c','a','res','{}',${`sha256:${"a".repeat(64)}`},'sealed-launch',${state},0,${restoreId},${event},${digest})`;
    };
    expect(await refused(stop("superseded", null))).toContain("factory_task_stops_superseded_check");
    expect(await refused(stop("uncertain", "restore"))).toContain("factory_task_stops_superseded_check");
  } finally { await fixture.pglite.close(); }
});
