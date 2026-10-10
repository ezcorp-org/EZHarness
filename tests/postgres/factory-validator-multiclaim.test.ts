import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { up as allowFactoryValidatorMulticlaim } from "../../src/db/migrations/allow-factory-validator-multiclaim";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import type { MigrationDb } from "../../src/db/migrations/types";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

/**
 * The pre-migration shape, quoted from `add-factory-validator-materials` as it stood before the
 * claim-keyed identity landed. Only the two tables this migration reshapes are created, and only
 * the results-to-assignments foreign key is kept, because that key is what the migration moves.
 */
const LEGACY_ASSIGNMENTS = `CREATE TABLE factory_validator_assignments (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  candidate_node_instance_id TEXT NOT NULL, candidate_generation BIGINT NOT NULL CHECK (candidate_generation >= 0), validator_id TEXT NOT NULL,
  validator_attempt_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, run_id, candidate_node_instance_id, candidate_generation, validator_id),
  UNIQUE (validator_attempt_id)
)`;
const LEGACY_RESULTS = `CREATE TABLE factory_validator_results (
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, validator_attempt_id TEXT NOT NULL, claims_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project_id, validator_attempt_id),
  FOREIGN KEY (validator_attempt_id) REFERENCES factory_validator_assignments(validator_attempt_id) ON DELETE RESTRICT
)`;

const CLAIM_KEYED_PRIMARY_KEY = "PRIMARY KEY (tenant_id, project_id, validator_attempt_id, validator_id)";
const CLAIM_KEYED_FOREIGN_KEY = "FOREIGN KEY (tenant_id, project_id, validator_attempt_id, validator_id) REFERENCES factory_validator_assignments(tenant_id, project_id, validator_attempt_id, validator_id) ON DELETE RESTRICT";
const RESULT_CONSTRAINTS = sql`SELECT conname, oid FROM pg_constraint WHERE conrelid='public.factory_validator_results'::regclass ORDER BY conname`;

