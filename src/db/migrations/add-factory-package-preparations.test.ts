import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../schema";
import { up } from "./add-factory-package-preparations";

test("creates scoped runner bindings and versioned preparation receipts", async () => {
  const client = new PGlite({ extensions: { vector, pg_trgm } });
  try {
    await client.waitReady;
    const database = drizzle(client, { schema });
    await database.execute(sql`CREATE TABLE users (id TEXT PRIMARY KEY)`);
    await database.execute(sql`CREATE TABLE factory_projects (tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY (tenant_id, project_id))`);
    await database.execute(sql`CREATE TABLE extension_release_installations (id TEXT PRIMARY KEY)`);
    await up(database);
    const tables = await database.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('factory_runner_package_bindings', 'factory_runner_package_trust_current', 'factory_runner_package_trust_revisions', 'factory_runner_preparation_intents', 'factory_runner_preparation_receipts') ORDER BY tablename`);
    expect(tables.rows).toEqual([{ tablename: "factory_runner_package_bindings" }, { tablename: "factory_runner_package_trust_current" }, { tablename: "factory_runner_package_trust_revisions" }, { tablename: "factory_runner_preparation_intents" }, { tablename: "factory_runner_preparation_receipts" }]);
  } finally { await client.close(); }
});
