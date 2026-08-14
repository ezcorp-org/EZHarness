/**
 * The two-driver half of the atomic metadata merge.
 *
 * EZCorp runs on PGlite by default and on external Postgres through `Bun.sql`
 * when `DATABASE_URL` is set, and the two drivers do NOT put the same bytes on
 * the wire for the same bound value. `src/db/queries/conversation-metadata.ts`
 * builds a raw `sql` fragment, which bypasses the drizzle column mapper on both
 * — so the driver-divergence guards that live on the column prototype
 * (`../db/nul-column-patch.ts`) and in `serializeJsonbFields`
 * (`../db/queries/extensions.ts`) do not cover it. Something has to, and a
 * PGlite-only test would not: a merge proven on PGlite proves nothing about the
 * driver half of production.
 *
 * MEASURED, NOT ASSUMED. Against a real Postgres 16 (`postgres:16-alpine`)
 * driven by `Bun.sql`, for the same JS string parameter:
 *
 *     $1::jsonb        →  jsonb_typeof = string   "{\"goal\":\"ship it\"}"
 *     $1::text::jsonb  →  jsonb_typeof = object   {"goal": "ship it"}
 *
 * Bun.sql JSON-encodes the value a SECOND time when the parameter's target type
 * is jsonb, so the JSON text lands as a jsonb STRING SCALAR — and `||` then
 * concatenates an object with a scalar into a two-element ARRAY. Nothing throws;
 * `metadata->>'goal'` simply reads NULL from then on. `::text` pins the target
 * type, the string goes on the wire verbatim, and Postgres parses it.
 *
 * That gives an exact reproduction (`asWireValue` below), verified against the
 * real server: `JSON.stringify(param)` for a jsonb target, `param` for a text
 * target. So this file can run the bun-sql BYTES on PGlite — which IS Postgres,
 * the same C source compiled to wasm — and stay honest without CI needing an
 * external server. Same methodology as `db-nul-bun-sql-driver.test.ts`.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const pg = new PGlite();
await pg.waitReady;

/**
 * Every `{sql, params}` the production helper hands the driver, captured
 * through drizzle's own logger seam — so what these tests replay is the real
 * statement, not a copy of it that could drift from the module.
 */
const sent: Array<{ sql: string; params: unknown[] }> = [];
const db = drizzle(pg, {
  logger: {
    logQuery: (sql: string, params: unknown[]) => sent.push({ sql, params }),
  },
});

/** Direct engine access, bypassing the recorder — seeds and read-backs. */
const engine = pg.query.bind(pg);

