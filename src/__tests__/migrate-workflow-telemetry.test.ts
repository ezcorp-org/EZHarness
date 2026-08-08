import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

// Structural migration test — no query-layer imports, so no
// `mock.module` handle redirection is needed. Everything asserted here is
// read straight out of the catalog or out of a row this file inserted.
let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

type ScalarRow = { n: string | number };
type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
};

/** Every C5 telemetry column, and the type each must land as. */
const TELEMETRY_COLUMNS: Record<string, string> = {
  attempt: "integer",
  input_tokens: "integer",
  output_tokens: "integer",
  cost_usd: "numeric",
  duration_ms: "integer",
  error_code: "text",
  resolved_input: "jsonb",
  skipped_reason: "text",
};

async function columns(table: string): Promise<ColumnRow[]> {
  const res = (await db.execute(sql`
    SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale
    FROM information_schema.columns WHERE table_name = ${table} ORDER BY column_name
  `)) as { rows: ColumnRow[] };
  return res.rows;
}

async function countRows(query: ReturnType<typeof sql>): Promise<number> {
  const res = (await db.execute(query)) as { rows: ScalarRow[] };
  return Number(res.rows[0]?.n ?? 0);
}

describe("migrate() — C5 step telemetry and per-iteration rows", () => {
  beforeAll(async () => {
    pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    db = drizzle(pglite, { schema });
    await migrate(db);

    // A run + step written as if by a pre-C5 process: only the columns
    // that existed before this migration. Everything C5 adds must read
    // NULL on it, which is the whole backward-safety claim.
    await db.execute(sql`
      INSERT INTO workflow_runs (id, workflow_name, status, started_at)
      VALUES ('run-hist', 'nightly', 'success', NOW())
    `);
    await db.execute(sql`
      INSERT INTO workflow_step_runs (id, workflow_run_id, step_name, status)
      VALUES ('step-hist', 'run-hist', 'draft', 'success')
    `);
  });

  afterAll(async () => {
    await pglite?.close().catch(() => {});
  });

  test("every telemetry column lands, nullable, with the specified type", async () => {
    const byName = new Map(
      (await columns("workflow_step_runs")).map((c) => [c.column_name, c]),
    );
    for (const [name, type] of Object.entries(TELEMETRY_COLUMNS)) {
      const col = byName.get(name);
      expect(col, `workflow_step_runs.${name} is missing`).toBeDefined();
      expect(col!.data_type).toBe(type);
      // Nullable with no default is load-bearing: "absent" has to be
      // expressible, because it is the truth for every historical row.
      expect(col!.is_nullable).toBe("YES");
    }
  });

  test("cost_usd is NUMERIC(12,6), not a float", async () => {
    // A dashboard that sums floats accumulates error, and this column is
    // summed for display. `double precision` would type-check, pass every
    // behavioural test, and quietly drift.
    const col = (await columns("workflow_step_runs")).find((c) => c.column_name === "cost_usd");
    expect(col!.data_type).toBe("numeric");
    expect(col!.numeric_precision).toBe(12);
    expect(col!.numeric_scale).toBe(6);
  });

  test("historical rows are NOT backfilled — every new column reads NULL", async () => {
    // Inventing zeros here would corrupt the first aggregate anyone runs:
    // a 0 token count reads as a measurement, NULL reads as a gap, and
    // every SQL aggregate already ignores NULL.
    const nulls = await countRows(sql`
      SELECT COUNT(*)::int AS n FROM workflow_step_runs
      WHERE id = 'step-hist'
        AND attempt IS NULL AND input_tokens IS NULL AND output_tokens IS NULL
        AND cost_usd IS NULL AND duration_ms IS NULL AND error_code IS NULL
        AND resolved_input IS NULL AND skipped_reason IS NULL
    `);
    expect(nulls).toBe(1);
  });

  test("the workflow_step_runs arbiter is UNCHANGED — still (workflow_run_id, step_name)", async () => {
    // Acceptance criterion 1. Widening this to include an iteration would
    // be a DROP INDEX plus a backfill against live history; the child
    // table exists precisely so this never has to move.
    const res = (await db.execute(sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_workflow_step_run'
    `)) as { rows: Array<{ indexdef: string }> };
    expect(res.rows).toHaveLength(1);
    const def = res.rows[0]!.indexdef;
    expect(def).toContain("UNIQUE");
    expect(def).toContain("(workflow_run_id, step_name)");
    expect(def).not.toContain("iteration");

    // Behavioural: a second row still cannot take a (run, step) pair.
    const dup = await db
      .execute(sql`
        INSERT INTO workflow_step_runs (id, workflow_run_id, step_name, status)
        VALUES ('step-dup', 'run-hist', 'draft', 'error')
      `)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(Error);
  });

  test("workflow_step_iterations exists with its arbiter and lookup index", async () => {
    const cols = new Set((await columns("workflow_step_iterations")).map((c) => c.column_name));
    for (const name of [
      "id", "workflow_step_run_id", "iteration", "attempt", "status", "run_id",
      "provider", "model", "input_tokens", "output_tokens", "cost_usd",
      "duration_ms", "error_code", "created_at",
    ]) {
      expect(cols.has(name), `workflow_step_iterations.${name} is missing`).toBe(true);
    }

    const arbiter = (await db.execute(sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_workflow_step_iteration'
    `)) as { rows: Array<{ indexdef: string }> };
    expect(arbiter.rows).toHaveLength(1);
    // `attempt` is in the key on purpose: a retried iteration is a
    // distinct event, not an overwrite of the try that failed.
    expect(arbiter.rows[0]!.indexdef).toContain("(workflow_step_run_id, iteration, attempt)");

    expect(
      await countRows(sql`
        SELECT COUNT(*)::int AS n FROM pg_indexes
        WHERE indexname = 'idx_workflow_step_iterations_step'
      `),
    ).toBe(1);
  });

  test("iterations CASCADE with their step row", async () => {
    // An iteration without its step is meaningless. Contrast run HISTORY,
    // which is deliberately preserved via SET NULL.
    await db.execute(sql`
      INSERT INTO workflow_step_runs (id, workflow_run_id, step_name, status)
      VALUES ('step-loop', 'run-hist', 'revise', 'success')
    `);
    await db.execute(sql`
      INSERT INTO workflow_step_iterations (id, workflow_step_run_id, iteration, attempt, status)
      VALUES ('it-1', 'step-loop', 1, 0, 'success'), ('it-2', 'step-loop', 2, 0, 'success')
    `);
    expect(
      await countRows(sql`SELECT COUNT(*)::int AS n FROM workflow_step_iterations WHERE workflow_step_run_id = 'step-loop'`),
    ).toBe(2);

    await db.execute(sql`DELETE FROM workflow_step_runs WHERE id = 'step-loop'`);
    expect(
      await countRows(sql`SELECT COUNT(*)::int AS n FROM workflow_step_iterations WHERE workflow_step_run_id = 'step-loop'`),
    ).toBe(0);
  });

  test("the iteration arbiter separates attempts but collapses a re-write of one", async () => {
    await db.execute(sql`
      INSERT INTO workflow_step_runs (id, workflow_run_id, step_name, status)
      VALUES ('step-retry', 'run-hist', 'retryable', 'success')
    `);
    // Same iteration, different attempt — two distinct events.
    await db.execute(sql`
      INSERT INTO workflow_step_iterations (id, workflow_step_run_id, iteration, attempt, status)
      VALUES ('r-a', 'step-retry', 1, 0, 'error'), ('r-b', 'step-retry', 1, 1, 'success')
    `);
    expect(
      await countRows(sql`SELECT COUNT(*)::int AS n FROM workflow_step_iterations WHERE workflow_step_run_id = 'step-retry'`),
    ).toBe(2);

    // Same iteration AND attempt — refused, so a re-write updates rather
    // than accumulating a duplicate the trace would double-render.
    const dup = await db
      .execute(sql`
        INSERT INTO workflow_step_iterations (id, workflow_step_run_id, iteration, attempt, status)
        VALUES ('r-c', 'step-retry', 1, 1, 'success')
      `)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(Error);
  });

  test("a second migrate() is idempotent and preserves the rows", async () => {
    const before = await countRows(sql`SELECT COUNT(*)::int AS n FROM workflow_step_iterations`);
    await migrate(db);
    expect(await countRows(sql`SELECT COUNT(*)::int AS n FROM workflow_step_iterations`)).toBe(before);
    // And the re-run did not backfill the historical row it left alone.
    expect(
      await countRows(sql`SELECT COUNT(*)::int AS n FROM workflow_step_runs WHERE id = 'step-hist' AND input_tokens IS NULL`),
    ).toBe(1);
  });
});
