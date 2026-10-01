import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { assertBunSqlPipeliningOff } from "../../../src/db/bun-sql-pipelining";

/** Isolated PostgreSQL database for the independent pool ledger. */
export async function setupFactoryPoolPostgres(): Promise<{ readonly client: SQL; readonly databaseUrl: string; close(): Promise<void> }> {
  assertBunSqlPipeliningOff(); // W12e: fail by name on an affected Bun without the flag at process start.
  const url = process.env.FACTORY_TEST_POSTGRES_URL;
  if (!url) throw new Error("FACTORY_TEST_POSTGRES_URL is required for real PostgreSQL pool conformance.");
  const admin = new SQL(url, { max: 1 });
  const database = `factory_pool_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  const isolated = new URL(url);
  isolated.pathname = `/${database}`;
  const databaseUrl = isolated.toString();
  const client = new SQL(databaseUrl, { max: 8 });
  return {
    client,
    databaseUrl,
    async close() {
      await client.close();
      try { await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`); }
      finally { await admin.close(); }
    },
  };
}
