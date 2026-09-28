import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { FACTORY_COMPUTE_ADMISSION_STOP_CHECKS as STOP_CHECKS, FACTORY_COMPUTE_ADMISSION_STOP_COLUMNS as STOP_COLUMNS, up } from "./add-factory-compute-admission-stop";

const rows = <Row>(result: unknown): Row[] => (result as { rows: Row[] }).rows;

test("adds the admission stop columns and check to a table of the pre-W09h shape, once", async () => {
  const fixture = await setupTestDb();
  try {
    const shape = async () => ({
      columns: rows<{ column_name: string; data_type: string }>(await fixture.db.execute(sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='factory_compute_admissions' AND column_name IN ${sql.raw(`(${STOP_COLUMNS.map(name => `'${name}'`).join(",")})`)} ORDER BY column_name`)),
      checks: rows<{ conname: string; definition: string }>(await fixture.db.execute(sql`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_compute_admissions'::regclass AND contype='c' AND conname IN ${sql.raw(`(${STOP_CHECKS.map(name => `'${name}'`).join(",")})`)} ORDER BY conname`)),
    });
    // migrate() already ran it.
    const current = await shape();
    expect(current.columns.map(column => column.column_name)).toEqual([...STOP_COLUMNS].sort());
    expect(current.checks.map(check => check.conname)).toEqual([...STOP_CHECKS]);
    // A stopped admission can never be admitted.
    expect(current.checks[0]!.definition).toContain("state <> 'admitted'");
    // Back to the shape an installation had before W09h, then migrated again: the explicit ALTERs add everything.
    for (const check of STOP_CHECKS) await fixture.db.execute(sql.raw(`ALTER TABLE factory_compute_admissions DROP CONSTRAINT ${check}`));
    for (const column of STOP_COLUMNS) await fixture.db.execute(sql.raw(`ALTER TABLE factory_compute_admissions DROP COLUMN ${column}`));
    expect(await shape()).toEqual({ columns: [], checks: [] });
    await up(fixture.db);
    expect(await shape()).toEqual(current);
    // A second run changes nothing.
    await up(fixture.db);
    expect(await shape()).toEqual(current);
  } finally {
    await fixture.pglite.close();
  }
});
