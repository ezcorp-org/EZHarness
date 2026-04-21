import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
});

afterAll(async () => {
  await pglite.close().catch(() => {});
});

const EXPECTED_TABLES = [
  "projects",
  "settings",
  "runs",
  "run_logs",
  "agent_configs",
  "pipeline_definitions",
  "conversations",
  "messages",
  "memories",
  "memory_audit_log",
  "knowledge_base_files",
  "knowledge_base_chunks",
  "extensions",
  "tool_calls",
  "observability_events",
  "users",
  "invites",
  "teams",
  "team_members",
  "agent_shares",
  "audit_log",
  "marketplace_listings",
  "marketplace_versions",
  "marketplace_ratings",
  "marketplace_flags",
];

const EXPECTED_INDEXES = [
  "idx_runs_project_id",
  "idx_runs_agent_name",
  "idx_run_logs_run_id",
  "idx_conversations_project_id",
  "idx_messages_conversation_id",
  "idx_messages_parent",
  "idx_messages_fts",
  "idx_conversations_title_fts",
  "idx_memories_project_id",
  "idx_memories_category",
  "idx_memories_embedding_hnsw",
  "idx_memories_content_fts",
  "idx_memories_status",
  "idx_memories_last_accessed",
  "idx_kb_chunks_file_id",
  "idx_kb_chunks_embedding",
  "idx_tool_calls_extension",
  "idx_tool_calls_conversation",
  "idx_obs_events_conversation",
  "idx_obs_events_type",
  "idx_users_email",
  "idx_invites_token",
  "idx_conversations_user_id",
  "idx_memories_user_id",
  "idx_agent_configs_user_id",
  "idx_kb_files_user_id",
  "idx_team_members_team_id",
  "idx_team_members_user_id",
  "idx_team_members_team_user",
  "idx_agent_shares_agent_team",
  "idx_agent_shares_team_id",
  "idx_audit_log_action",
  "idx_audit_log_created_at",
  "idx_marketplace_listings_category",
  "idx_marketplace_listings_status",
  "idx_marketplace_listings_slug",
  "idx_marketplace_versions_listing",
  "idx_marketplace_ratings_listing",
  "idx_marketplace_flags_listing",
  "idx_marketplace_flags_status",
];

describe("migrate()", () => {
  test("runs without error on a fresh database", async () => {
    await migrate(db);
  });

  test("is idempotent — running twice does not error", async () => {
    await migrate(db);
  });

  test("creates all expected tables", async () => {
    const result = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const tableNames = result.rows.map((r: any) => r.table_name);
    for (const table of EXPECTED_TABLES) {
      expect(tableNames).toContain(table);
    }
  });

  test("creates all expected indexes", async () => {
    const result = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY indexname
    `);
    const indexNames = result.rows.map((r: any) => r.indexname);
    for (const index of EXPECTED_INDEXES) {
      expect(indexNames).toContain(index);
    }
  });

  test("seeds the global project", async () => {
    const result = await db.execute(sql`
      SELECT id, name, path FROM projects WHERE id = 'global'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      id: "global",
      name: "Global",
      path: "/",
    });
  });

  test("global project seed is idempotent", async () => {
    // Run migrate again and verify still only one global project
    await migrate(db);
    const result = await db.execute(sql`
      SELECT id FROM projects WHERE id = 'global'
    `);
    expect(result.rows).toHaveLength(1);
  });

  test("ALTER TABLE ADD COLUMN IF NOT EXISTS works on re-run", async () => {
    // Verify columns added by ALTER TABLE exist
    const result = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'conversations'
      ORDER BY column_name
    `);
    const columns = result.rows.map((r: any) => r.column_name);
    expect(columns).toContain("system_prompt");
    expect(columns).toContain("agent_config_id");
    expect(columns).toContain("test");
    expect(columns).toContain("user_id");

    // Verify memories lifecycle columns
    const memResult = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'memories'
      ORDER BY column_name
    `);
    const memColumns = memResult.rows.map((r: any) => r.column_name);
    expect(memColumns).toContain("status");
    expect(memColumns).toContain("last_accessed_at");
    expect(memColumns).toContain("user_id");

    // Verify agent_configs added columns
    const agentResult = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agent_configs'
      ORDER BY column_name
    `);
    const agentColumns = agentResult.rows.map((r: any) => r.column_name);
    expect(agentColumns).toContain("category");
    expect(agentColumns).toContain("extensions");
    expect(agentColumns).toContain("user_id");
  });
});
