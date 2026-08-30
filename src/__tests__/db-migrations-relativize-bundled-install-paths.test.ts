import { test, expect, describe, afterEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { up } from "../db/migrations/relativize-bundled-install-paths";

/**
 * Migration replay test for the bundled install-path relativization.
 *
 * Bundled rows recorded `install_path` as `join(getProjectRoot(), entry.path)`
 * — an absolute path baked in by whichever environment (typically the
 * container, root `/app`) ran `ensureBundledExtensions()`. That baked-in path
 * is unresolvable from a different root (a host-side process reading the
 * same shared database), which is the root cause of the 2026-08 incident:
 * ENOENT workflow-scan warnings followed by two extensions permanently
 * auto-disabled. This migration rewrites those rows to the project-root
 * RELATIVE form the code now persists on fresh installs.
 *
 * Confirms:
 *   - The absolute shape is rewritten on BOTH `install_path` AND `source`,
 *     in lockstep, for bundled rows.
 *   - Scoped to `is_bundled = true`: a NON-bundled row whose absolute path
 *     happens to sit under the same root (e.g. `ezcorp ext install
 *     ./my-ext` run from the project root) is left byte-for-byte alone.
 *   - Scoped to the PASSED-IN root: a bundled row recorded under a
 *     different root is left alone.
 *   - Multi-segment bundled paths (`docs/extensions/examples/<name>`,
 *     `extensions/<name>`, `packages/@ezcorp/ai-kit`) all rewrite correctly
 *     — unlike the `.ezcorp/extensions/<name>` shape this migration's sibling
 *     handles, there is no "exactly one segment" constraint here.
 *   - Already-relative (fresh-install-shaped) rows are untouched.
 *   - NULL `install_path` and non-`local:` sources are untouched.
 *   - Regex metacharacters in the root are matched literally.
 *   - Re-running is a no-op (idempotent), and running against zero
 *     matching rows is safe.
 *   - `install_path` and `source` converge independently when only one
 *     was hand-repaired.
 *
 * Drives the real `up()` rather than re-implementing the SQL, so the test
 * fails if the shipped migration drifts. A lightweight `extensions` table
 * (just the columns the migration touches, plus `is_bundled`) stands in for
 * migrate.ts's full graph.
 */

const { vector } = await import("@electric-sql/pglite-pgvector");

let pglite: PGlite | null = null;

/** The root the container actually resolves; the live rows sit under it. */
const ROOT = "/app";

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
      install_path TEXT,
      is_bundled BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  return db;
}

type Db = ReturnType<typeof drizzle>;

async function seed(
  db: Db,
  name: string,
  source: string,
  installPath: string | null,
  isBundled: boolean,
) {
  await db.execute(sql`
    INSERT INTO extensions (id, name, source, install_path, is_bundled)
    VALUES (${name}, ${name}, ${source}, ${installPath}, ${isBundled})
  `);
}

/** Seed a bundled row whose `source` is the `local:`-prefixed `install_path`
 *  — the exact shape `ensureBundledExtensions()` writes. */
async function seedBundled(db: Db, name: string, installPath: string) {
  await seed(db, name, `local:${installPath}`, installPath, true);
}

async function read(db: Db, name: string) {
  const res = (await db.execute(
    sql`SELECT source, install_path, is_bundled FROM extensions WHERE name = ${name}`,
  )) as { rows: { source: string; install_path: string | null; is_bundled: boolean }[] };
  return res.rows[0];
}

async function localPair(db: Db, name: string) {
  const row = await read(db, name);
  return [row.install_path, row.source];
}

const localPairFor = (installPath: string) => [installPath, `local:${installPath}`];

const absPath = (relPath: string, root = ROOT) => `${root}/${relPath}`;

afterEach(async () => {
  if (pglite) await pglite.close().catch(() => {});
  pglite = null;
});