mock.module("../db/connection", () => ({
  getDb: () => db,
  getPglite: () => pg,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const { mergeConversationMetadata, deleteCallerToolsMetadata } = await import(
  "../db/queries/conversation-metadata"
);

const CONV = "c1";

beforeAll(async () => {
  // Just the two columns the fragment touches — this suite is about ENCODING,
  // so the full migrated schema would only slow it down.
  await engine(`CREATE TABLE conversations (id text PRIMARY KEY, metadata jsonb)`);
});

afterAll(async () => {
  await pg.close();
  restoreModuleMocks();
});

beforeEach(async () => {
  sent.length = 0;
  await engine(`DELETE FROM conversations`);
  await engine(
    `INSERT INTO conversations (id, metadata) VALUES ($1, '{"spawnDepth": 3}'::jsonb)`,
    [CONV],
  );
});

/**
 * What each driver actually puts on the wire for one bound parameter.
 *
 * `targetIsJsonb` is the only thing that differs, and only for bun-sql. Both
 * branches were confirmed against the real server before being written down
 * here — see the header.
 */
function asWireValue(driver: "pglite" | "bun-sql", value: unknown, targetIsJsonb: boolean): unknown {
  if (driver === "pglite") return value;
  return targetIsJsonb ? JSON.stringify(value) : value;
}

/** Re-run a captured statement under a driver's bind reproduction. */
async function replay(
  driver: "pglite" | "bun-sql",
  stmt: { sql: string; params: unknown[] },
): Promise<void> {
  // The merge fragment's `$1` is the only jsonb-target parameter the module
  // ever binds; `$2` (the id) and the delete's key are text.
  const targetIsJsonb = /\$1::jsonb(?!\w)/.test(stmt.sql);
  await engine(
    stmt.sql,
    stmt.params.map((p, i) => asWireValue(driver, p, targetIsJsonb && i === 0)),
  );
}

async function readRaw(): Promise<{ typ: string; text: string; goal: string | null }> {
  const rows = await engine<{ typ: string; text: string; goal: string | null }>(
    `SELECT jsonb_typeof(metadata) AS typ, metadata::text AS text, metadata->>'goal' AS goal
       FROM conversations WHERE id = $1`,
    [CONV],
  );
  return rows.rows[0]!;
}

/** The statement the production helper emitted, isolated from the seed writes. */
function lastUpdate(): { sql: string; params: unknown[] } {
  const stmt = sent.filter((s) => s.sql.startsWith("update ")).at(-1);
  if (!stmt) throw new Error("no UPDATE captured");
  return stmt;
}

describe("what the helper hands the driver", () => {
  test("the patch is bound as a JSON STRING, never as a JS object", async () => {
    await mergeConversationMetadata(CONV, { goal: "ship it", nested: { n: 1 } });

    const stmt = lastUpdate();
    // A raw `sql` fragment does NOT run the column mapper, so whatever is put
    // here reaches the driver untouched. Keeping it a primitive is what makes
    // the two drivers agree at all.
    expect(typeof stmt.params[0]).toBe("string");
    expect(JSON.parse(stmt.params[0] as string)).toEqual({ goal: "ship it", nested: { n: 1 } });
  });

  test("the parameter's target type is text, then cast — `::text::jsonb`", async () => {
    await mergeConversationMetadata(CONV, { goal: "ship it" });

    const { sql } = lastUpdate();
    expect(sql).toContain("$1::text::jsonb");
    // The naive form is the one that silently corrupts on bun-sql.
    expect(sql).not.toMatch(/\$1::jsonb(?!\w)/);
  });
});

describe.each(["pglite", "bun-sql"] as const)("%s bind form", (driver) => {
  test("a merge stores a jsonb OBJECT and preserves the sibling key", async () => {
    await mergeConversationMetadata(CONV, { goal: "ship it", nested: { list: ["a"], n: 1 } });
    const stmt = lastUpdate();

    // Undo the arm the helper already executed on PGlite, then replay the
    // statement under THIS driver's bind reproduction.
    await engine(`UPDATE conversations SET metadata = '{"spawnDepth": 3}'::jsonb WHERE id = $1`, [
      CONV,
    ]);
    await replay(driver, stmt);

    const raw = await readRaw();
    expect(raw.typ).toBe("object");
    // `->>` resolving is the assertion: on the string scalar this cast exists
    // to prevent, it is NULL.
    expect(raw.goal).toBe("ship it");
    expect(JSON.parse(raw.text)).toEqual({
      spawnDepth: 3,
      goal: "ship it",
      nested: { list: ["a"], n: 1 },
    });
  });

  test("a key delete removes only that key", async () => {
    await engine(
      `UPDATE conversations SET metadata = '{"callerTools": {"a": 1}, "goal": "keep"}'::jsonb WHERE id = $1`,
      [CONV],
    );
    sent.length = 0;
    await deleteCallerToolsMetadata(CONV);
    const stmt = lastUpdate();

    await engine(
      `UPDATE conversations SET metadata = '{"callerTools": {"a": 1}, "goal": "keep"}'::jsonb WHERE id = $1`,
      [CONV],
    );
    await replay(driver, stmt);

    const raw = await readRaw();
    expect(raw.typ).toBe("object");
    expect(JSON.parse(raw.text)).toEqual({ goal: "keep" });
  });

  test("a NUL-bearing patch is scrubbed before it reaches the wire", async () => {
    const NUL = String.fromCharCode(0);
    await mergeConversationMetadata(CONV, { goal: `ship${NUL} it` });
    const stmt = lastUpdate();

    await engine(`UPDATE conversations SET metadata = '{"spawnDepth": 3}'::jsonb WHERE id = $1`, [
      CONV,
    ]);
    await replay(driver, stmt);

    const raw = await readRaw();
    expect(raw.goal).toBe(`ship${String.fromCharCode(0xfffd)} it`);
  });
});

describe("the ::text cast is what makes bun-sql agree (guards the arm above)", () => {
  test("WITHOUT it, the bun-sql bind form yields an ARRAY and `->>'goal'` reads NULL", async () => {
    // Exactly the statement the helper would emit if `::text` were dropped —
    // the regression this file exists to catch. It does not throw; it corrupts.
    const naive = {
      sql: `UPDATE conversations SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
      params: [JSON.stringify({ goal: "ship it" }), CONV],
    };

    await replay("bun-sql", naive);

    const raw = await readRaw();
    expect(raw.typ).toBe("array");
    expect(raw.goal).toBeNull();
  });

  test("…while the SAME statement is harmless on PGlite — which is why one driver cannot vet it", async () => {
    const naive = {
      sql: `UPDATE conversations SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
      params: [JSON.stringify({ goal: "ship it" }), CONV],
    };

    await replay("pglite", naive);

    const raw = await readRaw();
    expect(raw.typ).toBe("object");
    expect(raw.goal).toBe("ship it");
  });
});
