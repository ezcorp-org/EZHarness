/**
 * Integration test: getSubConversationToolCalls.
 *
 * Exercises the real DB query against a PGlite-backed test database so we
 * verify the SQL selects only direct sub-conversations of the given parent
 * and returns one `ToolCallSummary` bucket per sub. This is the server-side
 * half of the fix for sub-agent edits not showing in the parent's Diff
 * Summary panel.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

// Re-establish real settings (some sibling test files mock it globally).
mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting() {},
    async deleteSetting() { return false; },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();

// Imports AFTER mocks.
import {
  createConversation,
  createSubConversation,
  getSubConversationToolCalls,
} from "../db/queries/conversations";
import { createProject } from "../db/queries/projects";
import { toolCalls, extensions } from "../db/schema";

let projectId: string;
let extensionId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Test Project", path: "/tmp/test" });
  projectId = project.id;
  // Seed (or reuse) an extension row — tool_calls.extensionId is a FK.
  // Migrations may already seed a "builtin" extension, so select-or-insert.
  const existing = await getTestDb().select().from(extensions).limit(1);
  if (existing.length > 0) {
    extensionId = existing[0]!.id;
  } else {
    const inserted = await getTestDb()
      .insert(extensions)
      .values({
        id: `ext-test-${crypto.randomUUID().slice(0, 8)}`,
        name: `test-ext-${crypto.randomUUID().slice(0, 8)}`,
        version: "0.0.0",
        description: "test extension",
        manifest: { name: "test", version: "0.0.0" } as any,
        source: "test",
        installPath: "/",
      })
      .returning({ id: extensions.id });
    extensionId = inserted[0]!.id;
  }
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

/** Insert a tool call directly against the test DB. */
async function insertToolCall(opts: {
  conversationId: string;
  messageId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  success?: boolean;
  durationMs?: number;
  cardType?: string | null;
}): Promise<string> {
  const row = await getTestDb()
    .insert(toolCalls)
    .values({
      conversationId: opts.conversationId,
      messageId: opts.messageId ?? null,
      extensionId,
      toolName: opts.toolName ?? "edit_file",
      input: opts.input ?? { file_path: "x.ts" },
      output: opts.output ?? { content: [{ type: "text", text: "ok" }] },
      success: opts.success ?? true,
      durationMs: opts.durationMs ?? 10,
      cardType: opts.cardType ?? null,
    })
    .returning({ id: toolCalls.id });
  return row[0]!.id;
}

describe("getSubConversationToolCalls", () => {
  let parentConvId: string;

  beforeEach(async () => {
    // Fresh parent per test so sub fixtures don't leak across tests.
    const parent = await createConversation(projectId);
    parentConvId = parent.id;
  });

  test("returns {} when the parent has no sub-conversations", async () => {
    const result = await getSubConversationToolCalls(parentConvId);
    expect(result).toEqual({});
  });

  test("returns an empty bucket for a sub-conversation that has no tool calls yet", async () => {
    const sub = await createSubConversation(projectId, { parentConversationId: parentConvId });
    const result = await getSubConversationToolCalls(parentConvId);
    expect(Object.keys(result)).toEqual([sub.id]);
    expect(result[sub.id]).toEqual([]);
  });

  test("returns all tool calls for one sub, in created_at order", async () => {
    const sub = await createSubConversation(projectId, { parentConversationId: parentConvId });
    const firstId = await insertToolCall({ conversationId: sub.id, toolName: "edit_file" });
    // Small delay so the second row has a distinct created_at (PGlite granularity is OK for sequential inserts).
    await new Promise((r) => setTimeout(r, 5));
    const secondId = await insertToolCall({ conversationId: sub.id, toolName: "write" });

    const result = await getSubConversationToolCalls(parentConvId);
    expect(result[sub.id]).toHaveLength(2);
    expect(result[sub.id]!.map((c) => c.id)).toEqual([firstId, secondId]);
    expect(result[sub.id]!.map((c) => c.toolName)).toEqual(["edit_file", "write"]);
  });

  test("returns tool calls grouped by sub-conversation id when there are multiple subs", async () => {
    const subA = await createSubConversation(projectId, { parentConversationId: parentConvId });
    const subB = await createSubConversation(projectId, { parentConversationId: parentConvId });
    await insertToolCall({ conversationId: subA.id, toolName: "edit_file" });
    await insertToolCall({ conversationId: subB.id, toolName: "edit_file" });
    await insertToolCall({ conversationId: subB.id, toolName: "write" });

    const result = await getSubConversationToolCalls(parentConvId);
    expect(Object.keys(result).sort()).toEqual([subA.id, subB.id].sort());
    expect(result[subA.id]).toHaveLength(1);
    expect(result[subB.id]).toHaveLength(2);
  });

  test("does not include tool calls from unrelated conversations", async () => {
    // Another parent + its own sub with a tool call — must not leak into the query.
    const otherParent = await createConversation(projectId);
    const otherSub = await createSubConversation(projectId, { parentConversationId: otherParent.id });
    await insertToolCall({ conversationId: otherSub.id, toolName: "edit_file" });

    // The parent under test also has a sub with a tool call.
    const mySub = await createSubConversation(projectId, { parentConversationId: parentConvId });
    await insertToolCall({ conversationId: mySub.id, toolName: "edit_file" });

    const result = await getSubConversationToolCalls(parentConvId);
    expect(Object.keys(result)).toEqual([mySub.id]);
    expect(result[otherSub.id]).toBeUndefined();
  });

  test("does not include tool calls from the PARENT conversation itself", async () => {
    const sub = await createSubConversation(projectId, { parentConversationId: parentConvId });
    // Insert a parent-level tool call — should NOT be returned.
    await insertToolCall({ conversationId: parentConvId, toolName: "edit_file" });
    // And one on the sub — should be returned.
    const subCallId = await insertToolCall({ conversationId: sub.id, toolName: "edit_file" });

    const result = await getSubConversationToolCalls(parentConvId);
    expect(result[sub.id]).toHaveLength(1);
    expect(result[sub.id]![0]!.id).toBe(subCallId);
  });

  test("maps row fields to the ToolCallSummary shape: status, fullOutput when cardType set, createdAt", async () => {
    const sub = await createSubConversation(projectId, { parentConversationId: parentConvId });
    await insertToolCall({
      conversationId: sub.id,
      toolName: "edit_file",
      cardType: "diff",
      output: { content: [{ type: "text", text: "diff output here" }] },
      success: true,
      durationMs: 42,
    });

    const result = await getSubConversationToolCalls(parentConvId);
    const call = result[sub.id]![0]!;
    expect(call.status).toBe("success");
    expect(call.cardType).toBe("diff");
    expect(call.fullOutput).toBe("diff output here"); // extracted from content[].text
    expect(call.durationMs).toBe(42);
    expect(call.createdAt).toBeInstanceOf(Date);
  });

  test("interrupted tool calls (success=false with no output) map to status='error'", async () => {
    // The SQL schema requires `success` to be non-null, so a true "interrupted"
    // row (success=null) can't be written in this integration test. We cover
    // the success=false path here; the success=null interrupted case is
    // exercised by helper-level unit tests.
    const sub = await createSubConversation(projectId, { parentConversationId: parentConvId });
    await insertToolCall({
      conversationId: sub.id,
      toolName: "edit_file",
      success: false,
      output: null,
    });
    const result = await getSubConversationToolCalls(parentConvId);
    expect(result[sub.id]![0]!.status).toBe("error");
  });
});
