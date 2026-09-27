/**
 * W09e: add-factory-release-stop migrates an existing installation's release table, not only a fresh one.
 *
 * The database is migrated to the current shape, then taken back to the shape before W09e (the stop
 * columns and checks dropped), then migrated again: the explicit ALTERs must add every column and check,
 * and a second run must change nothing.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { FACTORY_RELEASE_STOP_CHECKS as STOP_CHECKS, FACTORY_RELEASE_STOP_COLUMNS as STOP_COLUMNS, up } from "../../src/db/migrations/add-factory-release-stop";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
beforeAll(async () => { fixture = await setupFactoryPostgres(); });
afterAll(async () => { await fixture.close(); });


async function shape() {
  const columns = rows<{ column_name: string; data_type: string }>(await fixture.db.execute(sql`SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'factory_release_operations' AND column_name IN ${sql.raw(`(${STOP_COLUMNS.map(name => `'${name}'`).join(",")})`)} ORDER BY column_name`));
  const checks = rows<{ conname: string; oid: number | string; definition: string }>(await fixture.db.execute(sql`SELECT conname, oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'factory_release_operations'::regclass AND contype = 'c' AND conname IN ${sql.raw(`(${STOP_CHECKS.map(name => `'${name}'`).join(",")})`)} ORDER BY conname`));
  return { columns, checks };
}

test("the release stop columns and checks are added to a table of the pre-W09e shape, once", async () => {
  const current = await shape();
  expect(current.columns.map(column => column.column_name)).toEqual([...STOP_COLUMNS].sort());
  expect(current.checks.map(check => check.conname)).toEqual([...STOP_CHECKS].sort());

  // Back to the shape an installation had before W09e.
  for (const check of STOP_CHECKS) await fixture.db.execute(sql.raw(`ALTER TABLE factory_release_operations DROP CONSTRAINT ${check}`));
  for (const column of STOP_COLUMNS) await fixture.db.execute(sql.raw(`ALTER TABLE factory_release_operations DROP COLUMN ${column}`));
  expect(await shape()).toEqual({ columns: [], checks: [] });

  await up(fixture.db);
  const migrated = await shape();
  expect(migrated.columns).toEqual(current.columns);
  expect(migrated.checks.map(check => [check.conname, check.definition])).toEqual(current.checks.map(check => [check.conname, check.definition]));
  expect(migrated.checks.find(check => check.conname === "factory_release_operations_stop_outcome_check")?.definition).toContain("'unknown_at_deadline'");
  expect(migrated.checks.find(check => check.conname === "factory_release_operations_stop_cost_check")?.definition).toContain("'reserved-bound'");

  // A second run changes nothing: the same columns and the same constraint rows.
  await up(fixture.db);
  expect(await shape()).toEqual(migrated);
});
