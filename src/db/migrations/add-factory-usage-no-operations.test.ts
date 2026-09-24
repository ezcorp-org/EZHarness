import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-usage-no-operations";

type Database = Awaited<ReturnType<typeof setupTestDb>>["db"];

function rows<Row>(result: unknown): Row[] {
  return (result as { rows: Row[] }).rows;
}

async function constraints(database: Database): Promise<Record<string, { oid: number; definition: string }>> {
  const found = rows<{ conname: string; oid: number; definition: string }>(await database.execute(sql`SELECT conname, oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_usage_settlements'::regclass AND contype='c'`));
  return Object.fromEntries(found.map(row => [row.conname, { oid: row.oid, definition: row.definition }]));
}

/** The driver wraps a database error, so the cause carries the real message. */
async function failure(action: Promise<unknown>): Promise<string> {
  try { await action; } catch (error) {
    const parts: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) parts.push(current.message);
    return parts.join(" | ");
  }
  throw new Error("Expected the database to refuse this statement.");
}

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const BASIS = "no-operations: compute at reserved bound";

/** One row, with the reservation foreign key out of the way so each case states one fact. */
function insert(database: Database, reservation: string, row: { source: string; known: string; unknown?: string; provider?: string; stop?: string; basis?: string }) {
  return database.execute(sql`INSERT INTO factory_usage_settlements (tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,unknown_cost_micros,provider_receipt_digest,stop_receipt_digest,basis,settled_at_ms,settlement_digest,event_json,event_digest)
    VALUES ('t','p','r',${reservation},1,'attempt-1',${row.source},${row.known},${row.unknown ?? null},${row.provider ?? null},${row.stop ?? null},${row.basis ?? null},1,${digest("c")},'{}',${digest("c")})`);
}

test("admits the typed no-operations zero with its stop receipt, and re-running changes nothing", async () => {
  const fixture = await setupTestDb();
  try {
    // migrate() already ran it; repeats must neither fail nor churn a constraint.
    const installed = await constraints(fixture.db);
    await up(fixture.db);
    await up(fixture.db);
    expect(await constraints(fixture.db)).toEqual(installed);
    expect(installed.factory_usage_settlements_source_check!.definition).toContain("no-operations");
    expect(installed.factory_usage_settlements_stop_receipt_check!.definition).toContain("sha256:[0-9a-f]{64}");
    expect(installed.factory_usage_settlements_no_operations_check).toBeDefined();
    expect(installed.factory_usage_settlements_basis_check!.definition).toContain(BASIS);
    const column = rows<{ is_nullable: string }>(await fixture.db.execute(sql`SELECT is_nullable FROM information_schema.columns WHERE table_name='factory_usage_settlements' AND column_name='stop_receipt_digest'`));
    expect(column).toEqual([{ is_nullable: "YES" }]);
  } finally { await fixture.pglite.close(); }
});

test("replaces the two-source CHECK once, and then the shape of a no-operations zero is exact", async () => {
  const fixture = await setupTestDb();
  try {
    // The table as it stood before this migration: the old source CHECK and no new column.
    await fixture.db.execute(sql`ALTER TABLE factory_usage_settlements DROP CONSTRAINT factory_usage_settlements_no_operations_check`);
    await fixture.db.execute(sql`ALTER TABLE factory_usage_settlements DROP CONSTRAINT factory_usage_settlements_basis_check`);
    await fixture.db.execute(sql`ALTER TABLE factory_usage_settlements DROP COLUMN basis`);
    await fixture.db.execute(sql`ALTER TABLE factory_usage_settlements DROP CONSTRAINT factory_usage_settlements_stop_receipt_check`);
    await fixture.db.execute(sql`ALTER TABLE factory_usage_settlements DROP COLUMN stop_receipt_digest`);
    await fixture.db.execute(sql`ALTER TABLE factory_usage_settlements DROP CONSTRAINT factory_usage_settlements_source_check`);
    await fixture.db.execute(sql`ALTER TABLE factory_usage_settlements ADD CONSTRAINT factory_usage_settlements_source_check CHECK (source IN ('stop','reconciliation'))`);
    await up(fixture.db);
    expect((await constraints(fixture.db)).factory_usage_settlements_source_check!.definition).toContain("no-operations");

    await fixture.db.execute(sql`ALTER TABLE factory_usage_settlements DROP CONSTRAINT factory_usage_settlements_reservation_fk`);
    await insert(fixture.db, "accepted-zero", { source: "no-operations", known: "0", stop: digest("a"), basis: BASIS });
    await insert(fixture.db, "accepted-stop", { source: "stop", known: "0", unknown: "900" });
    await insert(fixture.db, "accepted-reconciliation", { source: "reconciliation", known: "5", provider: "b".repeat(64) });
    const refused: Array<[string, Parameters<typeof insert>[2], string]> = [
      ["zero-without-stop", { source: "no-operations", known: "0", basis: BASIS }, "factory_usage_settlements_no_operations_check"],
      ["stop-on-measured", { source: "stop", known: "4", stop: digest("a") }, "factory_usage_settlements_no_operations_check"],
      ["nonzero", { source: "no-operations", known: "1", stop: digest("a"), basis: BASIS }, "factory_usage_settlements_no_operations_check"],
      ["held", { source: "no-operations", known: "0", unknown: "5", stop: digest("a"), basis: BASIS }, "factory_usage_settlements_no_operations_check"],
      ["provider", { source: "no-operations", known: "0", provider: "b".repeat(64), stop: digest("a"), basis: BASIS }, "factory_usage_settlements_no_operations_check"],
      ["bare-stop", { source: "no-operations", known: "0", stop: "a".repeat(64), basis: BASIS }, "factory_usage_settlements_stop_receipt_check"],
      ["zero-without-basis", { source: "no-operations", known: "0", stop: digest("a") }, "factory_usage_settlements_basis_check"],
      ["other-basis", { source: "no-operations", known: "0", stop: digest("a"), basis: "no-operations: compute refunded" }, "factory_usage_settlements_basis_check"],
      ["basis-on-measured", { source: "stop", known: "4", basis: BASIS }, "factory_usage_settlements_basis_check"],
      ["unknown-source", { source: "estimate", known: "0" }, "factory_usage_settlements_source_check"],
    ];
    for (const [reservation, row, constraint] of refused) expect(await failure(insert(fixture.db, reservation, row))).toContain(constraint);
    expect(rows<{ reservation_id: string }>(await fixture.db.execute(sql`SELECT reservation_id FROM factory_usage_settlements ORDER BY reservation_id`)).map(row => row.reservation_id))
      .toEqual(["accepted-reconciliation", "accepted-stop", "accepted-zero"]);
  } finally { await fixture.pglite.close(); }
});
