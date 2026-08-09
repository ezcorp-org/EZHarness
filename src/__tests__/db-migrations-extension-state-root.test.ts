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
 *   - The rewrite is scoped to the PASSED-IN project root: a root that
 *     itself ends in `web`, and rows recorded under a different root, are
 *     left alone. This is the sharp edge — see
 *     "root-scoped, not wildcarded" below.
 *   - Non-matching rows — already-canonical, github:/mcp: sources, NULL /
 *     empty install_path, deeper-than-one-segment paths, and paths that
 *     merely CONTAIN "web" — are untouched.
 *   - Roots and names containing regex metacharacters survive verbatim.
 *   - Re-running is a no-op (idempotent), and running against zero
 *     matching rows is safe.
 *
 * Drives the real `up()` rather than re-implementing the SQL, so the test
 * fails if the shipped migration drifts. A lightweight `extensions` table
 * (just the columns the migration touches, plus the NOT NULLs) stands in
 * for migrate.ts's full graph.
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

/** Seed a row whose `source` is the `local:`-prefixed `install_path`. */
async function seedLocal(db: Db, name: string, installPath: string) {
  await seed(db, name, `local:${installPath}`, installPath);
}

async function read(db: Db, name: string) {
  const res = (await db.execute(
    sql`SELECT source, install_path FROM extensions WHERE name = ${name}`,
  )) as { rows: { source: string; install_path: string | null }[] };
  return res.rows[0];
}

/**
 * Both columns of a row as the `[install_path, source]` pair tests compare on.
 *
 * The comparison itself deliberately stays at the CALL SITE rather than living
 * in a shared `expectLocal()` helper: an assertion hidden behind a helper is
 * invisible both to a reader skimming the test and to `scripts/gate-integrity.ts`,
 * which reads a `test()` body with no literal `expect(` as a vacuous test.
 */
async function localPair(db: Db, name: string) {
  const row = await read(db, name);
  return [row.install_path, row.source];
}

/** The pair a row must land on once it points at `installPath`. */
const localPairFor = (installPath: string) => [installPath, `local:${installPath}`];

const stalePath = (name: string, root = ROOT) => `${root}/web/.ezcorp/extensions/${name}`;
const canonicalPath = (name: string, root = ROOT) => `${root}/.ezcorp/extensions/${name}`;

/** Seed a row in the stale (cwd-anchored) shape under `root`. */
async function seedStale(db: Db, name: string, root = ROOT) {
  await seedLocal(db, name, stalePath(name, root));
}

afterEach(async () => {
  if (pglite) await pglite.close().catch(() => {});
  pglite = null;
});

describe("extension state root normalization migration", () => {
  test("rewrites the stale cwd-anchored shape on install_path AND source", async () => {
    const db = await makeDb();
    await seedStale(db, "weather");

    await up(db, ROOT);

    expect(await localPair(db, "weather")).toEqual(localPairFor(canonicalPath("weather")));
  });

  test("rewrites every legacy row (the 4 observed in production)", async () => {
    const db = await makeDb();
    const names = ["weather", "weather-fixed", "weather-ui", "timezone-time-hi"];
    for (const n of names) await seedStale(db, n);

    await up(db, ROOT);

    for (const n of names) expect(await localPair(db, n)).toEqual(localPairFor(canonicalPath(n)));
  });

  test("deployment-agnostic: any root works, none is hardcoded", async () => {
    const db = await makeDb();
    await seedStale(db, "notes", "/srv/ezcorp");
    await seedStale(db, "vault", "/home/dev/work/EZCorp/EZHarness");

    await up(db, "/srv/ezcorp");
    await up(db, "/home/dev/work/EZCorp/EZHarness");

    expect(await localPair(db, "notes")).toEqual(
      localPairFor(canonicalPath("notes", "/srv/ezcorp")),
    );
    expect(await localPair(db, "vault")).toEqual(
      localPairFor(canonicalPath("vault", "/home/dev/work/EZCorp/EZHarness")),
    );
  });

  test("a trailing slash on the passed root builds the same prefix", async () => {
    const db = await makeDb();
    await seedStale(db, "weather");

    await up(db, `${ROOT}/`);

    expect(await localPair(db, "weather")).toEqual(localPairFor(canonicalPath("weather")));
  });
});

/**
 * The regression the root parameter exists for.
 *
 * A wildcard `^(.*)/web/\.ezcorp/extensions/([^/]+)$` cannot tell a cwd
 * hop from a project root that merely ends in `web`. Under it, a
 * deployment rooted at /srv/web has its perfectly canonical
 * /srv/web/.ezcorp/extensions/foo rewritten to
 * /srv/.ezcorp/extensions/foo — a dangling path, produced on every boot,
 * with the original value destroyed. Matching on the resolved root makes
 * the distinction exact.
 */
