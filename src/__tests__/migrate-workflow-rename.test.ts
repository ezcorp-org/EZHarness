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

const { loadDbWorkflows, loadDbCachedWorkflows } = await import("../db/queries/workflows");
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

    // The ownership ALTERs land on the RENAMED table (they run far later in
    // migrate(), after the rename), and the pre-existing row is left
    // unowned and `system` — which is what keeps it runnable by everyone,
    // exactly as it was before the columns existed.
    const owner = (await db.execute(sql`
      SELECT user_id, visibility FROM workflow_definitions WHERE id = 'legacy-1'
    `)) as { rows: Array<{ user_id: string | null; visibility: string }> };
    expect(owner.rows[0]?.user_id).toBeNull();
    expect(owner.rows[0]?.visibility).toBe("system");
  });
});

/**
 * The UPGRADE path for workflow OWNERSHIP over a database that already has
 * rows.
 *
 * The fresh-install case is covered by every other migrate() test; this is
 * the one that would actually bite a real user, because it is the only one
 * where rows already exist when the columns arrive. The simulated
 * pre-state is deliberately the WORST one: no ladder columns, but WITH the
 * superseded `created_by` — the shape an install that ran the intermediate
 * commit is in. So one `migrate()` has to both add the ladder and drop the
 * dead column, over live rows.
 *
 * Asserts the properties the non-breaking claim rests on: the migration
 * succeeds, existing rows survive untouched and unattributed, and they
 * stay runnable by an arbitrary caller.
 *
 * Generalise this block for the next owner column — the failure mode it
 * guards (a well-meaning backfill silently reassigning every existing row)
 * is not specific to workflows.
 */
/** The ownership columns this block reads back off `workflow_definitions`.
 *  A `type`, not an `interface`: only an alias gets the implicit index
 *  signature that lets drizzle's `Results<Record<string, unknown>>` be cast
 *  to it directly, the way every other query in this file is. */
type OwnedRow = {
  id: string;
  name: string;
  description: string;
  user_id: string | null;
  visibility: string;
};

