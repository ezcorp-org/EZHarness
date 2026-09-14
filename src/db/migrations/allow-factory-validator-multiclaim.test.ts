import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { up } from "./allow-factory-validator-multiclaim";

type Database = ReturnType<typeof drizzle>;

/** The pre-migration shape: one result per attempt, and one globally unique attempt. */
async function legacy(database: Database): Promise<void> {
  await database.execute(sql`CREATE TABLE factory_validator_assignments (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, validator_attempt_id TEXT NOT NULL UNIQUE, validator_id TEXT NOT NULL,
    PRIMARY KEY (tenant_id, project_id, validator_id)
  )`);
  await database.execute(sql`CREATE TABLE factory_validator_results (
    tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, validator_attempt_id TEXT NOT NULL,
    PRIMARY KEY (tenant_id,project_id,validator_attempt_id),
    FOREIGN KEY (validator_attempt_id) REFERENCES factory_validator_assignments(validator_attempt_id)
  )`);
}

async function catalog(database: Database): Promise<unknown[]> {
  return (await database.execute(sql`SELECT relname, conname, contype, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE relname IN ('factory_validator_assignments','factory_validator_results')
    ORDER BY relname, conname`)).rows;
}

async function indexes(database: Database): Promise<unknown[]> {
  return (await database.execute(sql`SELECT indexname, indexdef FROM pg_indexes
    WHERE tablename IN ('factory_validator_assignments','factory_validator_results') ORDER BY indexname`)).rows;
}

async function withDatabase<Result>(use: (database: Database) => Promise<Result>): Promise<Result> {
  const client = new PGlite();
  try {
    await client.waitReady;
    return await use(drizzle(client));
  } finally {
    await client.close();
  }
}

test("upgrades one-claim validator rows without losing history, and reruns as a no-op", async () => {
  await withDatabase(async database => {
    await legacy(database);
    await database.execute(sql`INSERT INTO factory_validator_assignments VALUES ('tenant','project','attempt','claim-a')`);
    await database.execute(sql`INSERT INTO factory_validator_results VALUES ('tenant','project','attempt')`);

    await up(database);
    const afterFirst = await catalog(database);
    const indexesAfterFirst = await indexes(database);
    await up(database);

    expect(await catalog(database)).toEqual(afterFirst);
    expect(await indexes(database)).toEqual(indexesAfterFirst);
    expect(indexesAfterFirst.some(row => (row as { indexname: string }).indexname === "uq_factory_validator_assignment_attempt_claim")).toBe(true);
    expect(afterFirst.some(row => (row as { definition: string }).definition === "UNIQUE (validator_attempt_id)")).toBe(false);
    expect(afterFirst.filter(row => (row as { relname: string; contype: string }).relname === "factory_validator_results" && (row as { contype: string }).contype === "p").map(row => (row as { definition: string }).definition))
      .toEqual(["PRIMARY KEY (tenant_id, project_id, validator_attempt_id, validator_id)"]);

    await database.execute(sql`INSERT INTO factory_validator_assignments VALUES ('tenant','project','attempt','claim-b')`);
    await database.execute(sql`INSERT INTO factory_validator_results VALUES ('tenant','project','attempt','claim-b')`);
    expect((await database.execute(sql`SELECT validator_attempt_id,validator_id FROM factory_validator_results ORDER BY validator_id`)).rows).toEqual([
      { validator_attempt_id: "attempt", validator_id: "claim-a" },
      { validator_attempt_id: "attempt", validator_id: "claim-b" },
    ]);
    const duplicate = await database.execute(sql`INSERT INTO factory_validator_results VALUES ('tenant','project','attempt','claim-b')`).then(() => null, (error: unknown) => error);
    expect(duplicate).toBeInstanceOf(Error);
    const foreign = await database.execute(sql`INSERT INTO factory_validator_results VALUES ('tenant','project','attempt','claim-never-assigned')`).then(() => null, (error: unknown) => error);
    expect(foreign).toBeInstanceOf(Error);
  });
});

test("a result whose claim identity cannot be resolved aborts the migration rather than defaulting", async () => {
  await withDatabase(async database => {
    await legacy(database);
    await database.execute(sql`INSERT INTO factory_validator_assignments VALUES ('tenant','project','attempt','claim-a')`);
    await database.execute(sql`INSERT INTO factory_validator_results VALUES ('other-tenant','project','attempt')`);

    await expect(up(database)).rejects.toThrow("factory validator result requires an unambiguous claim identity");

    expect((await database.execute(sql`SELECT tenant_id,validator_id FROM factory_validator_results ORDER BY tenant_id`)).rows)
      .toEqual([{ tenant_id: "other-tenant", validator_id: null }]);
    expect((await catalog(database)).some(row => (row as { definition: string }).definition === "PRIMARY KEY (tenant_id, project_id, validator_attempt_id, validator_id)")).toBe(false);
  });
});

test("a database already carrying the claim-keyed identity is left exactly as it is", async () => {
  await withDatabase(async database => {
    await database.execute(sql`CREATE TABLE factory_validator_assignments (
      tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, validator_attempt_id TEXT NOT NULL, validator_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, project_id, validator_id)
    )`);
    await database.execute(sql`CREATE UNIQUE INDEX uq_factory_validator_assignment_attempt_claim ON factory_validator_assignments(tenant_id,project_id,validator_attempt_id,validator_id)`);
    await database.execute(sql`CREATE TABLE factory_validator_results (
      tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, validator_attempt_id TEXT NOT NULL, validator_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, project_id, validator_attempt_id, validator_id),
      CONSTRAINT factory_validator_results_assignment_fkey FOREIGN KEY (tenant_id, project_id, validator_attempt_id, validator_id) REFERENCES factory_validator_assignments(tenant_id, project_id, validator_attempt_id, validator_id) ON DELETE RESTRICT
    )`);
    const before = await catalog(database);
    const beforeOids = (await database.execute(sql`SELECT conname, oid FROM pg_constraint WHERE conrelid='factory_validator_results'::regclass ORDER BY conname`)).rows;

    await up(database);

    expect(await catalog(database)).toEqual(before);
    expect((await database.execute(sql`SELECT conname, oid FROM pg_constraint WHERE conrelid='factory_validator_results'::regclass ORDER BY conname`)).rows).toEqual(beforeOids);
  });
});
