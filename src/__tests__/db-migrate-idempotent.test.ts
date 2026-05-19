import { test, expect, describe } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

/**
 * Guard against non-idempotent DDL creeping into `src/db/migrate.ts`.
 *
 * The boot sequence calls `migrate()` on EVERY boot, and production images
 * can run against already-migrated volumes (every restart, Watchtower pull,
 * or user-initiated redeploy). If someone adds `ALTER TABLE ... ADD COLUMN`
 * (without `IF NOT EXISTS`) or similar non-idempotent statements, the second
 * boot will crash and engage the circuit breaker unnecessarily.
 *
 * This suite reproduces the repeated-boot case and asserts the schema after
 * two migrate() calls is byte-identical to one — catching the regression
 * before it ships.
 */

async function schemaFingerprint(db: any): Promise<string> {
  const tables = (await db.execute(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `)).rows as Array<{ table_name: string }>;

  const parts: string[] = [];
  for (const { table_name } of tables) {
    const cols = (await db.execute(sql.raw(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table_name}'
      ORDER BY ordinal_position
    `))).rows as Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>;
    parts.push(`${table_name}:${JSON.stringify(cols)}`);

    const idx = (await db.execute(sql.raw(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = '${table_name}'
      ORDER BY indexname
    `))).rows as Array<{ indexname: string; indexdef: string }>;
    parts.push(`${table_name}.idx:${JSON.stringify(idx)}`);
  }

  return parts.join("\n");
}

describe("migrate() is idempotent", () => {
  test("two consecutive runs against the same DB: no error, identical schema", async () => {
    const pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    const db = drizzle(pglite, { schema });

    try {
      await migrate(db);
      const after1 = await schemaFingerprint(db);

      // The real test: does the second call throw? This catches
      // ALTER TABLE ADD COLUMN without IF NOT EXISTS, CREATE INDEX without
      // IF NOT EXISTS, ADD CONSTRAINT with a name that already exists, etc.
      await migrate(db);
      const after2 = await schemaFingerprint(db);

      expect(after2).toBe(after1);
    } finally {
      await pglite.close();
    }
  });

  test("migrate() preserves data across repeated invocations", async () => {
    // Beyond schema equality, we need to be sure existing rows survive a
    // re-run. Sometimes a migration that LOOKS idempotent (CREATE TABLE IF
    // NOT EXISTS) is fine, but a misguided companion statement like
    // DELETE FROM foo WHERE ... would silently erase user data.
    const pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    const db = drizzle(pglite, { schema });

    try {
      await migrate(db);

      await db.execute(sql`
        INSERT INTO settings (key, value)
        VALUES ('idempotency-probe', '"hello"'::jsonb)
      `);
      const beforeRows = (await db.execute(sql`SELECT value FROM settings WHERE key = 'idempotency-probe'`)).rows;
      expect(beforeRows).toHaveLength(1);

      await migrate(db);

      const afterRows = (await db.execute(sql`SELECT value FROM settings WHERE key = 'idempotency-probe'`)).rows;
      expect(afterRows).toHaveLength(1);
      expect(afterRows[0]).toEqual(beforeRows[0]);
    } finally {
      await pglite.close();
    }
  });

  test("migrate() is safe across a hypothetical 5-boot cycle", async () => {
    // Simulates Watchtower or manual restart behavior: migrate runs on every
    // boot. 5 runs shouldn't produce any drift vs 1 run.
    const pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    const db = drizzle(pglite, { schema });

    try {
      await migrate(db);
      const baseline = await schemaFingerprint(db);

      for (let i = 0; i < 5; i++) {
        await migrate(db);
      }

      const final = await schemaFingerprint(db);
      expect(final).toBe(baseline);
    } finally {
      await pglite.close();
    }
  });
});
