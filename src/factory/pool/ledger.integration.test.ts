import { PGlite } from "@electric-sql/pglite";
import { factoryPoolConformance, type FactoryPoolConformanceFixture } from "../../__tests__/helpers/factory-pool-suite";
import { setupFactoryPoolLedger, type PoolSql } from ".";

let database: PGlite | undefined;
const fixture: FactoryPoolConformanceFixture = {
  name: "PGlite",
  async create(): Promise<PoolSql> {
    database = new PGlite();
    await database.waitReady;
    const transactionSql = (transaction: { query(query: string, params?: unknown[]): Promise<unknown> }): PoolSql => ({
      unsafe: (query, params) => transaction.query(query, params as unknown[] | undefined),
      begin: async () => { throw new Error("Nested pool transactions are unsupported."); },
    });
    const sql: PoolSql = {
      unsafe: (query, params) => database!.query(query, params as unknown[] | undefined),
      begin: async <Result>(work: (transaction: PoolSql) => Promise<Result>) => database!.transaction(async transaction => work(transactionSql(transaction))),
    };
    await setupFactoryPoolLedger(sql);
    return sql;
  },
  async destroy(): Promise<void> { await database?.close(); },
};
factoryPoolConformance(fixture);
