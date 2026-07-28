import { test, expect, describe, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";

/**
 * The fail-safe half of the extension-state-root normalization.
 *
 * migrate() needs the project root to scope the rewrite, and reaches
 * `getProjectRoot()` by dynamic import (a static one would close the cycle
 * migrate.ts → bundled.ts → db/queries/extensions.ts → db/connection.ts →
 * migrate.ts). If that resolution ever throws, the choice is:
 *
 *   - fail the boot — but a migrate() throw trips the rollback-and-exit
 *     circuit breaker in db/connection.ts, taking the whole deployment
 *     down over a cosmetic path repair;
 *   - rewrite under a guessed root — unrecoverable, the original value
 *     is gone;
 *   - skip, and leave the rows exactly as they are.
 *
 * It skips. This suite pins that: migrate() completes, the rest of the
 * schema is built, and the legacy rows survive untouched so the next boot
 * (or an operator) can still repair them.
 *
 * The whole module is mocked rather than just the function because
 * migrate() imports nothing else from it. scripts/test.sh runs one bun
 * process PER FILE, so this `mock.module` cannot leak into another suite —
 * which is why it lives in its own file instead of alongside the
 * happy-path boot-wiring tests.
 */

const RESOLVE_ERROR = "simulated getProjectRoot() failure";

mock.module("../extensions/bundled", () => ({
  getProjectRoot: () => {
    throw new Error(RESOLVE_ERROR);
  },
}));

// Imported AFTER the mock is registered so migrate()'s dynamic import
// resolves to it.
const { migrate } = await import("../db/migrate");

const stale = "/app/web/.ezcorp/extensions/weather";

describe("migrate() when the project root cannot be resolved", () => {
  test("skips the rewrite instead of failing the boot, leaving rows intact", async () => {
    const pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    const db = drizzle(pglite, { schema });
    try {
      // Boot 1 builds the schema; the mock is already in force, so this
      // call itself exercises the catch path.
      await migrate(db);

      await db.execute(sql`
        INSERT INTO extensions (id, name, version, manifest, source, install_path, enabled)
        VALUES ('weather', 'weather', '1.0.0', '{"tools":[]}',
                ${`local:${stale}`}, ${stale}, TRUE)
      `);

      // Boot 2 — resolves and returns normally despite the failure.
      await migrate(db);

      const res = await db.execute(
        sql`SELECT source, install_path FROM extensions WHERE name = 'weather'`,
      );
      const row = (res.rows as Array<{ source: string; install_path: string }>)[0];
      // Untouched: recoverable, rather than rewritten under a guessed root.
      expect(row.install_path).toBe(stale);
      expect(row.source).toBe(`local:${stale}`);

      // The rest of migrate() still ran — the skip is scoped to the one
      // repair, not an early return.
      const tables = await db.execute(sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('invites', 'extensions')
        ORDER BY table_name
      `);
      expect((tables.rows as Array<{ table_name: string }>).map((t) => t.table_name))
        .toEqual(["extensions", "invites"]);
    } finally {
      await pglite.close();
    }
  });
});
