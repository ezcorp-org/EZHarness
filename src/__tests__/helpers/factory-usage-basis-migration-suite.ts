import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { MigrationDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { up as upNoOperations } from "../../db/migrations/add-factory-usage-no-operations";
import { up as upOperations } from "../../db/migrations/add-factory-usage-operations";
import { FACTORY_USAGE_BASIS_CHECK as BASIS_CHECK, up as upNothingLaunched } from "../../db/migrations/add-factory-usage-nothing-launched-basis";
import {
  FACTORY_USAGE_NO_OPERATIONS_BASIS as RESERVED_BOUND,
  FACTORY_USAGE_NOTHING_LAUNCHED_BASIS as NOTHING_LAUNCHED,
  FACTORY_USAGE_OPERATIONS_BASIS as OPERATIONS,
  FACTORY_USAGE_PROVIDER_ERROR_BASIS as PROVIDER_ERROR,
  FACTORY_USAGE_RESERVED_BOUND_BASIS as UNKNOWN_STOP,
  FACTORY_USAGE_RESERVED_BOUND_RESTORE_BASIS as UNKNOWN_RESTORE,
} from "../../factory/usage-settlement";

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

/** Every basis each stop-proven source may record; the combined check admits exactly these. */
const ALL_BASES = [RESERVED_BOUND, NOTHING_LAUNCHED, PROVIDER_ERROR, OPERATIONS, UNKNOWN_STOP, UNKNOWN_RESTORE];

/** W03e's one-basis check, the form both W03f's and W09h's migrations start from on an old installation. */
const W03E_FORM = `CHECK ((source = 'no-operations') = (basis IS NOT NULL) AND (basis IS NULL OR basis = '${RESERVED_BOUND}'))`;
/** W03f's check before it took W09h's basis: the form no landed installation ever carried. */
const W03F_ONLY_FORM = `CHECK ((source IN ('no-operations','operations','reserved-bound')) = (basis IS NOT NULL) AND (basis IS NULL
  OR (source = 'no-operations' AND basis = '${RESERVED_BOUND}')
  OR (source = 'operations' AND basis IN ('${PROVIDER_ERROR}', '${OPERATIONS}'))
  OR (source = 'reserved-bound' AND stop_receipt_digest IS NOT NULL AND basis = '${UNKNOWN_STOP}')
  OR (source = 'reserved-bound' AND restore_digest IS NOT NULL AND basis = '${UNKNOWN_RESTORE}')))`;

type Migration = (database: MigrationDb) => Promise<void>;

/**
 * W03f and W09h each replace factory_usage_settlements_basis_check. W03f's migration installs ONE combined check
 * (its own bases plus W09h's "nothing launched, all zero") and replaces the check while either marker is
 * missing; W09h's landed migration then finds its marker and changes nothing. Shared by the PGlite and the
 * real-PostgreSQL case, so both engines are held to one statement of the shape (lead ruling 2026-09-28).
 */
export function factoryUsageBasisMigrationConformance(engine: string, open: () => Promise<FactoryUsageBasisMigrationFixture>): void {
  const withDatabase = (name: string, body: (db: MigrationDb) => Promise<void>) => test(`${engine}: ${name}`, async () => {
    const fixture = await open();
    try { await body(fixture.db); } finally { await fixture.close(); }
  });
  const check = async (db: MigrationDb) => rows<{ oid: string; definition: string }>(await db.execute(sql`SELECT oid::text AS oid, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${BASIS_CHECK}`));
  const install = async (db: MigrationDb, form: string) => {
    await db.execute(sql.raw(`ALTER TABLE factory_usage_settlements DROP CONSTRAINT ${BASIS_CHECK}`));
    await db.execute(sql.raw(`ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${BASIS_CHECK} ${form}`));
  };
  const expectCombined = (definition: string | undefined) => { for (const basis of ALL_BASES) expect(definition).toContain(`'${basis}'`); };

  withDatabase("a fresh boot installs the one combined basis check, and it admits every basis of its source and nothing else", async db => {
    const [current] = await check(db);
    expectCombined(current?.definition);
    await db.execute(sql`ALTER TABLE factory_usage_settlements DROP CONSTRAINT factory_usage_settlements_reservation_fk`);
    const insert = (reservation: string, source: string, basis: string | null, proof: { stop?: string; restore?: string }) => db.execute(sql`INSERT INTO factory_usage_settlements (tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,stop_receipt_digest,restore_digest,basis,settled_at_ms,settlement_digest,event_json,event_digest)
      VALUES ('t','p','r',${reservation},1,'attempt-1',${source},'0',${proof.stop ?? null},${proof.restore ?? null},${basis},1,${digest("c")},'{}',${digest("c")})`);
    const stop = { stop: digest("a") };
    const accepted: Array<[string, string, { stop?: string; restore?: string }]> = [
      ["no-operations", RESERVED_BOUND, stop], ["no-operations", NOTHING_LAUNCHED, stop],
      ["operations", PROVIDER_ERROR, stop], ["operations", OPERATIONS, stop],
      ["reserved-bound", UNKNOWN_STOP, stop], ["reserved-bound", UNKNOWN_RESTORE, { restore: digest("b") }],
    ];
    for (const [index, [source, basis, proof]] of accepted.entries()) await insert(`accepted-${index}`, source, basis, proof);
    const refused: Array<[string, string | null, { stop?: string; restore?: string }]> = [
      // Each source keeps its own bases: nothing launched is a no-operations basis only.
      ["operations", NOTHING_LAUNCHED, stop], ["reserved-bound", NOTHING_LAUNCHED, stop], ["no-operations", OPERATIONS, stop],
      ["no-operations", "no-operations: compute refunded", stop], ["no-operations", null, stop], ["stop", NOTHING_LAUNCHED, {}],
    ];
    for (const [index, [source, basis, proof]] of refused.entries()) expect({ index, error: await failure(insert(`refused-${index}`, source, basis, proof)) }).toEqual({ index, error: expect.stringContaining(BASIS_CHECK) });
    expect(Number(rows<{ count: number | string }>(await db.execute(sql`SELECT count(*) AS count FROM factory_usage_settlements WHERE tenant_id='t'`))[0]!.count)).toBe(accepted.length);
  });

  withDatabase("a W09h-shaped database (W09h's check installed, W03f's not yet) migrates to the combined check", async db => {
    const [current] = await check(db);
    await install(db, W03E_FORM);
    await upNothingLaunched(db);
    const [w09h] = await check(db);
    expect(w09h?.definition).toContain(`'${NOTHING_LAUNCHED}'`);
    expect(w09h?.definition).not.toContain(OPERATIONS);
    await upOperations(db);
    expect((await check(db))[0]?.definition).toBe(current?.definition);
  });

  withDatabase("both registration orders reach the same combined check from a W03e-shaped database", async db => {
    const [current] = await check(db);
    const orders: Array<[string, Migration[]]> = [["W03f then W09h", [upOperations, upNothingLaunched]], ["W09h then W03f", [upNothingLaunched, upOperations]]];
    for (const [order, migrations] of orders) {
      await install(db, W03E_FORM);
      for (const migration of migrations) await migration(db);
      expect({ order, definition: (await check(db))[0]?.definition }).toEqual({ order, definition: current?.definition });
    }
  });

  withDatabase("a repeated boot keeps the same constraint row: no migration re-creates the combined check", async db => {
    const [current] = await check(db);
    expectCombined(current?.definition);
    for (const migration of [upNoOperations, upOperations, upNothingLaunched, upNothingLaunched, upOperations]) await migration(db);
    expect(await check(db)).toEqual([current]);
  });

  withDatabase("a W03f-only check (never on a landed installation) converges to the combined check", async db => {
    const [current] = await check(db);
    await install(db, W03F_ONLY_FORM);
    // migrate() order: W03f's migration is registered before W09h's.
    await upOperations(db);
    await upNothingLaunched(db);
    expect((await check(db))[0]?.definition).toBe(current?.definition);
  });
}
