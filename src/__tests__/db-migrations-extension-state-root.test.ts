import { test, expect, describe, afterEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { up } from "../db/migrations/normalize-extension-state-root";

/**
 * Migration replay test for the extension-state-root normalization.
 *
 * Rows installed while the dev compose stack bound host
 * ./.ezcorp/extensions at the cwd-anchored /app/web/.ezcorp/extensions
 * recorded that path in `install_path` and in the matching `local:`
 * `source`. Extension code resolves state from getProjectRoot() (the dir
 * holding src/, i.e. /app), so after the bind moves those rows dangle.
 *
 * Confirms:
 *   - The stale shape is rewritten on BOTH columns, in lockstep.
 *   - The deployment root is captured, not hardcoded (a non-/app root
 *     rewrites identically).
 *   - Non-matching rows — already-canonical, github:/mcp: sources, NULL
 *     install_path, and paths that merely CONTAIN "web" — are untouched.
 *   - Re-running is a no-op (idempotent), and running against zero
 *     matching rows is safe.
 *
 * Drives the real `up()` rather than re-implementing the SQL, so the test
 * fails if the shipped migration drifts. A lightweight `extensions` table
 * (just the columns the migration touches, plus the NOT NULLs) stands in
 * for migrate.ts's full graph.
 */

const { vector } = await import("@electric-sql/pglite/vector");

let pglite: PGlite | null = null;

async function makeDb() {
  pglite = new PGlite({ extensions: { vector } });
  await pglite.waitReady;
  const db = drizzle(pglite);
  await db.execute(sql`
    CREATE TABLE extensions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      version TEXT NOT NULL DEFAULT '1.0.0',
      source TEXT NOT NULL,
      install_path TEXT
    )
  `);
  return db;
}

type Db = ReturnType<typeof drizzle>;

async function seed(db: Db, name: string, source: string, installPath: string | null) {
  await db.execute(sql`
    INSERT INTO extensions (id, name, source, install_path)
    VALUES (${name}, ${name}, ${source}, ${installPath})
  `);
}

async function read(db: Db, name: string) {
  const res = (await db.execute(
    sql`SELECT source, install_path FROM extensions WHERE name = ${name}`,
  )) as { rows: { source: string; install_path: string | null }[] };
  return res.rows[0];
}

/** Seed a row in the stale (cwd-anchored) shape under `root`. */
async function seedStale(db: Db, name: string, root = "/app") {
  const stale = `${root}/web/.ezcorp/extensions/${name}`;
  await seed(db, name, `local:${stale}`, stale);
}

afterEach(async () => {
  if (pglite) await pglite.close().catch(() => {});
  pglite = null;
});

describe("extension state root normalization migration", () => {
  test("rewrites the stale cwd-anchored shape on install_path AND source", async () => {
    const db = await makeDb();
    await seedStale(db, "weather");

    await up(db);

    const row = await read(db, "weather");
    expect(row.install_path).toBe("/app/.ezcorp/extensions/weather");
    expect(row.source).toBe("local:/app/.ezcorp/extensions/weather");
  });

  test("rewrites every legacy row (the 4 observed in production)", async () => {
    const db = await makeDb();
    const names = ["weather", "weather-fixed", "weather-ui", "timezone-time-hi"];
    for (const n of names) await seedStale(db, n);

    await up(db);

    for (const n of names) {
      const row = await read(db, n);
      expect(row.install_path).toBe(`/app/.ezcorp/extensions/${n}`);
      expect(row.source).toBe(`local:/app/.ezcorp/extensions/${n}`);
    }
  });

  test("deployment-agnostic: the root is captured, not assumed to be /app", async () => {
    const db = await makeDb();
    await seedStale(db, "notes", "/srv/ezcorp");
    await seedStale(db, "vault", "/home/dev/work/EZCorp/EZHarness");

    await up(db);

    expect((await read(db, "notes")).install_path).toBe(
      "/srv/ezcorp/.ezcorp/extensions/notes",
    );
    expect((await read(db, "vault")).source).toBe(
      "local:/home/dev/work/EZCorp/EZHarness/.ezcorp/extensions/vault",
    );
  });

  test("already-canonical rows are left byte-for-byte alone", async () => {
    const db = await makeDb();
    const canonical = "/app/.ezcorp/extensions/scratchpad";
    await seed(db, "scratchpad", `local:${canonical}`, canonical);

    await up(db);

    const row = await read(db, "scratchpad");
    expect(row.install_path).toBe(canonical);
    expect(row.source).toBe(`local:${canonical}`);
  });

  test("non-local sources and NULL install_path are untouched", async () => {
    const db = await makeDb();
    // Bundled rows carry a NULL install_path; remote installs carry a
    // scheme the `^local:` anchor must not match.
    await seed(db, "builtin", "bundled", null);
    await seed(db, "gh-ext", "github:ezcorp-org/gh-ext", null);
    await seed(db, "mcp-ext", "mcp:https://example.com/sse", null);

    await up(db);

    expect((await read(db, "builtin")).install_path).toBeNull();
    expect((await read(db, "builtin")).source).toBe("bundled");
    expect((await read(db, "gh-ext")).source).toBe("github:ezcorp-org/gh-ext");
    expect((await read(db, "mcp-ext")).source).toBe("mcp:https://example.com/sse");
  });

  test("paths that merely contain 'web' or nest deeper do not match", async () => {
    const db = await makeDb();
    // A project literally named `web` under the canonical root — the
    // stale infix is `/web/.ezcorp/extensions/`, which this does NOT have.
    const named = "/app/.ezcorp/extensions/web";
    await seed(db, "web", `local:${named}`, named);
    // Deeper than one name segment: the `[^/]+$` anchor must reject it,
    // so a file path inside an extension dir is never rewritten.
    const nested = "/app/web/.ezcorp/extensions/deep/nested/index.ts";
    await seed(db, "deep", `local:${nested}`, nested);

    await up(db);

    expect((await read(db, "web")).install_path).toBe(named);
    expect((await read(db, "web")).source).toBe(`local:${named}`);
    expect((await read(db, "deep")).install_path).toBe(nested);
    expect((await read(db, "deep")).source).toBe(`local:${nested}`);
  });

  test("a source/install_path pair can be rewritten independently", async () => {
    const db = await makeDb();
    // Defensive: a row whose source was already fixed by hand but whose
    // install_path still dangles (the exact half-migrated state a manual
    // repair leaves behind) converges to fully canonical.
    await seed(
      db,
      "halfway",
      "local:/app/.ezcorp/extensions/halfway",
      "/app/web/.ezcorp/extensions/halfway",
    );

    await up(db);

    const row = await read(db, "halfway");
    expect(row.install_path).toBe("/app/.ezcorp/extensions/halfway");
    expect(row.source).toBe("local:/app/.ezcorp/extensions/halfway");
  });

  test("idempotent — a second run changes nothing", async () => {
    const db = await makeDb();
    await seedStale(db, "weather");
    await seed(db, "builtin", "bundled", null);

    await up(db);
    const afterFirst = await read(db, "weather");
    await up(db);
    const afterSecond = await read(db, "weather");

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.install_path).toBe("/app/.ezcorp/extensions/weather");
    expect((await read(db, "builtin")).source).toBe("bundled");
  });

  test("safe on an empty table (zero matching rows)", async () => {
    const db = await makeDb();

    await up(db);

    const res = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM extensions`)) as {
      rows: { n: number }[];
    };
    expect(res.rows[0]?.n).toBe(0);
  });
});
