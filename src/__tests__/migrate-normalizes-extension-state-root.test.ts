import { test, expect, describe } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { getProjectRoot } from "../extensions/bundled";

/**
 * Boot-wiring test for the extension-state-root normalization.
 *
 * `src/db/migrations/*.ts` are, as a rule, documentation-and-focused-test
 * modules that migrate() does NOT run — so "the migration is correct" and
 * "the migration runs" are two separate claims, and only the second one
 * saves the 4 production rows. The sibling suite
 * (db-migrations-extension-state-root.test.ts) drives `up()` directly and
 * proves the first. This one proves the second: it calls the REAL
 * `migrate()` — the exact function `initPglite()`/`initPostgres()` invoke
 * on every boot — and asserts stale rows come out canonical, with no
 * knowledge of the rewrite's internals.
 *
 * It also pins the root the rewrite is scoped to: `migrate()` must feed
 * `up()` the SAME `getProjectRoot()` every reader of extension state
 * uses. Seeding under a literal `/app` would pass even if migrate()
 * hardcoded the wrong root, so the fixture is built from
 * `getProjectRoot()` itself.
 */

async function makeDb() {
  const pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  return { pglite, db: drizzle(pglite, { schema }) };
}

// The dev-server cwd hop that produced the stale rows: extension state
// written relative to `<projectRoot>/web` instead of `<projectRoot>`.
const root = getProjectRoot();
const stale = (name: string) => `${root}/web/.ezcorp/extensions/${name}`;
const canonical = (name: string) => `${root}/.ezcorp/extensions/${name}`;

async function seedStale(db: any, name: string) {
  await db.execute(sql`
    INSERT INTO extensions (id, name, version, manifest, source, install_path, enabled)
    VALUES (${name}, ${name}, '1.0.0', '{"tools":[]}',
            ${`local:${stale(name)}`}, ${stale(name)}, TRUE)
  `);
}

async function readRow(db: any, name: string) {
  const res = await db.execute(
    sql`SELECT source, install_path FROM extensions WHERE name = ${name}`,
  );
  return (res.rows as Array<{ source: string; install_path: string | null }>)[0];
}

describe("migrate() runs the extension-state-root normalization at boot", () => {
  test("stale rows seeded between boots are canonical after the next migrate()", async () => {
    const { pglite, db } = await makeDb();
    try {
      // Boot 1: create the schema.
      await migrate(db);

      // Between boots, the old compose stack installs extensions at the
      // cwd-anchored path. These are the 4 rows observed in production.
      const names = ["weather", "weather-fixed", "weather-ui", "timezone-time-hi"];
      for (const n of names) await seedStale(db, n);

      // Boot 2: the container restarts and migrate() runs again.
      await migrate(db);

      for (const n of names) {
        const row = await readRow(db, n);
        expect(row.install_path).toBe(canonical(n));
        expect(row.source).toBe(`local:${canonical(n)}`);
      }
    } finally {
      await pglite.close();
    }
  });

  test("a third migrate() leaves the repaired rows untouched", async () => {
    const { pglite, db } = await makeDb();
    try {
      await migrate(db);
      await seedStale(db, "weather");
      await migrate(db);
      const afterRepair = await readRow(db, "weather");
      await migrate(db);

      expect(await readRow(db, "weather")).toEqual(afterRepair);
      expect(afterRepair.install_path).toBe(canonical("weather"));
    } finally {
      await pglite.close();
    }
  });

  test("the seeded builtin row (empty install_path) survives migrate()", async () => {
    const { pglite, db } = await makeDb();
    try {
      await migrate(db);

      // migrate() itself seeds this row with install_path ''. If the
      // rewrite's guard were sloppy about empty strings it would corrupt
      // a row the migration created moments earlier.
      const row = await readRow(db, "Built-in Tools");
      expect(row.install_path).toBe("");
      expect(row.source).toBe("builtin");
    } finally {
      await pglite.close();
    }
  });
});
