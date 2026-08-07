import type { sql } from "drizzle-orm";
import type { settings } from "../schema";

/**
 * The only thing an individual migration step ever needs from the database
 * handle.
 *
 * `migrate()` and every step under `src/db/migrations/` took `db: any`, which
 * was never about the shape being unknowable — all 18 of them call exactly one
 * method, `db.execute(sql\`...\`)`. Four files had already written the real
 * shape out by hand (three as an inline object literal, one as a local
 * `OneShotExecutor` interface); this is that same shape, declared once.
 *
 * Deliberately structural rather than drizzle's own handle type: the migration
 * steps are unit-tested against a fake executor that records the SQL it was
 * handed, and pinning them to the concrete driver type would force those tests
 * to construct a whole database instead of a one-method object.
 */
export interface MigrationDb {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}

/**
 * What `migrate()` itself must be handed — strictly richer than a step's
 * handle, because it forwards the handle to `seedSelfProject()`, whose one
 * settings insert goes through drizzle's column mapper rather than raw SQL
 * (a raw `${...}::jsonb` param double-encodes under Bun.sql; see the comment
 * at that call site).
 *
 * Still structural. The real handle is a PGlite database on the embedded path
 * and a Bun.sql one on external Postgres, and those two differ in drizzle's
 * query-result HKT parameter — that mismatch is what the old `db: any` was
 * standing in for. Pinning `values` to the table's own `$inferInsert` keeps
 * the seeded row type-checked, which is the part worth having.
 */
export type MigrateDb = MigrationDb & {
  insert: (table: typeof settings) => {
    values: (row: typeof settings.$inferInsert) => {
      onConflictDoNothing: () => PromiseLike<unknown>;
    };
  };
};
