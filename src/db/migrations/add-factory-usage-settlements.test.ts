import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { up } from "./add-factory-usage-settlements";

function rows<Row>(result: unknown): Row[] {
  return (result as { rows: Row[] }).rows;
}

test("usage settlement migration is repeatable and keeps one receipt per reservation", async () => {
  const fixture = await setupTestDb();
  try {
    await up(fixture.db); await up(fixture.db);
    const columns = rows<{ column_name: string; is_nullable: string }>(await fixture.db.execute(sql`SELECT column_name,is_nullable FROM information_schema.columns WHERE table_name='factory_usage_settlements' ORDER BY column_name`));
    expect(columns.map(row => row.column_name)).toEqual([
      "attempt_id", "created_at", "event_digest", "event_json", "known_cost_micros", "project_id",
      "provider_receipt_digest", "reservation_id", "revision", "run_id", "settled_at_ms", "settlement_digest",
      "source", "tenant_id", "unknown_cost_micros",
    ]);
    expect(columns.find(row => row.column_name === "unknown_cost_micros")?.is_nullable).toBe("YES");
    expect(columns.find(row => row.column_name === "known_cost_micros")?.is_nullable).toBe("NO");
    const definitions = rows<{ conname: string; definition: string }>(await fixture.db.execute(sql`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_usage_settlements'::regclass ORDER BY conname`));
    const joined = definitions.map(row => row.definition).join("\n");
    expect(joined).toContain("FOREIGN KEY (tenant_id, project_id, run_id, reservation_id) REFERENCES factory_budget_reservations");
    expect(joined).toContain("revision >= 1");
    expect(joined).toContain("known_cost_micros ~ '^[0-9]+$'");
    expect(joined).toContain("source <> 'reconciliation'::text) OR (provider_receipt_digest IS NOT NULL)");
    expect(definitions.every(row => row.conname.startsWith("factory_usage_settlements_"))).toBe(true);
    const index = rows<{ indexdef: string }>(await fixture.db.execute(sql`SELECT indexdef FROM pg_indexes WHERE tablename='factory_usage_settlements' AND indexname='uq_factory_usage_settlement_receipt'`));
    expect(index).toHaveLength(1);
    expect(index[0]!.indexdef).toContain("UNIQUE");
    expect(index[0]!.indexdef).toContain("WHERE (provider_receipt_digest IS NOT NULL)");
  } finally { await fixture.pglite.close(); }
});
