// Regression test for sec-L2: touchSession must bind throttleMs as a SQL
// parameter, not interpolate it into the SQL text via sql.raw(String(…)).
//
// Pre-fix (src/db/queries/sessions.ts@97-102):
//   lt(sessions.lastActiveAt,
//      sql`NOW() - INTERVAL '${sql.raw(String(throttleMs))} milliseconds'`)
// — the value is string-concatenated into the SQL text. Harmless today
// (throttleMs is a hardcoded number) but an instant SQLi sink if any caller
// ever forwards user-controlled input.
//
// Fix replaces the sql.raw interpolation with
//   `NOW() - make_interval(secs => ${throttleMs} / 1000.0)`
// — drizzle binds `throttleMs` as a positional parameter, so the compiled SQL
// text never contains the literal value.
//
// Strategy: run touchSession against a real in-memory PGlite DB (so the full
// drizzle query compiler runs), but monkey-patch pglite.query to capture the
// compiled SQL + params. Assert that the throttle value appears in the params
// array and NOT as a literal numeric token inside the SQL string.
//
// Tests fix(sec-L2): 28f6621

import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../db/schema";
import { migrate } from "../../db/migrate";
import { restoreModuleMocks } from "../helpers/mock-cleanup";

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let origQuery: any;
let calls: Array<{ sql: string; params: any[] }> = [];

// Mock the db connection BEFORE importing touchSession so the real query
// module picks up our instrumented pglite-backed db.
mock.module("../../db/connection", () => ({
  getDb: () => db,
  getPglite: () => pglite,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

// Handler import AFTER mock.
import { touchSession } from "../../db/queries/sessions";

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);

  // Capture every query pglite sees. Drizzle's pglite driver funnels all
  // non-execute queries through this method with positional params.
  origQuery = pglite.query.bind(pglite);
  (pglite as any).query = async (sql: string, params: any[] = [], ...rest: any[]) => {
    calls.push({ sql, params: params ?? [] });
    return origQuery(sql, params, ...rest);
  };
});

afterAll(async () => {
  if (pglite) {
    (pglite as any).query = origQuery;
    await pglite.close().catch(() => {});
  }
  restoreModuleMocks();
});

async function resetSessions() {
  await origQuery('DELETE FROM "sessions"', []);
  await origQuery('DELETE FROM "users"', []);
}

async function seedSessionForUser(lastActiveAt: Date): Promise<string> {
  const userId = "u-l2-" + crypto.randomUUID().slice(0, 8);
  const sessionId = "s-l2-" + crypto.randomUUID().slice(0, 8);
  await origQuery(
    `INSERT INTO "users" (id, email, password_hash, name, role, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [userId, `${userId}@test.local`, "h", "Test User", "member", "active"],
  );
  const expiresAt = new Date(Date.now() + 3600_000);
  await origQuery(
    `INSERT INTO "sessions" (id, user_id, token_hash, expires_at, last_active_at, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [sessionId, userId, `tokh-${sessionId}`, expiresAt.toISOString(), lastActiveAt.toISOString()],
  );
  return sessionId;
}

beforeEach(async () => {
  await resetSessions();
  calls = [];
});

describe("sec-L2: touchSession binds throttleMs as a parameter", () => {
  test("happy path — updates lastActiveAt when throttle window elapsed", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const id = await seedSessionForUser(tenMinutesAgo);
    calls = [];

    const result = await touchSession(id, 60_000);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(id);
    // Confirm the row's last_active_at actually advanced.
    expect(result!.lastActiveAt.getTime()).toBeGreaterThan(tenMinutesAgo.getTime());
  });

  test("throttle blocks update inside window (returns null)", async () => {
    const justNow = new Date(Date.now() - 1_000); // 1s ago
    const id = await seedSessionForUser(justNow);

    const result = await touchSession(id, 60_000);
    // Inside the 60s throttle → no row updated.
    expect(result).toBeNull();
  });

  test("throttleMs value is a bound parameter, not SQL literal", async () => {
    // Distinctive value that would never occur by coincidence in generated SQL.
    const distinctive = 3_601_001;
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const id = await seedSessionForUser(tenMinutesAgo);
    calls = [];

    await touchSession(id, distinctive);

    // Locate the UPDATE "sessions" query drizzle emitted.
    const updateCall = calls.find(c => /UPDATE\s+"?sessions"?/i.test(c.sql));
    expect(updateCall).toBeDefined();

    // The distinctive numeric value must NOT appear as a literal in the SQL text.
    // Pre-fix, sql.raw(String(throttleMs)) would put "3601001" directly in the text.
    expect(updateCall!.sql).not.toContain(String(distinctive));

    // It must appear in the bound params array instead.
    expect(updateCall!.params).toContain(distinctive);
  });

  test("multiple distinct throttleMs values are each bound, never interpolated", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const values = [987_654_321, 123_456_789];

    for (const v of values) {
      await resetSessions();
      const id = await seedSessionForUser(tenMinutesAgo);
      calls = [];

      await touchSession(id, v);

      const updateCall = calls.find(c => /UPDATE\s+"?sessions"?/i.test(c.sql));
      expect(updateCall).toBeDefined();
      expect(updateCall!.sql).not.toContain(String(v));
      expect(updateCall!.params).toContain(v);
    }
  });

  test("SQL text references throttle value via positional placeholder", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const id = await seedSessionForUser(tenMinutesAgo);
    calls = [];

    await touchSession(id, 42_424_242);

    const updateCall = calls.find(c => /UPDATE\s+"?sessions"?/i.test(c.sql));
    expect(updateCall).toBeDefined();
    // Post-fix uses make_interval(secs => $N / 1000.0). The pre-fix text was
    // `INTERVAL '<number> milliseconds'` with no positional placeholder for
    // the throttle value. Assert the shape that binds, not the one that
    // interpolates.
    expect(updateCall!.sql).toMatch(/make_interval/i);
    // And the pre-fix `INTERVAL '... milliseconds'` string must be gone.
    expect(updateCall!.sql).not.toMatch(/INTERVAL\s+'[^']*milliseconds/i);
  });
});
