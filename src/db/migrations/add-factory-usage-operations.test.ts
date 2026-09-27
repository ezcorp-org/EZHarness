import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up as upNoOperations } from "./add-factory-usage-no-operations";
import { up } from "./add-factory-usage-operations";

type Database = Awaited<ReturnType<typeof setupTestDb>>["db"];

function rows<Row>(result: unknown): Row[] {
  return (result as { rows: Row[] }).rows;
}

const WIDENED = ["factory_usage_settlements_source_check", "factory_usage_settlements_no_operations_check", "factory_usage_settlements_basis_check"] as const;

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
const NO_OPERATIONS = "no-operations: compute at reserved bound";
const PROVIDER_ERROR = "provider-error: model usage measured, compute at reserved bound";
const OPERATIONS = "operations: model usage measured, compute at reserved bound";

/** One row, with the reservation foreign key out of the way so each case states one fact. */
function insert(database: Database, reservation: string, row: { source: string; known: string; unknown?: string; provider?: string; stop?: string; basis?: string }) {
  return database.execute(sql`INSERT INTO factory_usage_settlements (tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,unknown_cost_micros,provider_receipt_digest,stop_receipt_digest,basis,settled_at_ms,settlement_digest,event_json,event_digest)
    VALUES ('t','p','r',${reservation},1,'attempt-1',${row.source},${row.known},${row.unknown ?? null},${row.provider ?? null},${row.stop ?? null},${row.basis ?? null},1,${digest("c")},'{}',${digest("c")})`);
}

test("migrate() installs the widened CHECKs, and re-running either settlement migration changes nothing", async () => {
  const fixture = await setupTestDb();
  try {
    const installed = await constraints(fixture.db);
    await up(fixture.db);
    await upNoOperations(fixture.db);
    await up(fixture.db);
    expect(await constraints(fixture.db)).toEqual(installed);
    for (const name of WIDENED) expect(installed[name]!.definition).toContain("'operations'");
    expect(installed.factory_usage_settlements_basis_check!.definition).toContain(PROVIDER_ERROR);
    expect(installed.factory_usage_settlements_basis_check!.definition).toContain(OPERATIONS);
  } finally { await fixture.pglite.close(); }
});

test("widens W03e's CHECKs once, and then an operations settlement's shape is exact", async () => {
  const fixture = await setupTestDb();
  try {
    // The table as W03e left it: its three narrower CHECKs.
    for (const name of WIDENED) await fixture.db.execute(sql.raw(`ALTER TABLE factory_usage_settlements DROP CONSTRAINT ${name}`));
    await upNoOperations(fixture.db);
    await fixture.db.execute(sql`ALTER TABLE factory_usage_settlements DROP CONSTRAINT factory_usage_settlements_reservation_fk`);
    // Refused by W03e's narrower CHECKs; which of them PostgreSQL reports first is not part of the contract.
    expect(await failure(insert(fixture.db, "before", { source: "operations", known: "0", stop: digest("a"), basis: PROVIDER_ERROR }))).toMatch(/factory_usage_settlements_(source|no_operations|basis)_check/);
    for (const name of WIDENED) expect((await constraints(fixture.db))[name]!.definition).not.toContain("'operations'");

    await up(fixture.db);
    const widened = await constraints(fixture.db);
    await up(fixture.db);
    expect(await constraints(fixture.db)).toEqual(widened);

    await insert(fixture.db, "accepted-provider-zero", { source: "operations", known: "0", stop: digest("a"), basis: PROVIDER_ERROR });
    await insert(fixture.db, "accepted-partial", { source: "operations", known: "1200", stop: digest("b"), basis: PROVIDER_ERROR });
    await insert(fixture.db, "accepted-operations", { source: "operations", known: "31", stop: digest("d"), basis: OPERATIONS });
    await insert(fixture.db, "accepted-no-operations", { source: "no-operations", known: "0", stop: digest("e"), basis: NO_OPERATIONS });
    await insert(fixture.db, "accepted-stop", { source: "stop", known: "0", unknown: "900" });
    await insert(fixture.db, "accepted-reconciliation", { source: "reconciliation", known: "5", provider: "b".repeat(64) });
    const refused: Array<[string, Parameters<typeof insert>[2], string]> = [
      ["operations-without-stop", { source: "operations", known: "0", basis: PROVIDER_ERROR }, "factory_usage_settlements_no_operations_check"],
      ["operations-held", { source: "operations", known: "0", unknown: "5", stop: digest("a"), basis: PROVIDER_ERROR }, "factory_usage_settlements_no_operations_check"],
      ["operations-provider-receipt", { source: "operations", known: "0", provider: "b".repeat(64), stop: digest("a"), basis: PROVIDER_ERROR }, "factory_usage_settlements_no_operations_check"],
      ["no-operations-nonzero", { source: "no-operations", known: "1", stop: digest("a"), basis: NO_OPERATIONS }, "factory_usage_settlements_no_operations_check"],
      ["stop-with-receipt", { source: "stop", known: "4", stop: digest("a") }, "factory_usage_settlements_no_operations_check"],
      ["operations-without-basis", { source: "operations", known: "0", stop: digest("a") }, "factory_usage_settlements_basis_check"],
      ["operations-with-zero-basis", { source: "operations", known: "0", stop: digest("a"), basis: NO_OPERATIONS }, "factory_usage_settlements_basis_check"],
      ["no-operations-with-provider-basis", { source: "no-operations", known: "0", stop: digest("a"), basis: PROVIDER_ERROR }, "factory_usage_settlements_basis_check"],
      ["operations-other-basis", { source: "operations", known: "0", stop: digest("a"), basis: "provider-error: compute refunded" }, "factory_usage_settlements_basis_check"],
      ["basis-on-stop", { source: "stop", known: "4", basis: OPERATIONS }, "factory_usage_settlements_basis_check"],
      ["unknown-source", { source: "estimate", known: "0" }, "factory_usage_settlements_source_check"],
    ];
    for (const [reservation, row, constraint] of refused) expect({ reservation, refused: await failure(insert(fixture.db, reservation, row)) }).toEqual({ reservation, refused: expect.stringContaining(constraint) });
    expect(rows<{ reservation_id: string }>(await fixture.db.execute(sql`SELECT reservation_id FROM factory_usage_settlements ORDER BY reservation_id`)).map(row => row.reservation_id))
      .toEqual(["accepted-no-operations", "accepted-operations", "accepted-partial", "accepted-provider-zero", "accepted-reconciliation", "accepted-stop"]);
  } finally { await fixture.pglite.close(); }
});
