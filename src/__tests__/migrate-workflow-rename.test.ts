import { test, expect, describe, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

// The workflows query layer resolves its handle through db/connection's
// getDb(); point it at the local instance so loadDbWorkflows() reads the
// migrated table. (Tests run per-file in isolated processes — see
// scripts/test.sh — so this module mock does not leak to other suites.)
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

const { loadDbWorkflows } = await import("../db/queries/workflows");

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe("migrate() — pipeline_definitions → workflow_definitions rename", () => {
  test("renames the legacy table in place, preserving existing rows", async () => {
    pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    db = drizzle(pglite, { schema });

    // Seed the OLD-shape table + one row BEFORE migrate runs, simulating a DB
    // created prior to the workflows rename.
    await db.execute(sql`
      CREATE TABLE pipeline_definitions (
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
      INSERT INTO pipeline_definitions (id, name, description, steps)
      VALUES ('legacy-1', 'legacy-flow', 'from before the rename',
              '[{"name":"s1","agent":"writer"}]'::jsonb)
    `);

    await migrate(db);

    // The old table is gone and the new one exists — renamed in place, not
    // recreated empty alongside a leftover.
    const tables = (await db.execute(sql`
      SELECT to_regclass('public.pipeline_definitions') AS old_tbl,
             to_regclass('public.workflow_definitions') AS new_tbl
    `)) as { rows: Array<{ old_tbl: string | null; new_tbl: string | null }> };
    expect(tables.rows[0]?.old_tbl).toBeNull();
    expect(tables.rows[0]?.new_tbl).not.toBeNull();

    // The legacy row survived the rename and surfaces through the workflow
    // query layer.
    const workflows = await loadDbWorkflows();
    const legacy = workflows.find((w) => w.name === "legacy-flow");
    expect(legacy).toBeDefined();
    expect(legacy?.description).toBe("from before the rename");
    expect(legacy?.steps).toEqual([{ name: "s1", agent: "writer" }]);
  });
});
