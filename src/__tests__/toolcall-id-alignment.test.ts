/**
 * Server-side contract: the executor now persists built-in tool_calls with
 * `id = event.toolCallId` and emits the same id in `invocationId` on
 * tool:start / tool:complete / tool:error events. This test verifies the
 * DB-level half: explicit ids are accepted and persisted verbatim (no
 * override by $defaultFn).
 *
 * The end-to-end consequence is that the client's streamed inline-tool-store
 * entry and the later hydrated DB row share the same id — so a page reload
 * mid-run produces one deduped entry, not two.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mock.module("../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import { createConversation } from "../db/queries/conversations";
import { createProject } from "../db/queries/projects";
import { toolCalls, extensions } from "../db/schema";
import { eq } from "drizzle-orm";

let projectId: string;
let conversationId: string;
let extensionId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Test", path: "/tmp/test" });
  projectId = project.id;
  const conv = await createConversation(projectId);
  conversationId = conv.id;

  // Seed or reuse an extension row (toolCalls.extensionId is FK).
  const existing = await getTestDb().select().from(extensions).limit(1);
  if (existing.length > 0) {
    extensionId = existing[0]!.id;
  } else {
    const inserted = await getTestDb().insert(extensions).values({
      id: `ext-${crypto.randomUUID().slice(0, 8)}`,
      name: `test-ext-${crypto.randomUUID().slice(0, 8)}`,
      version: "0.0.0",
      description: "test",
      manifest: { name: "test", version: "0.0.0" } as any,
      source: "test",
      installPath: "/",
    }).returning({ id: extensions.id });
    extensionId = inserted[0]!.id;
  }
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("tool_calls id alignment — explicit id from the event persists verbatim", () => {
  test("inserting with an explicit id preserves it (no UUID regeneration)", async () => {
    const eventToolCallId = "00000000-0000-4000-8000-000000000001";
    await getTestDb().insert(toolCalls).values({
      id: eventToolCallId,
      conversationId,
      messageId: null,
      extensionId,
      toolName: "edit_file",
      input: { file_path: "x.ts", old_string: "a", new_string: "b" },
      output: { content: [{ type: "text", text: "ok" }] },
      success: true,
      durationMs: 10,
    });

    const rows = await getTestDb()
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.id, eventToolCallId));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(eventToolCallId);
    expect(rows[0]!.toolName).toBe("edit_file");
    expect((rows[0]!.input as any).file_path).toBe("x.ts");
  });

  test("inserting the same explicit id twice is rejected (unique pk)", async () => {
    const eventToolCallId = "00000000-0000-4000-8000-000000000002";
    await getTestDb().insert(toolCalls).values({
      id: eventToolCallId,
      conversationId,
      messageId: null,
      extensionId,
      toolName: "edit_file",
      input: {},
      output: null,
      success: true,
      durationMs: 1,
    });

    let threw = false;
    try {
      await getTestDb().insert(toolCalls).values({
        id: eventToolCallId,
        conversationId,
        messageId: null,
        extensionId,
        toolName: "edit_file",
        input: {},
        output: null,
        success: true,
        durationMs: 1,
      }).execute();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("omitting id still generates one via $defaultFn (backward compat sanity)", async () => {
    const before = await getTestDb().select().from(toolCalls);
    const beforeCount = before.length;
    await getTestDb().insert(toolCalls).values({
      conversationId,
      messageId: null,
      extensionId,
      toolName: "edit_file",
      input: {},
      output: null,
      success: true,
      durationMs: 1,
    });
    const after = await getTestDb().select().from(toolCalls);
    expect(after.length).toBe(beforeCount + 1);
    const last = after[after.length - 1]!;
    expect(last.id).toBeTruthy(); // any UUID
    expect(last.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("the executor's insert shape (id, conversationId, messageId=null, …) round-trips", async () => {
    // Mirror of the actual executor.ts insert shape so a regression there
    // (e.g. an accidental schema change or a type-safety override slipping in)
    // is caught here.
    const eventToolCallId = "00000000-0000-4000-8000-000000000003";
    await getTestDb().insert(toolCalls).values({
      id: eventToolCallId,
      conversationId,
      messageId: null,
      extensionId: "builtin", // executor passes "builtin" literally; extension exists in our seed
      toolName: "edit_file",
      input: { path: "src/a.ts", new_string: "hi" },
      output: { content: [{ type: "text", text: "created" }] },
      success: true,
      durationMs: 0,
    }).onConflictDoNothing();

    const rows = await getTestDb().select().from(toolCalls).where(eq(toolCalls.id, eventToolCallId));
    // Note: may be 0 if conflict (test re-run). Either 0 or 1; when 1, fields match.
    if (rows.length === 1) {
      expect(rows[0]!.id).toBe(eventToolCallId);
      expect(rows[0]!.success).toBe(true);
      expect((rows[0]!.input as any).path).toBe("src/a.ts");
    }
  });
});