describe("bundled install-path relativization migration", () => {
  test("rewrites an absolute bundled install_path AND source to the relative form", async () => {
    const db = await makeDb();
    await seedBundled(db, "web-search", absPath("docs/extensions/examples/web-search"));

    await up(db, ROOT);

    expect(await localPair(db, "web-search")).toEqual(
      localPairFor("docs/extensions/examples/web-search"),
    );
  });

  test("rewrites every bundled row shape observed in production", async () => {
    const db = await makeDb();
    await seedBundled(db, "github-projects", absPath("docs/extensions/examples/github-projects"));
    await seedBundled(db, "ping-loop", absPath("docs/extensions/examples/ping-loop"));
    // A path directly under `extensions/` (not `docs/extensions/examples/`).
    await seedBundled(db, "ez-factory", absPath("extensions/ez-factory"));
    // A multi-segment, non-`docs/extensions` path.
    await seedBundled(db, "ai-kit", absPath("packages/@ezcorp/ai-kit"));

    await up(db, ROOT);

    expect(await localPair(db, "github-projects")).toEqual(
      localPairFor("docs/extensions/examples/github-projects"),
    );
    expect(await localPair(db, "ping-loop")).toEqual(
      localPairFor("docs/extensions/examples/ping-loop"),
    );
    expect(await localPair(db, "ez-factory")).toEqual(localPairFor("extensions/ez-factory"));
    expect(await localPair(db, "ai-kit")).toEqual(localPairFor("packages/@ezcorp/ai-kit"));
  });

  test("deployment-agnostic: any root works, none is hardcoded", async () => {
    const db = await makeDb();
    await seedBundled(db, "notes", absPath("docs/extensions/examples/notes", "/srv/ezcorp"));
    await seedBundled(
      db,
      "vault",
      absPath("extensions/vault", "/home/dev/work/EZCorp/EZHarness"),
    );

    await up(db, "/srv/ezcorp");
    await up(db, "/home/dev/work/EZCorp/EZHarness");

    expect(await localPair(db, "notes")).toEqual(
      localPairFor("docs/extensions/examples/notes"),
    );
    expect(await localPair(db, "vault")).toEqual(localPairFor("extensions/vault"));
  });

  test("a trailing slash on the passed root builds the same prefix", async () => {
    const db = await makeDb();
    await seedBundled(db, "web-search", absPath("docs/extensions/examples/web-search"));

    await up(db, `${ROOT}/`);

    expect(await localPair(db, "web-search")).toEqual(
      localPairFor("docs/extensions/examples/web-search"),
    );
  });

  test("regex metacharacters in the root are matched literally", async () => {
    const db = await makeDb();
    const root = "/opt/EZCorp (v2)/a+b";
    await seedBundled(db, "quirk", absPath("docs/extensions/examples/quirk", root));

    await up(db, root);

    expect(await localPair(db, "quirk")).toEqual(
      localPairFor("docs/extensions/examples/quirk"),
    );
  });
});

describe("rows the migration must not touch", () => {
  test("a NON-bundled row whose absolute path sits under the same root is left alone", async () => {
    // `ezcorp ext install ./my-ext` run from the project root: the
    // resulting install_path ALSO starts with `<root>/`, but there is no
    // `entry.path` to reconstruct it from, and this row's on-disk location
    // genuinely IS environment-specific.
    const db = await makeDb();
    const p = absPath("my-ext");
    await seed(db, "my-ext", `local:${p}`, p, false);

    await up(db, ROOT);

    expect(await localPair(db, "my-ext")).toEqual(localPairFor(p));
  });

  test("a bundled row recorded under a DIFFERENT root is left alone", async () => {
    const db = await makeDb();
    const foreign = absPath("docs/extensions/examples/ghost", "/opt/elsewhere");
    await seedBundled(db, "ghost", foreign);

    await up(db, ROOT);

    expect(await localPair(db, "ghost")).toEqual(localPairFor(foreign));
  });

  test("an already-relative (fresh-install-shaped) bundled row is untouched", async () => {
    const db = await makeDb();
    const rel = "docs/extensions/examples/scratchpad";
    await seedBundled(db, "scratchpad", rel);

    await up(db, ROOT);

    expect(await localPair(db, "scratchpad")).toEqual(localPairFor(rel));
  });

  test("a bundled row with NULL install_path and a non-local source is untouched", async () => {
    const db = await makeDb();
    await seed(db, "mcp-ext", "mcp:https://example.com/sse", null, true);

    await up(db, ROOT);

    const row = await read(db, "mcp-ext");
    expect(row.install_path).toBeNull();
    expect(row.source).toBe("mcp:https://example.com/sse");
  });

  test("the bare root with nothing after it is untouched", async () => {
    const db = await makeDb();
    // A pathological row whose install_path IS the root — no `entry.path`
    // remainder, so the ">length" guard excludes it.
    await seedBundled(db, "bare", ROOT);

    await up(db, ROOT);

    expect(await localPair(db, "bare")).toEqual(localPairFor(ROOT));
  });
});

describe("convergence and re-entrancy", () => {
  test("install_path and source converge independently when only one was hand-repaired", async () => {
    const db = await makeDb();
    await seed(
      db,
      "halfway",
      "local:docs/extensions/examples/halfway",
      absPath("docs/extensions/examples/halfway"),
      true,
    );

    await up(db, ROOT);

    expect(await localPair(db, "halfway")).toEqual(
      localPairFor("docs/extensions/examples/halfway"),
    );
  });

  test("idempotent — a second run changes nothing", async () => {
    const db = await makeDb();
    await seedBundled(db, "web-search", absPath("docs/extensions/examples/web-search"));

    await up(db, ROOT);
    const afterFirst = await read(db, "web-search");
    await up(db, ROOT);
    const afterSecond = await read(db, "web-search");

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.install_path).toBe("docs/extensions/examples/web-search");
  });

  test("safe on an empty table (zero matching rows)", async () => {
    const db = await makeDb();

    await up(db, ROOT);

    const res = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM extensions`)) as {
      rows: { n: number }[];
    };
    expect(res.rows[0]?.n).toBe(0);
  });
});
