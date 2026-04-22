/**
 * Migration coverage for the tool_calls analytics-dimension backfill.
 *
 * Locks in: for tool_calls rows that predate the user_id / agent_config_id /
 * model / provider columns (i.e. rows inserted before the migration added
 * them), re-running migrate() populates the four new columns from the row's
 * conversation + message join. Re-running is idempotent — non-null values
 * are preserved by the COALESCE, not overwritten.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, getTestDb, getTestPglite, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  users,
  projects,
  agentConfigs,
  extensions,
  conversations,
  messages,
  toolCalls,
} from "../db/schema";
import { migrate } from "../db/migrate";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("migrate(): tool_calls analytics backfill", () => {
  test("UPDATE … FROM conversations + messages populates nulled dimensions", async () => {
    const db = getTestDb();

    // ── Seed graph: user → project → agent → extension → conversation → message → tool_call
    const USER_ID = "u-backfill-1";
    const PROJECT_ID = "p-backfill-1";
    const AGENT_ID = "ag-backfill-1";
    const EXT_ID = "ext-backfill-1";
    const CONV_ID = "conv-backfill-1";
    const MSG_ID = "msg-backfill-1";
    const TC_ID = "tc-backfill-1";

    await db.insert(users).values({ id: USER_ID, email: "b@x.com", passwordHash: "x", name: "B", role: "member" } as any);
    await db.insert(projects).values({ id: PROJECT_ID, name: "b", path: "/tmp/b" } as any);
    await db.insert(agentConfigs).values({ id: AGENT_ID, name: "BA", prompt: "t", userId: USER_ID } as any);
    await db.insert(extensions).values({
      id: EXT_ID, name: "bx", version: "0.0.1", source: "local",
      manifest: {} as any, isBundled: false,
    } as any);
    await db.insert(conversations).values({
      id: CONV_ID, projectId: PROJECT_ID, userId: USER_ID, agentConfigId: AGENT_ID,
      model: "claude-opus-4-7", provider: "anthropic",
    } as any);
    await db.insert(messages).values({
      id: MSG_ID, conversationId: CONV_ID, role: "assistant",
      content: "", model: "claude-opus-4-7", provider: "anthropic",
    } as any);

    // Insert a tool_calls row with the new columns explicitly NULL, as if
    // it had been written before those columns existed.
    await db.insert(toolCalls).values({
      id: TC_ID,
      conversationId: CONV_ID,
      messageId: MSG_ID,
      extensionId: EXT_ID,
      toolName: "read_file",
      input: {},
      output: { content: [] },
      success: true,
      durationMs: 0,
      userId: null,
      agentConfigId: null,
      model: null,
      provider: null,
    } as any);

    // Re-run the idempotent migration — the backfill block at the tail of
    // migrate.ts runs every time and should populate the nulled row.
    await migrate(db);

    const { rows } = await getTestPglite().query<{
      user_id: string | null;
      agent_config_id: string | null;
      model: string | null;
      provider: string | null;
    }>(`SELECT user_id, agent_config_id, model, provider FROM tool_calls WHERE id = $1`, [TC_ID]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(USER_ID);
    expect(rows[0]!.agent_config_id).toBe(AGENT_ID);
    expect(rows[0]!.model).toBe("claude-opus-4-7");
    expect(rows[0]!.provider).toBe("anthropic");
  });

  test("re-running migrate does not overwrite non-null dimensions (idempotent via COALESCE)", async () => {
    const db = getTestDb();

    // Seed a second disjoint graph whose conversation has a *different*
    // model than the tool_calls row already carries. If the backfill used
    // plain assignment instead of COALESCE it would stomp the row's value.
    const USER_ID = "u-backfill-2";
    const PROJECT_ID = "p-backfill-2";
    const EXT_ID = "ext-backfill-2";
    const CONV_ID = "conv-backfill-2";
    const TC_ID = "tc-backfill-2";

    await db.insert(users).values({ id: USER_ID, email: "c@x.com", passwordHash: "x", name: "C", role: "member" } as any);
    await db.insert(projects).values({ id: PROJECT_ID, name: "c", path: "/tmp/c" } as any);
    await db.insert(extensions).values({
      id: EXT_ID, name: "cx", version: "0.0.1", source: "local",
      manifest: {} as any, isBundled: false,
    } as any);
    await db.insert(conversations).values({
      id: CONV_ID, projectId: PROJECT_ID, userId: USER_ID,
      model: "claude-sonnet-4-6", provider: "anthropic",
    } as any);
    await db.insert(toolCalls).values({
      id: TC_ID,
      conversationId: CONV_ID,
      messageId: null,
      extensionId: EXT_ID,
      toolName: "search",
      input: {},
      output: { content: [] },
      success: true,
      durationMs: 0,
      // Pre-existing non-null values — must survive the backfill.
      userId: USER_ID,
      agentConfigId: null,
      model: "claude-opus-4-7",
      provider: "anthropic",
    } as any);

    await migrate(db);

    const { rows } = await getTestPglite().query<{ model: string | null; user_id: string | null }>(
      `SELECT model, user_id FROM tool_calls WHERE id = $1`, [TC_ID],
    );
    expect(rows[0]!.model).toBe("claude-opus-4-7"); // NOT "claude-sonnet-4-6"
    expect(rows[0]!.user_id).toBe(USER_ID);
  });

  test("new indexes exist on the denormalized dimensions", async () => {
    const pg = getTestPglite();
    const { rows } = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'tool_calls'`,
    );
    const names = new Set(rows.map((r) => r.indexname));
    expect(names.has("idx_tool_calls_tool_created")).toBe(true);
    expect(names.has("idx_tool_calls_user_created")).toBe(true);
    expect(names.has("idx_tool_calls_agent_created")).toBe(true);
    expect(names.has("idx_tool_calls_model_created")).toBe(true);
  });

  test("new columns are nullable (pre-migration tool_calls writers stay valid)", async () => {
    const pg = getTestPglite();
    const { rows } = await pg.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'tool_calls'
         AND column_name IN ('user_id','agent_config_id','model','provider')`,
    );
    const map = new Map(rows.map((r) => [r.column_name, r.is_nullable]));
    expect(map.get("user_id")).toBe("YES");
    expect(map.get("agent_config_id")).toBe("YES");
    expect(map.get("model")).toBe("YES");
    expect(map.get("provider")).toBe("YES");
  });

  test("sql tag import works — guards against accidentally removing the drizzle SQL import", () => {
    // cheap compile-time / runtime smoke for the `sql` import this file
    // relies on; also makes this test file's module-level imports all
    // load-ok under the coverage gate.
    expect(typeof sql).toBe("function");
  });
});
