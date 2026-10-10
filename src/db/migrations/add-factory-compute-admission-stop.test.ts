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

/** The driver wraps a database error, so the cause carries the real message. */
async function failure(action: Promise<unknown>): Promise<string> {
  try { await action; } catch (error) {
    const parts: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) parts.push(current.message);
    return parts.join(" | ");
  }
  throw new Error("Expected the database to refuse this statement.");
}

test("the stop check is all-or-none over the four stop columns, bounded, and never on an admitted row", async () => {
  const fixture = await setupTestDb();
  try {
    const db = fixture.db;
    // The check under test is the one this migration installs.
    await db.execute(sql.raw(`ALTER TABLE factory_compute_admissions DROP CONSTRAINT ${STOP_CHECKS[0]}`));
    await up(db);
    // Foreign keys out of the way, so each row states one fact about the stop columns.
    for (const { conname } of rows<{ conname: string }>(await db.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid='factory_compute_admissions'::regclass AND contype='f'`))) {
      await db.execute(sql.raw(`ALTER TABLE factory_compute_admissions DROP CONSTRAINT ${conname}`));
    }
    type Stop = { command?: string; epoch?: number; atMs?: number; event?: string; state?: string };
    const insert = (reservation: string, stop: Stop) => db.execute(sql`INSERT INTO factory_compute_admissions (tenant_id,project_id,run_id,reservation_id,request_digest,request_json,state,next_poll_at,event_digest,event_json,stop_command_id,stop_requested_epoch,stop_requested_at_ms,stop_event_json)
      VALUES ('t','p','r',${reservation},${`sha256:${"a".repeat(64)}`},'{}',${stop.state ?? "pending"},0,${stop.state === "admitted" ? `sha256:${"b".repeat(64)}` : null},${stop.state === "admitted" ? "{}" : null},${stop.command ?? null},${stop.epoch ?? null},${stop.atMs ?? null},${stop.event ?? null})`);
    const whole: Stop = { command: "cancel-node-1", epoch: 1, atMs: 0, event: "{}" };
    await insert("no-stop", {});
    await insert("stopped", whole);
    await insert("stopped-cancelled", { ...whole, state: "cancelled" });
    const refused: Array<[string, Stop]> = [
      // A stop names its command, epoch, time and event together, or none of them.
      ["without-epoch", { ...whole, epoch: undefined }],
      ["without-time", { ...whole, atMs: undefined }],
      ["without-event", { ...whole, event: undefined }],
      ["epoch-only", { epoch: 1 }],
      ["time-only", { atMs: 0 }],
      ["event-only", { event: "{}" }],
      ["epoch-zero", { ...whole, epoch: 0 }],
      ["negative-time", { ...whole, atMs: -1 }],
      // A stopped admission can never be admitted.
      ["stopped-admitted", { ...whole, state: "admitted" }],
    ];
    for (const [reservation, stop] of refused) expect({ reservation, error: await failure(insert(reservation, stop)) }).toEqual({ reservation, error: expect.stringContaining(STOP_CHECKS[0]) });
    expect(rows<{ reservation_id: string }>(await db.execute(sql`SELECT reservation_id FROM factory_compute_admissions WHERE tenant_id='t' ORDER BY reservation_id`)).map(row => row.reservation_id))
      .toEqual(["no-stop", "stopped", "stopped-cancelled"]);
  } finally {
    await fixture.pglite.close();
  }
});
