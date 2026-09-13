import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { factoryPoolConformance, type FactoryPoolConformanceFixture } from "../../src/__tests__/helpers/factory-pool-suite";
import { setupFactoryPoolLedger, type PoolSql } from "../../src/factory/pool";

const url = process.env.FACTORY_TEST_POSTGRES_URL;
if (!url) throw new Error("FACTORY_TEST_POSTGRES_URL is required for real PostgreSQL pool-ledger conformance.");
let admin: SQL | undefined;
let client: SQL | undefined;
let databaseName: string | undefined;
const fixture: FactoryPoolConformanceFixture = {
  name: "real PostgreSQL",
  async create(): Promise<PoolSql> {
    admin = new SQL(url, { max: 1 });
    databaseName = `factory_pool_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const isolated = new URL(url);
    isolated.pathname = `/${databaseName}`;
    client = new SQL(isolated.toString(), { max: 12 });
    await setupFactoryPoolLedger(client);
    return client;
  },
  async destroy(): Promise<void> {
    await client?.close();
    if (databaseName) await admin?.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.close();
  },
};
factoryPoolConformance(fixture);
