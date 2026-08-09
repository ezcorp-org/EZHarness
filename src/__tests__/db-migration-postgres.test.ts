import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { isUniqueViolation } from "../db/unique-violation";

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

  test("observability_events.conversation_id is NULLABLE", async () => {
    // A tool call made inside a WORKFLOW has no conversation — it runs
    // under the synthetic `workflow-run:<id>` scope key, which matches no
    // `conversations` row. While this column was NOT NULL the FK rejected
    // every such insert and the call was recorded nowhere; the collector
    // just logged `Failed to persist tool:complete` once per call.
    //
    // Asserted against the LIVE migrated schema (same shape as the
    // `workflow_definitions.user_id` check below).
    //
    // SCOPE, precisely: this pins the END STATE on a FRESH database, and
    // that is all it can pin. `migrate()` both creates the table without
    // `NOT NULL` and runs an idempotent `ALTER … DROP NOT NULL`, so here
    // either mechanism alone would satisfy it — a mutation removing just
    // one survives this test, correctly. The UPGRADE path (a database
    // created before the change, i.e. every existing install) is pinned
    // separately by the "migration upgrades a pre-existing
    // observability_events" describe at the bottom of this file.
    const col = await pg.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'observability_events' AND column_name = 'conversation_id'",
    );
    expect(col.rows.length).toBe(1);
    expect((col.rows[0] as { is_nullable: string }).is_nullable).toBe("YES");
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

  test("workflow_definitions.user_id exists, is nullable, and FKs to users", async () => {
    // The ALTER lives near the END of migrate() on purpose: the table is
    // created long before `users`, so an inline FK there would have no
    // target. Assert both the column and the constraint so a regression
    // that moves it back is caught here rather than at install time.
    const col = await pg.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'workflow_definitions' AND column_name = 'user_id'",
    );
    expect(col.rows.length).toBe(1);
    expect((col.rows[0] as any).is_nullable).toBe("YES");

    const fk = await pg.query(`
      SELECT ccu.table_name AS referenced, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'workflow_definitions'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND kcu.column_name = 'user_id'
    `);
    expect(fk.rows.length).toBe(1);
    expect((fk.rows[0] as any).referenced).toBe("users");
    // SET NULL, not CASCADE: deleting a user must never destroy workflows.
    // The orphaned row degrades to admin-only, which is what the ladder
    // reads a NULL owner on a `private` row as.
    expect((fk.rows[0] as any).delete_rule).toBe("SET NULL");
  });

  test("the superseded created_by column is not present", async () => {
    // A second authorization model briefly added it. It disagreed with
    // `user_id`/`visibility` about what a NULL owner means, so it was
    // dropped rather than carried.
    const col = await pg.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'workflow_definitions' AND column_name = 'created_by'",
    );
    expect(col.rows.length).toBe(0);
  });

  test("the ownership migration does not backfill existing rows", async () => {
    // NULL owner + `system` is what keeps every pre-existing workflow
    // runnable by anyone. A first-admin backfill would silently lock them
    // all to one user.
    await pg.query(
      "INSERT INTO workflow_definitions (id, name, description, steps) VALUES ('wf-legacy', 'legacy-wf', '', '[]'::jsonb)",
    );
    await migrate(db);
    const rows = await pg.query(
      "SELECT user_id, visibility FROM workflow_definitions WHERE id = 'wf-legacy'",
    );
    expect((rows.rows[0] as any).user_id).toBeNull();
    expect((rows.rows[0] as any).visibility).toBe("system");
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
    // 60s, not bun's 5s default. This hook migrates a REAL Postgres service
    // container from empty: CREATE EXTENSION vector, every table + index, an
    // advisory-locked migrate(), then the jsonb repair pass. That routinely
    // lands near 5s on a loaded CI runner, so the default budget made this a
    // latent flake that failed as an "(unnamed)" 5000.13ms test — the hook
    // timing out, not an assertion. Observed failing twice in a row on one PR
    // while passing on another with an unrelated diff. Generous enough to
    // absorb runner jitter, still tight enough to catch a genuine hang.
  }, 60_000);

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

/**
 * The UPGRADE path for `observability_events.conversation_id`.
 *
 * The describe above proves the END STATE on a fresh database, and that
 * is genuinely all it can prove: `migrate()` both creates the table
 * without `NOT NULL` and runs an idempotent `ALTER … DROP NOT NULL`, so
 * on a fresh DB either mechanism alone produces a nullable column. A
 * mutation that removed the ALTER survived that test — correctly, because
 * on a fresh DB the ALTER is redundant.
 *
 * It is NOT redundant for a database created BEFORE the change, which is
 * every existing install. This drives exactly that: stand up the LEGACY
 * shape (`conversation_id TEXT NOT NULL`), run the real `migrate()`, and
 * assert the column came out nullable. Without the ALTER this fails, and
 * every upgraded install would keep silently rejecting workflow tool
 * calls on the FK.
 */
describe("migration upgrades a pre-existing observability_events", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite({ extensions: { vector, pg_trgm } });
    await pg.waitReady;
    // The legacy shape, as it stood before the change. No FK — the point
    // is the NOT NULL, and `conversations` does not exist yet at this
    // point in a hand-built fixture.
    await pg.query(`
      CREATE TABLE observability_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT,
        event_type TEXT NOT NULL,
        data JSONB NOT NULL,
        duration_ms INTEGER,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    const before = await pg.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'observability_events' AND column_name = 'conversation_id'",
    );
    // Guard the fixture itself: if this ever came out 'YES' the test below
    // would pass without the migration having done anything.
    if ((before.rows[0] as { is_nullable: string }).is_nullable !== "NO") {
      throw new Error("fixture did not create a NOT NULL column");
    }
    await migrate(drizzle(pg, { schema }));
  });

  afterAll(async () => {
    await pg.close();
  });

  test("DROP NOT NULL is applied to the existing column", async () => {
    const col = await pg.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'observability_events' AND column_name = 'conversation_id'",
    );
    expect(col.rows.length).toBe(1);
    expect((col.rows[0] as { is_nullable: string }).is_nullable).toBe("YES");
  });

  test("the upgraded column actually accepts a NULL row", async () => {
    // `is_nullable` is the catalog's opinion; this is the behaviour that
    // matters — the insert the FK used to reject.
    await pg.query(
      "INSERT INTO observability_events (id, conversation_id, event_type, data) VALUES ('obs-1', NULL, 'tool_call', '{\"workflowRunId\":\"r1\"}'::jsonb)",
    );
    const row = await pg.query(
      "SELECT conversation_id, data->>'workflowRunId' AS run FROM observability_events WHERE id = 'obs-1'",
    );
    expect(row.rows.length).toBe(1);
    expect((row.rows[0] as { conversation_id: string | null }).conversation_id).toBeNull();
    expect((row.rows[0] as { run: string }).run).toBe("r1");
  });
});
