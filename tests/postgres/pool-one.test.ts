import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { migrate } from "../../src/db/migrate";

if (!process.env.DATABASE_URL) {
  throw new Error("pool-one Postgres lifecycle requires DATABASE_URL");
}

if (process.env.DB_POOL_MAX !== "1") {
  throw new Error("pool-one Postgres lifecycle requires DB_POOL_MAX=1");
}

/**
 * This file is intentionally outside src/__tests__: scripts/test.sh sweeps
 * that directory without an external Postgres service. db-postgres.yml calls
 * this exact file with a real pgvector Postgres service and DB_POOL_MAX=1.
 */
describe("external Postgres one-connection migration lifecycle", () => {
  let conn: typeof import("../../src/db/connection");

  beforeAll(async () => {
    conn = await import("../../src/db/connection");
    // This is the first migration. Keep the established external-init budget:
    // it builds a real schema from an empty service and is not a test timeout.
    await conn.initDb();
  }, 60_000);

  afterAll(async () => {
    if (conn) await conn.closeDb();
  });

  test("a one-connection Bun.sql pool can initialize and migrate twice", async () => {
    // The first migration is in beforeAll. reserve() removes the lock session
    // from Bun.sql's general pool, so this second migration must use the
    // callback's reserved handle. Calling migrate(conn.getDb()) here is the
    // pre-fix behavior and blocks forever with DB_POOL_MAX=1.
    expect(conn.getPglite()).toBeNull();
    expect(conn.getDbPath()).toBe("external");
    await conn.__test.withPostgresMigrateLock((migrationDb) => migrate(migrationDb));
    const { rows } = await conn.rawQuery(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect((rows[0] as { n: number }).n).toBeGreaterThan(20);
  });
});
