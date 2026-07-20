import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb } from "./helpers/test-pglite";

// ── Regression suite for "jsonb stored as string scalar" ─────────────
//
// When DATABASE_URL is set we connect via drizzle-orm/bun-sql. Drizzle's
// default `mapToDriverValue = JSON.stringify` produces a JS string that
// Bun.sql then binds as a TEXT parameter, which Postgres stores in the jsonb
// column as a string scalar (jsonb_typeof = 'string') rather than as the
// original object. Every `col->>'key'` lookup then returns NULL — how the
// Token-Usage-by-Day chart ended up empty.
//
// The fix in src/db/connection.ts has two parts, and these tests call the REAL
// exported functions (via `__test`) — NOT a re-declared local copy — so a
// revert of either part during a drizzle upgrade fails the suite:
//   1. `applyBunSqlJsonbFix()` overrides drizzle's PgJson/PgJsonb
//      mapToDriverValue to identity so Bun.sql receives the JS object.
//   2. `repairDoubleEncodedJsonb()` unwraps historical rows whose inner text
//      is an object/array (leaving legitimate scalar strings alone), guarded
//      by a one-shot settings marker so it never re-scans on later boots.
//
// PGlite doesn't suffer from the double-encoding bug, so we seed the "bad"
// shape directly and drive the real repair against the test PGlite via
// `__test.setState`.

restoreModuleMocks();
const conn = await import("../db/connection");

type TestDb = Awaited<ReturnType<typeof setupTestDb>>["db"];

async function seedProject(db: TestDb) {
  await db.execute(
    sql`INSERT INTO projects (id, name, path) VALUES ('rp', 'Repair', '/tmp/rp') ON CONFLICT (id) DO NOTHING`,
  );
}

describe("repairDoubleEncodedJsonb — real function, one sweep", () => {
  let db: TestDb;

  beforeAll(async () => {
    const t = await setupTestDb();
    db = t.db;
    conn.__test.setState(t.db, t.pglite);
    await seedProject(db);
  });

  afterAll(async () => {
    conn.__test.setState(null, null);
    await closeTestDb();
    restoreModuleMocks();
  });

  test("unwraps double-encoded object AND leaves scalar strings untouched", async () => {
    const convId = crypto.randomUUID();
    await db.execute(sql`INSERT INTO conversations (id, project_id, title) VALUES (${convId}, 'rp', 'c')`);
    const msgId = crypto.randomUUID();

    // Broken shape: object already JSON-stringified then cast to jsonb — a
    // string scalar.
    const stringified = JSON.stringify({ inputTokens: 123, outputTokens: 45 });
    await db.execute(sql`
      INSERT INTO messages (id, conversation_id, role, content, usage)
      VALUES (${msgId}, ${convId}, 'assistant', 'probe', to_jsonb(${stringified}::text))
    `);
    // Legitimate scalar strings that MUST survive the repair.
    await db.execute(sql`INSERT INTO settings (key, value) VALUES ('probe:mode', to_jsonb('yolo'::text)) ON CONFLICT (key) DO NOTHING`);
    await db.execute(sql`INSERT INTO settings (key, value) VALUES ('probe:blob', to_jsonb('v1:abcdef0123456789'::text)) ON CONFLICT (key) DO NOTHING`);

    const before = await db.execute(sql`SELECT jsonb_typeof(usage) as t FROM messages WHERE id = ${msgId}`);
    expect((before.rows[0] as { t: string }).t).toBe("string");

    // Drive the REAL production repair.
    await conn.__test.repairDoubleEncodedJsonb(sql);

    const after = await db.execute(
      sql`SELECT jsonb_typeof(usage) as t, (usage->>'inputTokens')::int as input FROM messages WHERE id = ${msgId}`,
    );
    expect((after.rows[0] as { t: string }).t).toBe("object");
    expect((after.rows[0] as { input: number }).input).toBe(123);

    // Scalar-string settings untouched.
    const scalars = await db.execute(
      sql`SELECT key, jsonb_typeof(value) as t, value #>> '{}' as raw FROM settings WHERE key IN ('probe:mode', 'probe:blob')`,
    );
    for (const r of scalars.rows as Array<{ t: string; raw: unknown }>) {
      expect(r.t).toBe("string");
      expect(typeof r.raw).toBe("string");
    }

    // Completion marker recorded.
    const marker = await db.execute(
      sql`SELECT 1 as one FROM settings WHERE key = ${conn.__test.JSONB_REPAIR_MARKER_KEY}`,
    );
    expect(marker.rows.length).toBe(1);
  });
});

