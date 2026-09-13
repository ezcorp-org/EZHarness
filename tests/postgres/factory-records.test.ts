import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sql";
import { factoryRecordsConformance } from "../../src/__tests__/helpers/factory-records-suite";
import { migrate } from "../../src/db/migrate";
import * as schema from "../../src/db/schema";
import { __test } from "../../src/db/connection";

factoryRecordsConformance(async () => {
  const url = process.env.FACTORY_TEST_POSTGRES_URL;
  if (!url) throw new Error("FACTORY_TEST_POSTGRES_URL is required for real PostgreSQL conformance.");
  const admin = new SQL(url, { max: 1 });
  const databaseName = `factory_proof_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  const isolatedUrl = new URL(url);
  isolatedUrl.pathname = `/${databaseName}`;
  const client = new SQL(isolatedUrl.toString(), { max: 4 });
  const db = drizzle(client, { schema });
  const close = async () => {
    await client.close();
    try { await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`); }
    finally { await admin.close(); }
  };
  try {
    await __test.applyBunSqlJsonbFix();
    __test.setState(db, null);
    await __test.withPostgresMigrateLock((migrationDb) => migrate(migrationDb));
  }
  catch (error) { await close(); throw error; }
  return { db, close };
});