describe("migrate() — ownership upgrade path over an existing database", () => {
  beforeAll(async () => {
    await pglite?.close().catch(() => {});
    pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    db = drizzle(pglite, { schema });

    // Reproduce the pre-ownership schema. `migrate()` is the only source of
    // truth for the schema, so migrating and then reversing the ownership
    // ALTERs yields exactly the old shape, without pinning a copy of
    // historical DDL that would rot. `created_by` is put BACK to simulate
    // an install that ran the intermediate commit, so the drop this
    // migration performs is genuinely exercised against a real column.
    await migrate(db);
    await db.execute(sql`ALTER TABLE workflow_definitions DROP COLUMN IF EXISTS project_id`);
    await db.execute(sql`ALTER TABLE workflow_definitions DROP COLUMN IF EXISTS user_id`);
    await db.execute(sql`ALTER TABLE workflow_definitions DROP COLUMN IF EXISTS visibility`);
    await db.execute(sql`ALTER TABLE workflow_definitions DROP COLUMN IF EXISTS forked_from`);
    await db.execute(sql`ALTER TABLE workflow_definitions ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL`);

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

  test("adds the ownership columns to a database that already has workflow rows", async () => {
    const col = (await db.execute(sql`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'workflow_definitions'
        AND column_name IN ('user_id', 'project_id', 'visibility', 'forked_from')
      ORDER BY column_name
    `)) as { rows: Array<{ column_name: string; data_type: string; is_nullable: string }> };
    expect(col.rows.map((r) => r.column_name)).toEqual([
      "forked_from",
      "project_id",
      "user_id",
      "visibility",
    ]);
    // The owner is nullable — `ON DELETE SET NULL` depends on it — while
    // `visibility` is NOT NULL, so no row can be un-ladderable.
    const byName = new Map(col.rows.map((r) => [r.column_name, r]));
    expect(byName.get("user_id")?.is_nullable).toBe("YES");
    expect(byName.get("visibility")?.is_nullable).toBe("NO");
  });

  test("drops the superseded created_by column that was there beforehand", async () => {
    // The pre-state above really had the column; this asserts the upgrade
    // removed it rather than leaving two owner columns in the table.
    const col = (await db.execute(sql`
      SELECT count(*)::int AS c FROM information_schema.columns
      WHERE table_name = 'workflow_definitions' AND column_name = 'created_by'
    `)) as { rows: Array<{ c: number }> };
    expect(col.rows[0]?.c).toBe(0);
  });

  test("pre-existing rows survive the upgrade unattributed — no backfill", async () => {
    const rows = (await db.execute(sql`
      SELECT id, name, description, user_id, visibility FROM workflow_definitions
      WHERE id IN ('up-1', 'up-2') ORDER BY id
    `)) as { rows: OwnedRow[] };

    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => r.name)).toEqual(["upgrade-alpha", "upgrade-beta"]);
    expect(rows.rows.every((r) => r.description === "existed before the column")).toBe(true);
    // The load-bearing assertion: an admin existed at upgrade time and the
    // rows were still NOT attributed to them. Ownership is never guessed.
    expect(rows.rows.every((r) => r.user_id === null)).toBe(true);
    // Every pre-existing row becomes `system`, which authorizes exactly the
    // callers who could run it before the ladder existed.
    expect(rows.rows.every((r) => r.visibility === "system")).toBe(true);
  });

  test("a migrated legacy row stays runnable by an arbitrary user", async () => {
    // This is the actual non-breaking guarantee: `system` reads as "ships
    // with the install", not as "owned by nobody, therefore denied".
    const [legacy] = (await loadDbCachedWorkflows()).filter(
      (w) => w.definition.name === "upgrade-alpha",
    );
    expect(legacy).toBeDefined();
    expect(legacy!.source).toBe("db");
    expect(legacy!.visibility).toBe("system");

    const stranger = await canRunWorkflow(legacy!, { id: "someone-else", role: "member" });
    expect(stranger).toEqual({ allowed: true });

    const member = await canRunWorkflow(legacy!, { id: "up-member", role: "member" });
    expect(member).toEqual({ allowed: true });
  });

  test("the superseded created_by column is dropped, and dropping it is idempotent", async () => {
    // A second authorization model briefly added `created_by` here. It is
    // gone: it disagreed with `user_id`/`visibility` about what a NULL
    // owner means, and nothing ever wrote it, so there was no ownership to
    // carry across.
    await migrate(db);
    await migrate(db);

    const cols = (await db.execute(sql`
      SELECT count(*)::int AS c FROM information_schema.columns
      WHERE table_name = 'workflow_definitions' AND column_name = 'created_by'
    `)) as { rows: Array<{ c: number }> };
    expect(cols.rows[0]?.c).toBe(0);

    // The surviving owner column is still there, exactly once, and the
    // rows it governs were not disturbed by the drop.
    const ownerCol = (await db.execute(sql`
      SELECT count(*)::int AS c FROM information_schema.columns
      WHERE table_name = 'workflow_definitions' AND column_name = 'user_id'
    `)) as { rows: Array<{ c: number }> };
    expect(ownerCol.rows[0]?.c).toBe(1);

    const rows = (await db.execute(sql`
      SELECT user_id FROM workflow_definitions WHERE id IN ('up-1', 'up-2')
    `)) as { rows: Array<{ user_id: string | null }> };
    expect(rows.rows.every((r) => r.user_id === null)).toBe(true);
  });

  test("deleting the owner nulls user_id instead of destroying the row", async () => {
    await db.execute(sql`UPDATE workflow_definitions SET user_id = 'up-member' WHERE id = 'up-1'`);
    await db.execute(sql`DELETE FROM users WHERE id = 'up-member'`);

    const rows = (await db.execute(sql`
      SELECT id, name, user_id FROM workflow_definitions WHERE id IN ('up-1', 'up-2') ORDER BY id
    `)) as { rows: Array<{ id: string; name: string; user_id: string | null }> };

    // ON DELETE SET NULL, not CASCADE — user deletion must never silently
    // destroy workflows.
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.name).toBe("upgrade-alpha");
    expect(rows.rows[0]?.user_id).toBeNull();
  });
});
