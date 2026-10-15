import { factoryPoolConformance, type FactoryPoolConformanceFixture } from "../../src/__tests__/helpers/factory-pool-suite";
import { setupFactoryPoolLedger, type PoolSql } from "../../src/factory/pool";
import { setupFactoryPoolPostgres } from "./helpers/factory-pool-database";

let close: (() => Promise<void>) | undefined;
const fixture: FactoryPoolConformanceFixture = {
  name: "real PostgreSQL",
  async create(): Promise<PoolSql> {
    const database = await setupFactoryPoolPostgres();
    const client = database.client;
    close = database.close;
    await setupFactoryPoolLedger(client);
    return client;
  },
  async destroy(): Promise<void> {
    await close?.();
  },
};
factoryPoolConformance(fixture);
