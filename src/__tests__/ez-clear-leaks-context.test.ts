/**
 * Pins down the post-Clear contract for the Ez panel: after the user
 * hits "Clear conversation", the conversation row stays alive (the
 * schema enforces one Ez convo per user, so we can't delete it), but
 * the NEXT turn's `loadHistory` call MUST return an empty history.
 *
 * Adjacent state that is *not* anchored to messages (and therefore
 * not cascaded by the message wipe) needs to be considered too —
 * specifically `conversation_extensions`. That table's
 * `added_by_message_id` FK is `ON DELETE SET NULL`, which means rows
 * survive the message wipe and continue wiring extensions on every
 * subsequent turn. This test fixes the contract — clear should leave
 * the conversation in the same shape as a freshly-created Ez convo
 * (no wired extensions, empty branch, no leftover tool_calls).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { toolCalls, extensions } from "../db/schema";

mockDbConnection();

const { loadHistory } = await import("../runtime/stream-chat/load-history");
const { createUser } = await import("../db/queries/users");
const {
  getOrCreateEzConversation,
  createMessage,
  deleteAllMessagesForConversation,
} = await import("../db/queries/conversations");
const { addConversationExtensions, getConversationExtensionIds } = await import(
  "../db/queries/conversation-extensions"
);
import type { StreamChatContext } from "../runtime/stream-chat/context";

const SAFE_CWD = tmpdir();
let userId = "";

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "ez-clear-leaks@test.com",
    passwordHash: "h",
    name: "EzClear",
  });
  userId = u.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  process.chdir(SAFE_CWD);
});

function mkCtx(): StreamChatContext {
  return { system: undefined } as unknown as StreamChatContext;
}

describe("Ez clear → next-turn loadHistory", () => {
  test("loadHistory returns empty branch after clear (messages-only path is clean)", async () => {
    const ezConv = await getOrCreateEzConversation(userId);
    const u1 = await createMessage(ezConv.id, { role: "user", content: "first" });
    const a1 = await createMessage(ezConv.id, {
      role: "assistant",
      content: "first response",
      parentMessageId: u1.id,
    });

    // Sanity: pre-clear, loadHistory sees both turns.
    const pre = await loadHistory(mkCtx(), ezConv.id, { parentMessageId: a1.id });
    expect(pre.history.length).toBe(2);

    const deleted = await deleteAllMessagesForConversation(ezConv.id);
    expect(deleted).toBe(2);

    // Post-clear: load-history without parentMessageId mirrors the
    // next-turn path (no leaf to anchor on → empty array).
    const post = await loadHistory(mkCtx(), ezConv.id, {});
    expect(post.history.length).toBe(0);
    expect(post.history).toEqual([]);
  });

  test("conversation_extensions wired on prior turn are wiped on clear", async () => {
    const ezConv = await getOrCreateEzConversation(userId);

    // Seed a fake extension row + wire it through a user message — this
    // mirrors what wireMentionedExtensions does when the user types
    // "![ext:foo] do thing" and then sends.
    const db = getTestDb();
    const [ext] = await db
      .insert(extensions)
      .values({
        id: "ext-foo",
        name: "foo",
        version: "1.0.0",
        manifest: { name: "foo", version: "1.0.0" } as any,
        source: "test",
      })
      .onConflictDoNothing()
      .returning();
    const extId = ext?.id ?? "ext-foo";

    const userMsg = await createMessage(ezConv.id, {
      role: "user",
      content: "![ext:foo] hello",
    });

    await addConversationExtensions(ezConv.id, [
      { extensionId: extId, messageId: userMsg.id },
    ]);

    expect(await getConversationExtensionIds(ezConv.id)).toContain(extId);

    // Clear the conversation. The fix extends the message wipe to also
    // delete from conversation_extensions and tool_calls, so a previously
    // wired ![ext:foo] mention doesn't keep re-wiring its tools on the
    // next turn.
    await deleteAllMessagesForConversation(ezConv.id);

    const lingering = await getConversationExtensionIds(ezConv.id);
    expect(lingering).toEqual([]);
  });

  test("tool_calls are wiped on clear (no orphans left attached to the conversation)", async () => {
    const ezConv = await getOrCreateEzConversation(userId);
    const userMsg = await createMessage(ezConv.id, { role: "user", content: "u" });
    const asstMsg = await createMessage(ezConv.id, {
      role: "assistant",
      content: "a",
      parentMessageId: userMsg.id,
    });

    const db = getTestDb();
    // Need a real extension FK for tool_calls.extension_id (NOT NULL CASCADE).
    await db
      .insert(extensions)
      .values({
        id: "ext-tc",
        name: "tc-ext",
        version: "1.0.0",
        manifest: { name: "tc-ext", version: "1.0.0" } as any,
        source: "test",
      })
      .onConflictDoNothing();

    await db.insert(toolCalls).values({
      conversationId: ezConv.id,
      messageId: asstMsg.id,
      extensionId: "ext-tc",
      toolName: "doThing",
      input: {},
      output: { content: [{ type: "text", text: "did it" }] },
      success: true,
      durationMs: 10,
    });

    await deleteAllMessagesForConversation(ezConv.id);

    // The fix wipes tool_calls along with messages so no orphan rows
    // (with messageId=null) remain to pollute Diff Summary or any
    // orphanedToolCalls UI surface.
    const remaining = await db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.conversationId, ezConv.id));
    expect(remaining.length).toBe(0);
  });
});
