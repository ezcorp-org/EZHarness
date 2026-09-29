import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { FACTORY_RELEASE_STOP_CHECKS, FACTORY_RELEASE_STOP_COLUMNS, up } from "./add-factory-release-stop";

const rows = <Row>(result: unknown): Row[] => (result as { rows: Row[] }).rows;

test("adds the release stop columns and checks once, and re-running changes nothing", async () => {
  const fixture = await setupTestDb();
  try {
    const columns = async () => rows<{ column_name: string }>(await fixture.db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name='factory_release_operations' AND column_name IN ${sql.raw(`(${FACTORY_RELEASE_STOP_COLUMNS.map(name => `'${name}'`).join(",")})`)} ORDER BY column_name`)).map(row => row.column_name);
    const checks = async () => rows<{ conname: string; oid: number }>(await fixture.db.execute(sql`SELECT conname, oid FROM pg_constraint WHERE conrelid='factory_release_operations'::regclass AND contype='c' AND conname IN ${sql.raw(`(${FACTORY_RELEASE_STOP_CHECKS.map(name => `'${name}'`).join(",")})`)} ORDER BY conname`));
    // migrate() already ran it; a repeat neither fails nor churns a constraint.
    expect(await columns()).toEqual([...FACTORY_RELEASE_STOP_COLUMNS].sort());
    expect(FACTORY_RELEASE_STOP_COLUMNS).toContain("stop_cost_micros");
    const installed = await checks();
    expect(installed.map(row => row.conname)).toEqual([...FACTORY_RELEASE_STOP_CHECKS].sort());
    expect(FACTORY_RELEASE_STOP_CHECKS).toContain("factory_release_operations_stop_cost_check");
    // A published outcome is charged at the receipt's spend or the reserved bound, never as proven free.
    const [cost] = rows<{ definition: string }>(await fixture.db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='factory_release_operations_stop_cost_check'`));
    expect(cost!.definition).toMatch(/stop_outcome IS DISTINCT FROM 'published'.*stop_cost_source = ANY \(ARRAY\['provider-receipt'::text, 'reserved-bound'::text\]\)/s);
    await up(fixture.db);
    expect(await checks()).toEqual(installed);
  } finally {
    await fixture.pglite.close();
  }
});
