import { describe, expect, test } from "bun:test";
import { factoryDatabaseCrossLogin, type FactoryDatabasePair } from "./database";

const product: FactoryDatabasePair = { kind: "product", role: "product_role", database: "product_db", credentialFile: "product-database.json" };
const pool: FactoryDatabasePair = { kind: "pool", role: "pool_role", database: "pool_db", credentialFile: "pool-database-credential.json" };

/** The real step's login check needs PostgreSQL (tests/postgres/factory-provisioning.test.ts); the decision around it does not. */
describe("factoryDatabaseCrossLogin", () => {
  test("with one pair there is no other database, so nothing is tried and nothing leaks", async () => {
    for (const pairs of [[product], [pool], []]) {
      const tried: string[] = [];
      expect(await factoryDatabaseCrossLogin(pairs, async (pair, other) => { tried.push(`${pair.kind}->${other.kind}`); return true; })).toBe(false);
      expect(tried).toEqual([]);
    }
  });

  test("with both pairs, each credential is tried against the other database, and either login is a leak", async () => {
    const tried: string[] = [];
    const record = (answer: (pair: FactoryDatabasePair) => boolean) => async (pair: FactoryDatabasePair, other: FactoryDatabasePair) => { tried.push(`${pair.role}->${other.database}`); return answer(pair); };
    expect(await factoryDatabaseCrossLogin([product, pool], record(() => false))).toBe(false);
    expect(tried).toEqual(["product_role->pool_db", "pool_role->product_db"]);
    expect(await factoryDatabaseCrossLogin([product, pool], record((pair) => pair.kind === "pool"))).toBe(true);
    tried.length = 0;
    expect(await factoryDatabaseCrossLogin([product, pool], record((pair) => pair.kind === "product"))).toBe(true);
    expect(tried).toEqual(["product_role->pool_db"]);
  });
});