describe("root-scoped, not wildcarded", () => {
  test("a root that ENDS in /web keeps its already-canonical rows", async () => {
    const db = await makeDb();
    const root = "/srv/web";
    const canonical = canonicalPath("foo", root); // /srv/web/.ezcorp/extensions/foo
    await seedLocal(db, "foo", canonical);

    await up(db, root);

    expect(await localPair(db, "foo")).toEqual(localPairFor(canonical));
  });

  test("a root that ends in /web still gets its genuinely stale rows fixed", async () => {
    const db = await makeDb();
    const root = "/srv/web";
    await seedStale(db, "bar", root); // /srv/web/web/.ezcorp/extensions/bar

    await up(db, root);

    expect(await localPair(db, "bar")).toEqual(localPairFor(canonicalPath("bar", root)));
  });

  test("rows under a DIFFERENT root are left alone", async () => {
    const db = await makeDb();
    // Restored from another machine's dump: the files are not on this
    // disk under either spelling, so rewriting would only destroy the
    // forensic trail.
    const foreign = stalePath("ghost", "/opt/elsewhere");
    await seedLocal(db, "ghost", foreign);

    await up(db, ROOT);

    expect(await localPair(db, "ghost")).toEqual(localPairFor(foreign));
  });

  test("regex metacharacters in the root are matched literally", async () => {
    const db = await makeDb();
    // `(`, `)`, `+` and `.` would all be operators if the root were
    // interpolated into a pattern instead of compared as a string.
    const root = "/opt/EZCorp (v2)/a+b";
    await seedStale(db, "quirk", root);

    await up(db, root);

    expect(await localPair(db, "quirk")).toEqual(localPairFor(canonicalPath("quirk", root)));
  });
});

describe("rows the migration must not touch", () => {
  test("already-canonical rows are left byte-for-byte alone", async () => {
    const db = await makeDb();
    const canonical = canonicalPath("scratchpad");
    await seedLocal(db, "scratchpad", canonical);

    await up(db, ROOT);

    expect(await localPair(db, "scratchpad")).toEqual(localPairFor(canonical));
  });

  test("non-local sources and NULL install_path are untouched", async () => {
    const db = await makeDb();
    // Bundled rows carry a NULL install_path; remote installs carry a
    // scheme the `local:` prefix must not match.
    await seed(db, "builtin", "bundled", null);
    await seed(db, "gh-ext", "github:ezcorp-org/gh-ext", null);
    await seed(db, "mcp-ext", "mcp:https://example.com/sse", null);

    await up(db, ROOT);

    expect((await read(db, "builtin")).install_path).toBeNull();
    expect((await read(db, "builtin")).source).toBe("bundled");
    expect((await read(db, "gh-ext")).source).toBe("github:ezcorp-org/gh-ext");
    expect((await read(db, "mcp-ext")).source).toBe("mcp:https://example.com/sse");
  });

  test("the empty install_path of the seeded builtin row survives", async () => {
    const db = await makeDb();
    // migrate.ts seeds `('builtin', …, 'builtin', '')` — an empty string,
    // not NULL, so it exercises a different branch of the guard.
    await seed(db, "native-tools", "builtin", "");

    await up(db, ROOT);

    const row = await read(db, "native-tools");
    expect(row.install_path).toBe("");
    expect(row.source).toBe("builtin");
  });

  test("paths that merely contain 'web' or nest deeper do not match", async () => {
    const db = await makeDb();
    // An extension literally named `web` under the canonical root — the
    // stale prefix is `/app/web/.ezcorp/extensions/`, which this lacks.
    const named = canonicalPath("web");
    await seedLocal(db, "web", named);
    // Deeper than one name segment: a file path inside an extension dir
    // is never rewritten.
    const nested = `${stalePath("deep")}/nested/index.ts`;
    await seedLocal(db, "deep", nested);
    // The prefix with no name after it.
    const bare = `${ROOT}/web/.ezcorp/extensions/`;
    await seedLocal(db, "bare", bare);

    await up(db, ROOT);

    expect(await localPair(db, "web")).toEqual(localPairFor(named));
    expect(await localPair(db, "deep")).toEqual(localPairFor(nested));
    expect(await localPair(db, "bare")).toEqual(localPairFor(bare));
  });

  test("an extension named 'web' in the stale shape still migrates", async () => {
    const db = await makeDb();
    await seedStale(db, "web");

    await up(db, ROOT);

    expect(await localPair(db, "web")).toEqual(localPairFor(canonicalPath("web")));
  });
});

describe("convergence and re-entrancy", () => {
  test("a source/install_path pair can be rewritten independently", async () => {
    const db = await makeDb();
    // Defensive: a row whose source was already fixed by hand but whose
    // install_path still dangles (the exact half-migrated state a manual
    // repair leaves behind) converges to fully canonical.
    await seed(db, "halfway", `local:${canonicalPath("halfway")}`, stalePath("halfway"));

    await up(db, ROOT);

    expect(await localPair(db, "halfway")).toEqual(localPairFor(canonicalPath("halfway")));
  });

  test("idempotent — a second run changes nothing", async () => {
    const db = await makeDb();
    await seedStale(db, "weather");
    await seed(db, "builtin", "bundled", null);

    await up(db, ROOT);
    const afterFirst = await read(db, "weather");
    await up(db, ROOT);
    const afterSecond = await read(db, "weather");

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.install_path).toBe(canonicalPath("weather"));
    expect((await read(db, "builtin")).source).toBe("bundled");
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
