import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

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
    pg = new PGlite({ extensions: { vector } });
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
    expect(names).toContain("pipeline_definitions");
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
    const { sql } = await import("drizzle-orm");

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