describe("repairDoubleEncodedJsonb — one-shot marker skips later boots", () => {
  let db: TestDb;

  beforeAll(async () => {
    const t = await setupTestDb();
    db = t.db;
    conn.__test.setState(t.db, t.pglite);
    await seedProject(db);
  });

  afterAll(async () => {
    conn.__test.setState(null, null);
    await closeTestDb();
    restoreModuleMocks();
  });

  test("a double-encoded row inserted AFTER the marker is left alone (scan skipped)", async () => {
    // First boot: nothing to repair, but the marker is written.
    await conn.__test.repairDoubleEncodedJsonb(sql);
    const marker = await db.execute(
      sql`SELECT 1 as one FROM settings WHERE key = ${conn.__test.JSONB_REPAIR_MARKER_KEY}`,
    );
    expect(marker.rows.length).toBe(1);

    // Now introduce a broken row (as if written by an old build) and re-run.
    const convId = crypto.randomUUID();
    await db.execute(sql`INSERT INTO conversations (id, project_id, title) VALUES (${convId}, 'rp', 'c')`);
    const msgId = crypto.randomUUID();
    const stringified = JSON.stringify({ inputTokens: 9, outputTokens: 9 });
    await db.execute(sql`
      INSERT INTO messages (id, conversation_id, role, content, usage)
      VALUES (${msgId}, ${convId}, 'assistant', 'probe', to_jsonb(${stringified}::text))
    `);

    await conn.__test.repairDoubleEncodedJsonb(sql);

    // Because the marker is present, the sweep is skipped — the row stays a
    // string scalar (proving we did NOT full-scan again).
    const after = await db.execute(sql`SELECT jsonb_typeof(usage) as t FROM messages WHERE id = ${msgId}`);
    expect((after.rows[0] as { t: string }).t).toBe("string");
  });
});

describe("repairDoubleEncodedJsonb — marker write is best-effort", () => {
  afterAll(() => {
    conn.__test.setState(null, null);
    restoreModuleMocks();
  });

  test("swallows a marker INSERT failure instead of throwing", async () => {
    let call = 0;
    const fakeDb = {
      execute: (_q: unknown) => {
        call++;
        if (call === 1) return Promise.resolve({ rows: [] }); // marker SELECT: absent
        if (call === 2) return Promise.resolve({ rows: [] }); // jsonb columns: none
        return Promise.reject(new Error("insert boom")); // marker INSERT fails
      },
    };
    conn.__test.setState(fakeDb, null);
    // Must not throw even though the marker write rejects.
    await conn.__test.repairDoubleEncodedJsonb(sql);
    expect(call).toBe(3);
  });
});

describe("applyBunSqlJsonbFix — real override, not a re-declared identity", () => {
  test("swaps PgJson/PgJsonb mapToDriverValue to identity", async () => {
    const jsonb = await import("drizzle-orm/pg-core/columns/jsonb");
    const json = await import("drizzle-orm/pg-core/columns/json");

    // Save + restore so this mutation of the shared drizzle prototypes cannot
    // leak into other suites.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origJsonb = (jsonb.PgJsonb.prototype as any).mapToDriverValue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origJson = (json.PgJson.prototype as any).mapToDriverValue;
    try {
      // Call the REAL production function.
      await conn.__test.applyBunSqlJsonbFix();

      const obj = { foo: "bar", n: 42 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((jsonb.PgJsonb.prototype as any).mapToDriverValue(obj)).toBe(obj);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((json.PgJson.prototype as any).mapToDriverValue(obj)).toBe(obj);
      // Critically NOT the JSON-stringified form drizzle's default emits.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((jsonb.PgJsonb.prototype as any).mapToDriverValue(obj)).not.toBe(JSON.stringify(obj));
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (jsonb.PgJsonb.prototype as any).mapToDriverValue = origJsonb;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (json.PgJson.prototype as any).mapToDriverValue = origJson;
    }
  });
});
