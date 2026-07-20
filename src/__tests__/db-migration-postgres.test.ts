import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { isUniqueViolation } from "../db/session-backfill";

/**
 * Migration tests for external Postgres mode (PGDB-04).
 *
 * Uses PGlite as a Postgres-compatible backend to verify that the migration
 * SQL runs correctly on a Postgres-compatible engine. This exercises the same
 * migrate() code path that external Postgres would use.
 */
describe("migration on Postgres-compatible backend", () => {
  let pg: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    pg = new PGlite({ extensions: { vector, pg_trgm } });
    await pg.waitReady;
    db = drizzle(pg, { schema });
    await migrate(db);
  });

  afterAll(async () => {
    await pg.close();
  });

  test("pgvector extension is created", async () => {
    const result = await pg.query(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'"
    );
    expect(result.rows.length).toBe(1);
    expect((result.rows[0] as any).extname).toBe("vector");
  });

  test("all expected tables are created", async () => {
    const result = await pg.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    const names = result.rows.map((r: any) => r.table_name);

    // Core tables
    expect(names).toContain("projects");
    expect(names).toContain("settings");
    expect(names).toContain("runs");
    expect(names).toContain("run_logs");
    expect(names).toContain("agent_configs");
    expect(names).toContain("workflow_definitions");
    expect(names).toContain("conversations");
    expect(names).toContain("messages");

    // Memory tables
    expect(names).toContain("memories");
    expect(names).toContain("memory_audit_log");

    // Knowledge base
    expect(names).toContain("knowledge_base_files");
    expect(names).toContain("knowledge_base_chunks");

    // Extensions & tools
    expect(names).toContain("extensions");
    expect(names).toContain("tool_calls");
    expect(names).toContain("conversation_extensions");

    // Auth & users
    expect(names).toContain("users");
    expect(names).toContain("invites");
    expect(names).toContain("password_reset_tokens");
    expect(names).toContain("sessions");

    // Teams & sharing
    expect(names).toContain("teams");
    expect(names).toContain("team_members");
    expect(names).toContain("agent_shares");

    // Marketplace
    expect(names).toContain("marketplace_listings");
    expect(names).toContain("marketplace_versions");
    expect(names).toContain("marketplace_ratings");
    expect(names).toContain("marketplace_flags");

    // Observability & audit
    expect(names).toContain("observability_events");
    expect(names).toContain("audit_log");
    expect(names).toContain("active_runs");
    expect(names).toContain("error_logs");
  });

  test("analytics performance indexes are created", async () => {
    const result = await pg.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname"
    );
    const indexNames = result.rows.map((r: any) => r.indexname);

    // Phase 44 analytics indexes
    expect(indexNames).toContain("idx_audit_log_user_id");
    expect(indexNames).toContain("idx_messages_created_at");
    expect(indexNames).toContain("idx_conversations_created_at");
    expect(indexNames).toContain("idx_conversations_project_id_created");
  });

  test("migration is idempotent (running twice does not error)", async () => {
    // Second run should complete without errors
    await migrate(db);
    // Third run for good measure
    await migrate(db);

    // Tables still exist
    const result = await pg.query(
      "SELECT count(*) as cnt FROM information_schema.tables WHERE table_schema = 'public'"
    );
    expect(Number((result.rows[0] as any).cnt)).toBeGreaterThan(20);
  });

  test("migration idempotency preserves analytics indexes", async () => {
    // Run migrate again
    await migrate(db);

    // All 4 analytics indexes must still exist after re-run
    const result = await pg.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_%' ORDER BY indexname"
    );
    const indexNames = result.rows.map((r: any) => r.indexname);

    const analyticsIndexes = [
      "idx_audit_log_user_id",
      "idx_messages_created_at",
      "idx_conversations_created_at",
      "idx_conversations_project_id_created",
    ];
    for (const idx of analyticsIndexes) {
      expect(indexNames).toContain(idx);
    }
  });

  test("schema objects are queryable after migration", async () => {
    // Verify we can query each core table without errors
    const tables = [
      "projects", "settings", "runs", "conversations", "messages",
      "memories", "extensions", "users", "sessions",
    ];

    for (const table of tables) {
      const result = await pg.query(`SELECT count(*) as cnt FROM ${table}`);
      expect(Number((result.rows[0] as any).cnt)).toBeGreaterThanOrEqual(0);
    }

    // Verify vector column exists on memories table
    const colResult = await pg.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'embedding'"
    );
    expect(colResult.rows.length).toBe(1);
    expect((colResult.rows[0] as any).data_type).toBe("USER-DEFINED"); // vector type
  });
});

