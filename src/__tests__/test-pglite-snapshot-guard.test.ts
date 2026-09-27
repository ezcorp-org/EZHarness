import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { missingSchemaTables } from "./helpers/test-pglite";

// W09f: the cross-process migrated snapshot is published only when every
// schema table exists, so a same-process `db/migrate` mock cannot poison it.
test("an unmigrated database is incomplete and a migrated one is not", async () => {
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  try {
    await database.waitReady;
    const before = await missingSchemaTables(database);
    expect(before).toContain("factory_runs");
    expect(before).toContain("agent_configs");
    await migrate(drizzle(database, { schema }));
    expect(await missingSchemaTables(database)).toEqual([]);
  } finally {
    await database.close();
  }
}, 120_000);
