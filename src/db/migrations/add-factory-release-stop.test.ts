import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-release-stop";

const rows = <Row>(result: unknown): Row[] => (result as { rows: Row[] }).rows;

test("adds the release stop columns and checks once, and re-running changes nothing", async () => {
  const fixture = await setupTestDb();
  try {
    const columns = async () => rows<{ column_name: string }>(await fixture.db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name='factory_release_operations' AND column_name IN ('stop_command_id','stop_requested_epoch','stop_requested_at_ms','stop_event_json','stop_outcome','late_evidence_json') ORDER BY column_name`)).map(row => row.column_name);
    const checks = async () => rows<{ conname: string; oid: number }>(await fixture.db.execute(sql`SELECT conname, oid FROM pg_constraint WHERE conrelid='factory_release_operations'::regclass AND contype='c' AND conname IN ('factory_release_operations_stop_outcome_check','factory_release_operations_stop_fields_check') ORDER BY conname`));
    // migrate() already ran it; a repeat neither fails nor churns a constraint.
    expect(await columns()).toEqual(["late_evidence_json", "stop_command_id", "stop_event_json", "stop_outcome", "stop_requested_at_ms", "stop_requested_epoch"]);
    const installed = await checks();
    expect(installed.map(row => row.conname)).toEqual(["factory_release_operations_stop_fields_check", "factory_release_operations_stop_outcome_check"]);
    await up(fixture.db);
    expect(await checks()).toEqual(installed);
  } finally {
    await fixture.pglite.close();
  }
});
