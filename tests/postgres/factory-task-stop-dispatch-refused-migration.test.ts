/**
 * W02d R8: add-factory-task-stop-dispatch-refused migrates an existing installation's stop table, not only a fresh one.
 *
 * The database is migrated to the current shape, then taken back to the shape before R8 (attempt_id NOT NULL, no
 * worker_id or attempt_authority_json, the two-source CHECK, no dispatch-refused CHECK), then migrated again: the explicit ALTERs must restore
 * every piece, and a second run must change nothing.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { up } from "../../src/db/migrations/add-factory-task-stop-dispatch-refused";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
beforeAll(async () => { fixture = await setupFactoryPostgres(); });
afterAll(async () => { await fixture.close(); });

async function shape() {
  const columns = rows<{ column_name: string; is_nullable: string }>(await fixture.db.execute(sql`SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'factory_task_stops' AND column_name IN ('attempt_authority_json','attempt_id','worker_id') ORDER BY column_name`));
  const checks = rows<{ conname: string; oid: number | string; definition: string }>(await fixture.db.execute(sql`SELECT conname, oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'factory_task_stops'::regclass AND contype = 'c' AND conname IN ('factory_task_stops_source_check','factory_task_stops_dispatch_refused_check') ORDER BY conname`));
  return { columns, checks };
}

test("the dispatch-refused stop shape is added to a stop table of the pre-R8 shape, once", async () => {
  const current = await shape();
  expect(current.columns).toEqual([{ column_name: "attempt_authority_json", is_nullable: "YES" }, { column_name: "attempt_id", is_nullable: "YES" }, { column_name: "worker_id", is_nullable: "YES" }]);
  expect(current.checks.map(check => check.conname)).toEqual(["factory_task_stops_dispatch_refused_check", "factory_task_stops_source_check"]);

  // Back to the shape an installation had before R8 (no stop row of the new source exists in this database).
  await fixture.db.execute(sql`ALTER TABLE factory_task_stops DROP CONSTRAINT factory_task_stops_dispatch_refused_check`);
  await fixture.db.execute(sql`ALTER TABLE factory_task_stops DROP CONSTRAINT factory_task_stops_source_check`);
  await fixture.db.execute(sql`ALTER TABLE factory_task_stops ADD CONSTRAINT factory_task_stops_source_check CHECK (source IN ('terminal-outcome','sealed-launch'))`);
  await fixture.db.execute(sql`ALTER TABLE factory_task_stops DROP COLUMN worker_id`);
  await fixture.db.execute(sql`ALTER TABLE factory_task_stops DROP COLUMN attempt_authority_json`);
  await fixture.db.execute(sql`ALTER TABLE factory_task_stops ALTER COLUMN attempt_id SET NOT NULL`);
  const old = await shape();
  expect(old.columns).toEqual([{ column_name: "attempt_id", is_nullable: "NO" }]);
  expect(old.checks.map(check => check.definition)).toEqual([expect.not.stringContaining("dispatch-refused")]);

  await up(fixture.db);
  const migrated = await shape();
  expect(migrated.columns).toEqual(current.columns);
  expect(migrated.checks.map(check => [check.conname, check.definition])).toEqual(current.checks.map(check => [check.conname, check.definition]));

  // A second run changes nothing: the same constraint rows.
  await up(fixture.db);
  expect(await shape()).toEqual(migrated);
});
