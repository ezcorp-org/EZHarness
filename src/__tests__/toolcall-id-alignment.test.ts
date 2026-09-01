/**
 * tool-call-persist-losses defect 2: `tool_calls.id` used to be a
 * conversation-UNSCOPED primary key set VERBATIM from the built-in path's
 * `event.toolCallId` — the LLM provider's own wire id. The mock LLM defaults
 * an unset id to positional `call_0`, and plenty of real OpenAI-compatible
 * local servers do the same, so two DIFFERENT conversations whose provider
 * reused an id collided on the PK: the second `INSERT` was silently dropped
 * by `persistToolCall`'s never-throw contract, and that tool call's card
 * never existed after a reload.
 *
 * The fix: `id` is ALWAYS the DB-generated surrogate (never provider input);
 * the wire id now lives in the separate, non-unique `provider_tool_call_id`
 * column, which `toolCallRowToSummary` reads back (falling back to `id`) so
 * the client-visible id a reload hydrates is still the same one the live
 * SSE stream used — see the docs on `toolCalls.id` / `providerToolCallId`
 * in schema.ts and on `ToolCallRow` in `db/queries/tool-calls.ts`.
 *
 * This file exercises the REAL write site (`persistToolCall`) and the REAL
 * read site (`getMessagesWithToolCalls`) against a real PGlite — no
 * raw-schema shortcuts — so it pins the actual application contract rather
 * than a hand-rolled approximation of it.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mock.module("../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import { createConversation, createMessage, getMessagesWithToolCalls } from "../db/queries/conversations";
import { createProject } from "../db/queries/projects";
import { persistToolCall, getToolCallConversationById } from "../db/queries/tool-calls";
import { countErrors } from "../db/queries/error-logs";
import { toolCalls, extensions } from "../db/schema";
import { eq } from "drizzle-orm";

let projectId: string;
let extensionId: string;

async function seedConversationWithMessage(): Promise<string> {
  const conv = await createConversation(projectId);
  // getMessagesWithToolCalls short-circuits to empty on zero messages, and
  // the built-in write path always inserts with messageId: null (anchored
  // later at turn_end) — so a lone message plus an orphaned tool call is
  // exactly the shape a real in-flight turn produces.
  await createMessage(conv.id, { role: "user", content: "hi" });
  return conv.id;
}

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Test", path: "/tmp/test" });
  projectId = project.id;

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

function builtinRow(conversationId: string, wireId: string) {
  // Mirrors subscribe-bridge.ts's builtin tool_execution_end insert shape:
  // extensionId "builtin" literally, messageId null (anchored at turn_end),
  // providerToolCallId carrying the provider's own wire id.
  return {
    providerToolCallId: wireId,
    conversationId,
    messageId: null,
    extensionId: "builtin",
    toolName: "edit_file",
    input: { file_path: "x.ts" },
    output: { content: [{ type: "text", text: "ok" }] },
    success: true,
    durationMs: 10,
  };
}

describe("tool_calls.id is a host-generated surrogate, never the provider wire id", () => {
  test("persistToolCall never sets `id` from the row — it's always the $defaultFn UUID", async () => {
    const conversationId = await seedConversationWithMessage();
    await persistToolCall(builtinRow(conversationId, "call_0"));

    const rows = await getTestDb()
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.conversationId, conversationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(rows[0]!.id).not.toBe("call_0");
    expect(rows[0]!.providerToolCallId).toBe("call_0");
  });

  test("an explicit HOST-MINTED id (append-message-handler's use case) still persists verbatim", async () => {
    const conversationId = await seedConversationWithMessage();
    const mintedId = crypto.randomUUID();
    await persistToolCall({
      id: mintedId,
      conversationId,
      messageId: null,
      extensionId,
      toolName: "task_create",
      input: {},
      output: { content: [] },
      success: true,
      durationMs: 1,
    });

    const rows = await getTestDb().select().from(toolCalls).where(eq(toolCalls.id, mintedId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerToolCallId).toBeNull();
  });
});

describe("two conversations reusing the SAME provider wire id both persist and both render", () => {
  test("no PK collision, no dropped row, no error_logs entry, and both hydrate with the same client-visible id", async () => {
    const convA = await seedConversationWithMessage();
    const convB = await seedConversationWithMessage();
    expect(convA).not.toBe(convB);

    const errorsBefore = await countErrors();

    // Same positional wire id in BOTH conversations — exactly what the mock
    // LLM's `call_${i}` default (and a real OpenAI-compatible local server)
    // produces on two independent turns.
    await persistToolCall(builtinRow(convA, "call_0"));
    await persistToolCall(builtinRow(convB, "call_0"));

    // Pre-fix this would have logged a PK-violation `tool-call-persist-failed`
    // row for the second insert and left convB's tool_calls empty.
    expect(await countErrors()).toBe(errorsBefore);

    const rowsA = await getTestDb().select().from(toolCalls).where(eq(toolCalls.conversationId, convA));
    const rowsB = await getTestDb().select().from(toolCalls).where(eq(toolCalls.conversationId, convB));
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    // Distinct surrogate PKs — this is what makes the collision impossible.
    expect(rowsA[0]!.id).not.toBe(rowsB[0]!.id);
    // Both carry the SAME provider wire id, independently.
    expect(rowsA[0]!.providerToolCallId).toBe("call_0");
    expect(rowsB[0]!.providerToolCallId).toBe("call_0");

    // "Both render": the card-hydration path (getMessagesWithToolCalls →
    // toolCallRowToSummary) must surface BOTH rows, each keyed by the same
    // client-visible id ("call_0") the live SSE stream used — proving a
    // page reload mid-run still dedupes/matches correctly for EITHER
    // conversation despite the shared wire id.
    const hydratedA = await getMessagesWithToolCalls(convA);
    const hydratedB = await getMessagesWithToolCalls(convB);
    expect(hydratedA.orphanedToolCalls).toHaveLength(1);
    expect(hydratedB.orphanedToolCalls).toHaveLength(1);
    expect(hydratedA.orphanedToolCalls[0]!.id).toBe("call_0");
    expect(hydratedB.orphanedToolCalls[0]!.id).toBe("call_0");
    // ...but the underlying rows are NOT the same row (no cross-conversation
    // aliasing — each conversation's card points at its OWN persisted data).
    expect(hydratedA.orphanedToolCalls[0]!.durationMs).toBe(10);
    expect(hydratedB.orphanedToolCalls[0]!.durationMs).toBe(10);
  });

  test("a THIRD reuse in a later turn of the SAME conversation also persists (not just cross-conversation)", async () => {
    // The mock LLM's positional counter resets every completion request, so
    // a provider can replay the same wire id across turns within ONE
    // conversation too — the surrogate PK must not care.
    const conversationId = await seedConversationWithMessage();
    await persistToolCall(builtinRow(conversationId, "call_0"));
    await persistToolCall(builtinRow(conversationId, "call_0"));

    const rows = await getTestDb().select().from(toolCalls).where(eq(toolCalls.conversationId, conversationId));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
    expect(rows.every((r) => r.providerToolCallId === "call_0")).toBe(true);
  });
});

describe("extension-authored rows are unaffected (no provider wire id involved)", () => {
  test("toolCallRowToSummary falls back to the real id when providerToolCallId is null", async () => {
    const conversationId = await seedConversationWithMessage();
    await persistToolCall({
      conversationId,
      messageId: null,
      extensionId,
      toolName: "task_create",
      input: {},
      output: { content: [] },
      success: true,
      durationMs: 1,
    });

    const hydrated = await getMessagesWithToolCalls(conversationId);
    expect(hydrated.orphanedToolCalls).toHaveLength(1);
    const summary = hydrated.orphanedToolCalls[0]!;
    // No providerToolCallId was set — the summary's client-visible id is
    // the row's own surrogate PK, exactly as it always has been.
    const rows = await getTestDb().select().from(toolCalls).where(eq(toolCalls.conversationId, conversationId));
    expect(summary.id).toBe(rows[0]!.id);
  });
});

describe("getToolCallConversationById — F2 anti-forgery lookup tolerates the wire id too", () => {
  test("resolves an extension row by its exact (surrogate) id", async () => {
    const conversationId = await seedConversationWithMessage();
    const mintedId = crypto.randomUUID();
    await persistToolCall({
      id: mintedId,
      conversationId,
      messageId: null,
      extensionId,
      toolName: "task_create",
      input: {},
      output: { content: [] },
      success: true,
      durationMs: 1,
    });

    const found = await getToolCallConversationById(mintedId);
    expect(found).toEqual({ id: mintedId, conversationId });
  });

  test("falls back to providerToolCallId, most-recent-first, when the exact id misses", async () => {
    const convA = await seedConversationWithMessage();
    const convB = await seedConversationWithMessage();
    await persistToolCall(builtinRow(convA, "call_shared"));
    await persistToolCall(builtinRow(convB, "call_shared"));

    // Never assert on wall-clock ordering (two inserts this close together
    // can land in the same timestamp tick) — pin the varying term instead by
    // explicitly backdating convA's row so "most recent" is deterministic
    // regardless of real elapsed time between the two inserts above.
    await getTestDb()
      .update(toolCalls)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(toolCalls.conversationId, convA));

    // "call_shared" is nobody's surrogate PK — only the fallback resolves it.
    const found = await getToolCallConversationById("call_shared");
    expect(found).not.toBeNull();
    expect(found!.conversationId).toBe(convB); // most recently created
  });

  test("returns null when neither the id nor the wire id matches anything", async () => {
    const found = await getToolCallConversationById("totally-unknown-id");
    expect(found).toBeNull();
  });
});
