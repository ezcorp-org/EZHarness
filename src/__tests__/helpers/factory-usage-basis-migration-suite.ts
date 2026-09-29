import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { MigrationDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { FACTORY_USAGE_BASIS_CHECK as BASIS_CHECK, up } from "../../db/migrations/add-factory-usage-nothing-launched-basis";
import { FACTORY_USAGE_NO_OPERATIONS_BASIS as RESERVED_BOUND, FACTORY_USAGE_NOTHING_LAUNCHED_BASIS as NOTHING_LAUNCHED } from "../../factory/usage-settlement";

/** A migrated database of either engine, and how to let it go. */
export interface FactoryUsageBasisMigrationFixture {
  readonly db: MigrationDb;
  close(): Promise<void>;
}

const digest = (character: string) => `sha256:${character.repeat(64)}`;

/** The driver wraps a database error, so the cause carries the real message. */
async function failure(action: Promise<unknown>): Promise<string> {
  try { await action; } catch (error) {
    const parts: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) parts.push(current.message);
    return parts.join(" | ");
  }
  throw new Error("Expected the database to refuse this statement.");
}

/**
 * W09h R4: add-factory-usage-nothing-launched-basis widens the no-operations basis set of an existing
 * installation by one member and removes nothing. Shared by the PGlite and the real-PostgreSQL case, so both
 * engines are held to one statement of the shape.
 */
export function factoryUsageBasisMigrationConformance(engine: string, open: () => Promise<FactoryUsageBasisMigrationFixture>): void {
  test(`${engine}: a W03e-shaped basis check gains "nothing launched, all zero" once, and keeps the reserved-bound basis`, async () => {
    const fixture = await open();
    const { db } = fixture;
    try {
      const check = async () => rows<{ oid: string; definition: string }>(await db.execute(sql`SELECT oid::text AS oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${BASIS_CHECK}`));
      // migrate() already ran it: both bases are allowed.
      const current = await check();
      expect(current).toHaveLength(1);
      expect(current[0]!.definition).toContain(`'${RESERVED_BOUND}'`);
      expect(current[0]!.definition).toContain(`'${NOTHING_LAUNCHED}'`);

      // Back to the shape an installation had after W03e and before W09h: one basis only.
      await db.execute(sql.raw(`ALTER TABLE factory_usage_settlements DROP CONSTRAINT ${BASIS_CHECK}`));
      await db.execute(sql.raw(`ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${BASIS_CHECK} CHECK ((source = 'no-operations') = (basis IS NOT NULL) AND (basis IS NULL OR basis = '${RESERVED_BOUND}'))`));
      expect((await check())[0]!.definition).not.toContain(NOTHING_LAUNCHED);
      await up(db);
      const migrated = await check();
      expect(migrated.map(row => row.definition)).toEqual(current.map(row => row.definition));
      // A second run changes nothing: the same constraint row, not a re-created one.
      await up(db);
      expect(await check()).toEqual(migrated);

      // The widened check: either basis on a no-operations zero; no basis elsewhere; no other basis.
      await db.execute(sql`ALTER TABLE factory_usage_settlements DROP CONSTRAINT factory_usage_settlements_reservation_fk`);
      const insert = (reservation: string, source: string, basis: string | null, stop: string | null) => db.execute(sql`INSERT INTO factory_usage_settlements (tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,stop_receipt_digest,basis,settled_at_ms,settlement_digest,event_json,event_digest)
        VALUES ('t','p','r',${reservation},1,'attempt-1',${source},'0',${stop},${basis},1,${digest("c")},'{}',${digest("c")})`);
      await insert("nothing-launched", "no-operations", NOTHING_LAUNCHED, digest("a"));
      await insert("reserved-bound", "no-operations", RESERVED_BOUND, digest("a"));
      expect(await failure(insert("other-basis", "no-operations", "no-operations: compute refunded", digest("a")))).toContain(BASIS_CHECK);
      expect(await failure(insert("no-basis", "no-operations", null, digest("a")))).toContain(BASIS_CHECK);
      expect(await failure(insert("basis-on-stop", "stop", NOTHING_LAUNCHED, null))).toContain(BASIS_CHECK);
      expect(rows<{ reservation_id: string; basis: string }>(await db.execute(sql`SELECT reservation_id, basis FROM factory_usage_settlements ORDER BY reservation_id`)))
        .toEqual([{ reservation_id: "nothing-launched", basis: NOTHING_LAUNCHED }, { reservation_id: "reserved-bound", basis: RESERVED_BOUND }]);
    } finally {
      await fixture.close();
    }
  });
}
