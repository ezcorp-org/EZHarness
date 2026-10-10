import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-usage-receipt-c02-form";

function rows<Row>(result: unknown): Row[] {
  return (result as { rows: Row[] }).rows;
}

async function receiptCheck(database: Awaited<ReturnType<typeof setupTestDb>>["db"]): Promise<string | undefined> {
  return rows<{ definition: string }>(await database.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_usage_settlements'::regclass AND conname='factory_usage_settlements_receipt_check'`))[0]?.definition;
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

/** Reinstates the retired prefixed CHECK so the migration has work to do. */
async function withOldForm(database: Awaited<ReturnType<typeof setupTestDb>>["db"]): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_usage_settlements DROP CONSTRAINT factory_usage_settlements_receipt_check`);
  await database.execute(sql`ALTER TABLE factory_usage_settlements ADD CONSTRAINT factory_usage_settlements_receipt_check CHECK (provider_receipt_digest IS NULL OR provider_receipt_digest ~ '^sha256:[0-9a-f]{64}$')`);
}

test("the receipt CHECK ends up on the C02 bare form and re-running changes nothing", async () => {
  const fixture = await setupTestDb();
  try {
    // migrate() has already run it once; running it again must be a no-op, and
    // must not churn the catalog entry for a constraint that is already right.
    const installed = await receiptCheck(fixture.db);
    expect(installed).toContain("[0-9a-f]{64}");
    expect(installed).not.toContain("sha256:");
    const before = rows<{ oid: number }>(await fixture.db.execute(sql`SELECT oid FROM pg_constraint WHERE conrelid='factory_usage_settlements'::regclass AND conname='factory_usage_settlements_receipt_check'`))[0]!.oid;
    await up(fixture.db);
    await up(fixture.db);
    expect(await receiptCheck(fixture.db)).toBe(installed!);
    expect(rows<{ oid: number }>(await fixture.db.execute(sql`SELECT oid FROM pg_constraint WHERE conrelid='factory_usage_settlements'::regclass AND conname='factory_usage_settlements_receipt_check'`))[0]!.oid).toBe(before);
  } finally { await fixture.pglite.close(); }
});

test("replaces the prefixed CHECK and then refuses a prefixed digest outright", async () => {
  const fixture = await setupTestDb();
  try {
    await withOldForm(fixture.db);
    expect(await receiptCheck(fixture.db)).toContain("sha256:");
    await up(fixture.db);
    const replaced = await receiptCheck(fixture.db);
    expect(replaced).toContain("[0-9a-f]{64}");
    expect(replaced).not.toContain("sha256:");

    // The column, not just the regex text: the reservation foreign key is out
    // of the way so this test states one fact, which is the accepted form.
    await fixture.db.execute(sql`ALTER TABLE factory_usage_settlements DROP CONSTRAINT factory_usage_settlements_reservation_fk`);
    const insert = (reservation: string, digest: string) => fixture.db.execute(sql`INSERT INTO factory_usage_settlements (tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,provider_receipt_digest,settled_at_ms,settlement_digest,event_json,event_digest)
      VALUES ('t','p','r',${reservation},1,'attempt-1','reconciliation','5',${digest},1,${`sha256:${"c".repeat(64)}`},'{}'::jsonb,${`sha256:${"c".repeat(64)}`})`);
    await insert("reservation-accepted", "a".repeat(64));
    const refused = [`sha256:${"a".repeat(64)}`, "A".repeat(64), "a".repeat(63), `${"a".repeat(64)} `];
    for (const [index, digest] of refused.entries()) {
      expect(await failure(insert(`reservation-refused-${index}`, digest))).toContain("factory_usage_settlements_receipt_check");
    }
  } finally { await fixture.pglite.close(); }
});

test("fails loudly rather than relaxing a CHECK that a stored digest still needs", async () => {
  const fixture = await setupTestDb();
  try {
    await withOldForm(fixture.db);
    await fixture.db.execute(sql`ALTER TABLE factory_usage_settlements DROP CONSTRAINT factory_usage_settlements_reservation_fk`);
    await fixture.db.execute(sql`INSERT INTO factory_usage_settlements (tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,provider_receipt_digest,settled_at_ms,settlement_digest,event_json,event_digest)
      VALUES ('t','p','r','reservation-1',1,'attempt-1','reconciliation','5',${`sha256:${"a".repeat(64)}`},1,${`sha256:${"c".repeat(64)}`},'{}'::jsonb,${`sha256:${"c".repeat(64)}`})`);
    expect(await failure(up(fixture.db))).toContain("holds 1 provider receipt digests that are not the C02 bare form");
    // The old CHECK is still standing, so the row is still protected by the
    // rule it was written under.
    expect(await receiptCheck(fixture.db)).toContain("sha256:");
  } finally { await fixture.pglite.close(); }
});

test("does nothing when the settlement table has not been created yet", async () => {
  const fixture = await setupTestDb();
  try {
    await fixture.db.execute(sql`DROP TABLE factory_usage_settlements`);
    await up(fixture.db);
    expect(rows<{ present: boolean }>(await fixture.db.execute(sql`SELECT to_regclass('factory_usage_settlements') IS NOT NULL AS present`))[0]!.present).toBe(false);
  } finally { await fixture.pglite.close(); }
});
