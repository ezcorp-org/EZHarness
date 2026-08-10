import { test, expect, describe, afterAll, beforeAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

// Same handle-redirection pattern as migrate-workflow-rename.test.ts: the
// query layer resolves through db/connection's getDb(), so point it at
// the local instance. Tests run per-file in isolated processes.
let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

mock.module("../db/connection", () => ({
  getDb: () => db,
  getPglite: () => pglite,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
  rawQuery: async (s: string, params: (string | null)[] = []) => pglite.query(s, params),
}));

const { listWorkflowVersions } = await import("../db/queries/workflow-versions");
const { getWorkflowByName, loadDbCachedWorkflows } = await import("../db/queries/workflows");

type ScalarRow = { n: string | number };
type VisibilityRow = {
  name: string;
  visibility: string;
  project_id: string | null;
  user_id: string | null;
};

async function countVersions(): Promise<number> {
  const res = (await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM workflow_definition_versions`,
  )) as { rows: ScalarRow[] };
  return Number(res.rows[0]?.n ?? 0);
}

describe("migrate() — C6 ownership and versions", () => {
  beforeAll(async () => {
    pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    db = drizzle(pglite, { schema });

    // A DB created BEFORE C6: the pre-ownership table shape, carrying two
    // rows. This is the upgrade path the whole backward-safety argument
    // rests on.
    await db.execute(sql`
      CREATE TABLE workflow_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        input_schema JSONB,
        steps JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    await db.execute(sql`
      INSERT INTO workflow_definitions (id, name, description, steps)
      VALUES ('pre-1', 'nightly', 'shipped before C6', '[{"name":"s1","agent":"writer"}]'::jsonb),
             ('pre-2', 'deploy', '', '[{"name":"s1","agent":"shipper"}]'::jsonb)
    `);

    await migrate(db);
  });

  afterAll(async () => {
    await pglite?.close().catch(() => {});
  });

  test("every pre-existing row reads as system-owned, with NULL owner columns", async () => {
    // Acceptance criterion 2. `DEFAULT 'system'` is the entire migration —
    // no backfill, no inference — and `system` authorizes exactly the
    // callers who were authorized before the ladder existed.
    const res = (await db.execute(sql`
      SELECT name, visibility, project_id, user_id FROM workflow_definitions ORDER BY name
    `)) as { rows: VisibilityRow[] };
    expect(res.rows).toEqual([
      { name: "deploy", visibility: "system", project_id: null, user_id: null },
      { name: "nightly", visibility: "system", project_id: null, user_id: null },
    ]);
  });

  test("the cache projection reports them as system with a real id", async () => {
    const entries = await loadDbCachedWorkflows();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.visibility).toBe("system");
      expect(entry.source).toBe("db");
      expect(entry.id).not.toBeNull();
      expect(entry.forkedFrom).toBeNull();
    }
  });

  test("the unique index on name is untouched — ownership authorizes, it never namespaces", async () => {
    // Acceptance criterion 3. A composite key would let two rows share a
    // name and hand a caller in project B project A's graph.
    // Structural: a UNIQUE index over exactly `name` still exists.
    const idx = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM pg_indexes
      WHERE tablename = 'workflow_definitions' AND indexdef LIKE '%UNIQUE%(name)%'
    `)) as { rows: ScalarRow[] };
    expect(Number(idx.rows[0]!.n)).toBe(1);

    // Behavioural: a second row cannot take a name that is already held,
    // whatever its ownership.
    const dup = await db
      .execute(
        sql`INSERT INTO workflow_definitions (id, name, steps) VALUES ('dup', 'deploy', '[]'::jsonb)`,
      )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(Error);
    const stillOne = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM workflow_definitions WHERE name = 'deploy'
    `)) as { rows: ScalarRow[] };
    expect(Number(stillOne.rows[0]!.n)).toBe(1);
  });

  test("version 1 is seeded for every pre-existing definition", async () => {
    const nightly = await getWorkflowByName("nightly");
    const versions = await listWorkflowVersions(nightly!.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, name: "nightly" });
    // Never invents an author for a definition that predates versioning.
    expect(versions[0]!.createdByUserId).toBeNull();
  });

  test("workflow_runs gained definition_version_id, NULL for historical runs", async () => {
    await db.execute(sql`
      INSERT INTO workflow_runs (id, workflow_name, status, started_at)
      VALUES ('run-legacy', 'nightly', 'success', NOW())
    `);
    const res = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM workflow_runs WHERE definition_version_id IS NULL
    `)) as { rows: ScalarRow[] };
    expect(Number(res.rows[0]!.n)).toBe(1);
  });

  test("a second migrate() is idempotent and the seed is a zero-row no-op", async () => {
    const before = await countVersions();
    await migrate(db);
    expect(await countVersions()).toBe(before);

    // And nothing was reattributed on the second pass — the failure mode a
    // re-runnable CTE backfill would have had.
    const res = (await db.execute(sql`
      SELECT name, visibility, project_id, user_id FROM workflow_definitions
      WHERE name IN ('nightly','deploy') ORDER BY name
    `)) as { rows: VisibilityRow[] };
    expect(res.rows).toEqual([
      { name: "deploy", visibility: "system", project_id: null, user_id: null },
      { name: "nightly", visibility: "system", project_id: null, user_id: null },
    ]);
  });

  test("the scope index exists", async () => {
    const res = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM pg_indexes WHERE indexname = 'idx_workflow_definitions_scope'
    `)) as { rows: ScalarRow[] };
    expect(Number(res.rows[0]!.n)).toBe(1);
  });
});