// ── Real external Postgres (Bun.sql) ─────────────────────────────────
//
// The PGlite suite above proves the migrate() SQL is Postgres-compatible, but
// it never exercises the driver-specific code in connection.ts's initPostgres()
// — the jsonb mapToDriverValue identity patch, the execute() array→{rows}
// wrapper, the pg_advisory_lock migrate guard, repairDoubleEncodedJsonb, the
// pool close, and the real Bun.sql $client.unsafe / 23505 error shape. Those
// only run against a real Postgres server, so this suite is GATED on
// DATABASE_URL and runs in the dedicated `db-postgres` CI job (postgres:15 +
// pgvector). connection.ts captures DATABASE_URL at module load, so the whole
// test process must have it set (the CI job does); locally it's skipped.
const PG_URL = process.env.DATABASE_URL;

describe.skipIf(!PG_URL)("external Postgres via Bun.sql (real server)", () => {
  let conn: typeof import("../db/connection");

  beforeAll(async () => {
    restoreModuleMocks();
    conn = await import("../db/connection");
    // Runs the full initPostgres() path: applyBunSqlJsonbFix → pool → CREATE
    // EXTENSION vector → advisory-locked migrate() → repairDoubleEncodedJsonb.
    await conn.initDb();
  });

  afterAll(async () => {
    if (conn) await conn.closeDb();
    restoreModuleMocks();
  });

  test("initDb selected external mode (PGlite handle is null)", () => {
    expect(conn.getPglite()).toBeNull();
    expect(conn.getDbPath()).toBe("external");
  });

  test("migrate() built the schema on the real server", async () => {
    const { rows } = await conn.rawQuery(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = (rows as Array<{ table_name: string }>).map((r) => r.table_name);
    expect(names).toContain("settings");
    expect(names).toContain("messages");
    expect(names).toContain("memories");
  });

  test("migrate() is idempotent under the advisory lock (second run is clean)", async () => {
    // withPostgresMigrateLock wraps migrate; a second full run must not throw
    // (DROP/CREATE TRIGGER, DROP/ADD CONSTRAINT pairs are re-applied cleanly).
    await conn.__test.withPostgresMigrateLock(() => migrate(conn.getDb()));
    const { rows } = await conn.rawQuery("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
    expect((rows[0] as { n: number }).n).toBeGreaterThan(20);
  });

  test("execute() wrapper normalizes bun-sql arrays to { rows }", async () => {
    const res = await conn.getDb().execute(sql`SELECT 1 AS one`);
    expect(Array.isArray(res)).toBe(false);
    expect((res.rows[0] as { one: number }).one).toBe(1);
  });

  test("jsonb column round-trips as an object (mapToDriverValue identity fix)", async () => {
    await conn.getDb()
      .insert(schema.settings)
      .values({ key: "pg-jsonb-probe", value: { hello: "world", n: 7 } })
      .onConflictDoNothing();
    const { rows } = await conn.rawQuery(
      "SELECT jsonb_typeof(value) AS t, value->>'hello' AS hello FROM settings WHERE key = $1",
      ["pg-jsonb-probe"],
    );
    // Without the identity override this would be a string scalar.
    expect((rows[0] as { t: string }).t).toBe("object");
    expect((rows[0] as { hello: string }).hello).toBe("world");
  });

  test("repairDoubleEncodedJsonb runs and records its one-shot marker", async () => {
    await conn.__test.repairDoubleEncodedJsonb(sql);
    const { rows } = await conn.rawQuery("SELECT 1 AS one FROM settings WHERE key = $1", [
      conn.__test.JSONB_REPAIR_MARKER_KEY,
    ]);
    expect(rows.length).toBe(1);
  });

  test("rawQuery binds params through the real $client.unsafe", async () => {
    const { rows } = await conn.rawQuery("SELECT $1::int + 1 AS n", ["41"]);
    expect((rows[0] as { n: number }).n).toBe(42);
    // Injection payload stays data.
    const probe = await conn.rawQuery("SELECT $1::text AS v", ["x'; DROP TABLE settings;--"]);
    expect((probe.rows[0] as { v: string }).v).toBe("x'; DROP TABLE settings;--");
  });

  test("a real 23505 unique-violation is recognized by isUniqueViolation", async () => {
    await conn.getDb().insert(schema.settings).values({ key: "dup-23505", value: { a: 1 } }).onConflictDoNothing();
    let caught: unknown;
    try {
      // No onConflict → the second insert of the same PK raises 23505.
      await conn.getDb().insert(schema.settings).values({ key: "dup-23505", value: { a: 2 } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);
  });
});
