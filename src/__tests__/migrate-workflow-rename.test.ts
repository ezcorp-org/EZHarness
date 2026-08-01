import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
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
const { canRunWorkflow } = await import("../runtime/workflow-authz");

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
    expect(legacy?.source).toBe("db");

    // The ownership ALTER lands on the RENAMED table (it runs far later in
    // migrate(), after the rename), and the pre-existing row is left
    // unowned — which is what keeps it runnable and editable by everyone,
    // exactly as it was before the column existed.
    const owner = (await db.execute(sql`
      SELECT created_by FROM workflow_definitions WHERE id = 'legacy-1'
    `)) as { rows: Array<{ created_by: string | null }> };
    expect(owner.rows[0]?.created_by).toBeNull();
  });
});

/**
 * The UPGRADE path for `workflow_definitions.created_by`.
 *
 * The fresh-install case is covered by every other migrate() test; this is
 * the one that would actually bite a real user, because it is the only one
 * where rows already exist when the column arrives. It runs the real
 * `migrate()` over a database that predates the column, with users already
 * present, and asserts the three properties the non-breaking claim rests
 * on: the migration succeeds, existing rows survive untouched, and they
 * stay runnable by an arbitrary caller.
 *
 * Generalise this block for the next owner column — the failure mode it
 * guards (a well-meaning backfill silently reassigning every existing row)
 * is not specific to workflows.
 */
describe("migrate() — created_by upgrade path over an existing database", () => {
  beforeAll(async () => {
    await pglite?.close().catch(() => {});
    pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    db = drizzle(pglite, { schema });

    // Reproduce the pre-column schema. `migrate()` is the only source of
    // truth for the schema, and the sole EXECUTABLE difference between the
    // commit before this column and HEAD is the one `ADD COLUMN created_by`
    // statement — so migrating and dropping that column yields exactly the
    // old shape, without pinning a copy of historical DDL that would rot.
    await migrate(db);
    await db.execute(sql`ALTER TABLE workflow_definitions DROP COLUMN created_by`);

    // Users exist BEFORE the upgrade. Without this the "no backfill" claim
    // would be untestable — NULL could just mean there was nobody to
    // attribute rows to.
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, name, role)
      VALUES ('up-admin', 'up-admin@example.com', 'h', 'Admin', 'admin'),
             ('up-member', 'up-member@example.com', 'h', 'Member', 'member')
    `);
    await db.execute(sql`
      INSERT INTO workflow_definitions (id, name, description, steps)
      VALUES ('up-1', 'upgrade-alpha', 'existed before the column', '[{"name":"s1","agent":"writer"}]'::jsonb),
             ('up-2', 'upgrade-beta',  'existed before the column', '[{"name":"s1","agent":"writer"}]'::jsonb)
    `);

    // The upgrade itself.
    await migrate(db);
  });

  afterAll(async () => {
    await pglite?.close().catch(() => {});
  });

  test("adds the column to a database that already has workflow rows", async () => {
    const col = (await db.execute(sql`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'workflow_definitions' AND column_name = 'created_by'
    `)) as { rows: Array<{ data_type: string; is_nullable: string }> };
    expect(col.rows).toHaveLength(1);
    expect(col.rows[0]?.data_type).toBe("text");
    expect(col.rows[0]?.is_nullable).toBe("YES");
  });

  test("pre-existing rows survive with NULL created_by — no backfill", async () => {
    const rows = (await db.execute(sql`
      SELECT id, name, description, created_by FROM workflow_definitions
      WHERE id IN ('up-1', 'up-2') ORDER BY id
    `)) as { rows: Array<{ id: string; name: string; description: string; created_by: string | null }> };

    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => r.name)).toEqual(["upgrade-alpha", "upgrade-beta"]);
    expect(rows.rows.every((r) => r.description === "existed before the column")).toBe(true);
    // The load-bearing assertion: an admin existed at upgrade time and the
    // rows were still NOT attributed to them.
    expect(rows.rows.every((r) => r.created_by === null)).toBe(true);
  });

  test("a migrated legacy row stays runnable by an arbitrary user", async () => {
    // This is the actual non-breaking guarantee. A NULL owner must read as
    // "unowned / global", not as "owned by nobody, therefore denied".
    const [legacy] = (await loadDbWorkflows()).filter((w) => w.name === "upgrade-alpha");
    expect(legacy).toBeDefined();
    expect(legacy!.source).toBe("db");

    const stranger = await canRunWorkflow(legacy!, { id: "someone-else", role: "member" });
    expect(stranger).toEqual({ allowed: true });

    const member = await canRunWorkflow(legacy!, { id: "up-member", role: "member" });
    expect(member).toEqual({ allowed: true });
  });

  test("re-running migrate() is a no-op — no duplicate column or FK", async () => {
    await migrate(db);
    await migrate(db);

    const cols = (await db.execute(sql`
      SELECT count(*)::int AS c FROM information_schema.columns
      WHERE table_name = 'workflow_definitions' AND column_name = 'created_by'
    `)) as { rows: Array<{ c: number }> };
    expect(cols.rows[0]?.c).toBe(1);

    const fks = (await db.execute(sql`
      SELECT count(*)::int AS c FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'workflow_definitions'
        AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'created_by'
    `)) as { rows: Array<{ c: number }> };
    expect(fks.rows[0]?.c).toBe(1);

    const rows = (await db.execute(sql`
      SELECT created_by FROM workflow_definitions WHERE id IN ('up-1', 'up-2')
    `)) as { rows: Array<{ created_by: string | null }> };
    expect(rows.rows.every((r) => r.created_by === null)).toBe(true);
  });

  test("deleting the owner nulls created_by instead of destroying the row", async () => {
    await db.execute(sql`UPDATE workflow_definitions SET created_by = 'up-member' WHERE id = 'up-1'`);
    await db.execute(sql`DELETE FROM users WHERE id = 'up-member'`);

    const rows = (await db.execute(sql`
      SELECT id, name, created_by FROM workflow_definitions WHERE id IN ('up-1', 'up-2') ORDER BY id
    `)) as { rows: Array<{ id: string; name: string; created_by: string | null }> };

    // ON DELETE SET NULL, not CASCADE — user deletion must never silently
    // destroy workflows.
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.name).toBe("upgrade-alpha");
    expect(rows.rows[0]?.created_by).toBeNull();
  });
});