describe("Factory validator multi-claim upgrade on real PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;

  beforeAll(async () => { fixture = await setupFactoryPostgres(); });
  afterAll(async () => { await fixture?.close(); });

  /** One connection, so `SET LOCAL search_path` and every statement below it agree. */
  function inSchema<Result>(schemaName: string, use: (transaction: MigrationDb) => Promise<Result>): Promise<Result> {
    return fixture.db.transaction(async transaction => {
      await transaction.execute(sql`SET LOCAL search_path TO ${sql.raw(schemaName)}, public`);
      return use(transaction);
    });
  }

  /** Only the constraints this migration owns, with any schema qualifier removed. */
  async function reshapedConstraints(database: MigrationDb, schemaName: string): Promise<string[]> {
    return rows<{ definition: string }>(await database.execute(sql`SELECT pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = ${schemaName} AND rel.relname IN ('factory_validator_assignments','factory_validator_results') AND con.contype IN ('p','f','u')
      ORDER BY 1`))
      .map(row => row.definition.replaceAll(`${schemaName}.`, ""))
      .filter(definition => definition === CLAIM_KEYED_PRIMARY_KEY || definition.includes("factory_validator_assignments") || definition.startsWith("UNIQUE"));
  }

  async function claimIndexes(database: MigrationDb, schemaName: string): Promise<string[]> {
    return rows<{ indexdef: string }>(await database.execute(sql`SELECT indexdef FROM pg_indexes
      WHERE schemaname = ${schemaName} AND indexname = 'uq_factory_validator_assignment_attempt_claim'`))
      .map(row => row.indexdef.replaceAll(`${schemaName}.`, ""));
  }

  test("a populated one-claim database upgrades in place, reruns as a no-op, and then keys results by claim", async () => {
    await fixture.db.execute(sql`CREATE SCHEMA factory_legacy_claims`);
    await inSchema("factory_legacy_claims", async transaction => {
      await transaction.execute(sql.raw(LEGACY_ASSIGNMENTS));
      await transaction.execute(sql.raw(LEGACY_RESULTS));
      for (const [attempt, claimId] of [["attempt-one", "frozen-install"], ["attempt-two", "build"]] as const) {
        await transaction.execute(sql`INSERT INTO factory_validator_assignments VALUES ('tenant','project','run','candidate-node',0,${claimId},${attempt})`);
        await transaction.execute(sql`INSERT INTO factory_validator_results VALUES ('tenant','project',${attempt},${`[{"id":"${claimId}","passed":true,"decisive":true}]`})`);
      }
    });

    const afterFirst = await inSchema("factory_legacy_claims", async transaction => {
      await allowFactoryValidatorMulticlaim(transaction);
      return { constraints: await reshapedConstraints(transaction, "factory_legacy_claims"), indexes: await claimIndexes(transaction, "factory_legacy_claims") };
    });
    expect(afterFirst.constraints).toEqual([CLAIM_KEYED_FOREIGN_KEY, CLAIM_KEYED_PRIMARY_KEY]);
    expect(afterFirst.indexes).toHaveLength(1);

    const afterSecond = await inSchema("factory_legacy_claims", async transaction => {
      await allowFactoryValidatorMulticlaim(transaction);
      return { constraints: await reshapedConstraints(transaction, "factory_legacy_claims"), indexes: await claimIndexes(transaction, "factory_legacy_claims") };
    });
    expect(afterSecond).toEqual(afterFirst);

    expect(await inSchema("factory_legacy_claims", async transaction =>
      rows(await transaction.execute(sql`SELECT validator_attempt_id, validator_id FROM factory_validator_results ORDER BY validator_attempt_id`)))).toEqual([
      { validator_attempt_id: "attempt-one", validator_id: "frozen-install" },
      { validator_attempt_id: "attempt-two", validator_id: "build" },
    ]);

    await inSchema("factory_legacy_claims", async transaction => {
      await transaction.execute(sql`INSERT INTO factory_validator_assignments VALUES ('tenant','project','run','candidate-node',0,'typecheck','attempt-one')`);
      await transaction.execute(sql`INSERT INTO factory_validator_results VALUES ('tenant','project','attempt-one','[]','typecheck')`);
    });
    expect(await inSchema("factory_legacy_claims", async transaction =>
      rows(await transaction.execute(sql`SELECT validator_id FROM factory_validator_results WHERE validator_attempt_id='attempt-one' ORDER BY validator_id`))))
      .toEqual([{ validator_id: "frozen-install" }, { validator_id: "typecheck" }]);

    for (const bad of ["'tenant','project','attempt-one','[]','typecheck'", "'tenant','project','attempt-one','[]','never-assigned'"]) {
      await expect(inSchema("factory_legacy_claims", transaction => transaction.execute(sql.raw(`INSERT INTO factory_validator_results VALUES (${bad})`)))).rejects.toThrow();
    }
    await fixture.db.execute(sql`DROP SCHEMA factory_legacy_claims CASCADE`);
  });

  test("the fresh catalog and the upgraded catalog agree on the claim-keyed identity", async () => {
    const fresh = await reshapedConstraints(fixture.db, "public");
    const freshIndexes = await claimIndexes(fixture.db, "public");
    expect(fresh).toEqual([CLAIM_KEYED_FOREIGN_KEY, CLAIM_KEYED_PRIMARY_KEY]);
    expect(freshIndexes).toHaveLength(1);

    await fixture.db.execute(sql`CREATE SCHEMA factory_parity_claims`);
    const upgraded = await inSchema("factory_parity_claims", async transaction => {
      await transaction.execute(sql.raw(LEGACY_ASSIGNMENTS));
      await transaction.execute(sql.raw(LEGACY_RESULTS));
      await allowFactoryValidatorMulticlaim(transaction);
      return { constraints: await reshapedConstraints(transaction, "factory_parity_claims"), indexes: await claimIndexes(transaction, "factory_parity_claims") };
    });
    expect(upgraded.constraints).toEqual(fresh);
    expect(upgraded.indexes).toEqual(freshIndexes);
    await fixture.db.execute(sql`DROP SCHEMA factory_parity_claims CASCADE`);
  });

  test("a repeated full migration over the fresh catalog rebuilds no validator key", async () => {
    const before = await reshapedConstraints(fixture.db, "public");
    const beforeConstraints = rows(await fixture.db.execute(RESULT_CONSTRAINTS));
    await fixture.migrate();
    expect(await reshapedConstraints(fixture.db, "public")).toEqual(before);
    expect(rows(await fixture.db.execute(RESULT_CONSTRAINTS))).toEqual(beforeConstraints);
  });
});
