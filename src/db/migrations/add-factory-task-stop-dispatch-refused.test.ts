import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-task-stop-dispatch-refused";

const rows = <Row>(result: unknown): Row[] => (result as { rows: Row[] }).rows;

test("a dispatch-refused stop has a worker, an attempt authority and no attempt row, every other source the reverse, and a rerun changes nothing (W02d R8)", async () => {
  const fixture = await setupTestDb();
  try {
    const checks = async () => rows<{ conname: string; oid: number; definition: string }>(await fixture.db.execute(sql`SELECT conname, oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='factory_task_stops'::regclass AND contype='c' AND conname IN ('factory_task_stops_source_check','factory_task_stops_dispatch_refused_check') ORDER BY conname`));
    const installed = await checks();
    expect(installed.map(check => check.conname)).toEqual(["factory_task_stops_dispatch_refused_check", "factory_task_stops_source_check"]);
    expect(installed[1]!.definition).toContain("'dispatch-refused'");
    // Both directions of both columns: NULL attempt exactly for this source, a worker exactly for this source.
    expect(installed[0]!.definition).toMatch(/source = 'dispatch-refused'::text\) = \(attempt_id IS NULL\)/);
    expect(installed[0]!.definition).toMatch(/source = 'dispatch-refused'::text\) = \(worker_id IS NOT NULL\)/);
    expect(installed[0]!.definition).toMatch(/source = 'dispatch-refused'::text\) = \(attempt_authority_json IS NOT NULL\)/);
    const [attempt] = rows<{ is_nullable: string }>(await fixture.db.execute(sql`SELECT is_nullable FROM information_schema.columns WHERE table_name='factory_task_stops' AND column_name='attempt_id'`));
    expect(attempt!.is_nullable).toBe("YES");
    // The foreign keys on attempt_id stay installed; a NULL only skips them.
    const keys = rows<{ conname: string }>(await fixture.db.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid='factory_task_stops'::regclass AND contype='f' AND conname IN ('factory_task_stops_execution_fk','factory_task_stops_launch_fk') ORDER BY conname`));
    expect(keys.map(key => key.conname)).toEqual(["factory_task_stops_execution_fk", "factory_task_stops_launch_fk"]);
    await up(fixture.db);
    expect(await checks()).toEqual(installed);
  } finally {
    await fixture.pglite.close();
  }
});
