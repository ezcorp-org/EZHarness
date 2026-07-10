/**
 * `listToolCallExtensionIdsForMessage` — the recorded extension identity
 * of an extension-authored message (fix-wave B Phase 3).
 *
 * The `messages` table has no extension column; the identity of an
 * `ezcorp/append-message` turn lives on the tool_calls rows the handler
 * persists with the calling extension's id. The uploads route binds a
 * target message to the uploading extension through this query, so its
 * contract is pinned against a real PGlite DB (FKs enforced):
 *
 *   - distinct extension ids of the rows anchored to the message,
 *   - a message with no rows → [] (no recorded identity),
 *   - rows of OTHER messages never leak in,
 *   - empty messageId → [] without touching the DB.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { listToolCallExtensionIdsForMessage, persistToolCall } from "../db/queries/tool-calls";
import { users, projects, conversations, extensions, messages } from "../db/schema";

const CONV_ID = "conv-msg-binding";
const MSG_A = "msg-binding-a";
const MSG_B = "msg-binding-b";
const EXT_KOKORO = "ext-binding-kokoro";
const EXT_OTHER = "ext-binding-other";

beforeAll(async () => {
  await setupTestDb();
  const db = getTestDb();
  await db.insert(users).values({
    id: "user-binding", email: "binding@t.local", passwordHash: "x", name: "b",
  } as never);
  await db.insert(projects).values({
    id: "proj-binding", name: "proj-binding", path: "/tmp/proj-binding",
  } as never);
  await db.insert(conversations).values({
    id: CONV_ID, projectId: "proj-binding", title: "binding",
  } as never);
  for (const extId of [EXT_KOKORO, EXT_OTHER]) {
    await db.insert(extensions).values({
      id: extId, name: extId, version: "1.0.0", description: "t",
      manifest: {
        schemaVersion: 2, name: extId, version: "1.0.0", description: "",
        author: { name: "t" }, permissions: {},
      } as never,
      source: `test:${extId}`, installPath: `/tmp/${extId}`, enabled: true,
      grantedPermissions: { grantedAt: {} } as never,
    } as never);
  }
  for (const msgId of [MSG_A, MSG_B]) {
    await db.insert(messages).values({
      id: msgId, conversationId: CONV_ID, role: "extension", content: "turn",
    } as never);
  }
  // MSG_A: two rows from kokoro (dedup expected) + one from the other ext.
  for (const [id, extId] of [
    ["tc-binding-1", EXT_KOKORO],
    ["tc-binding-2", EXT_KOKORO],
    ["tc-binding-3", EXT_OTHER],
  ] as const) {
    await persistToolCall({
      id,
      conversationId: CONV_ID,
      messageId: MSG_A,
      extensionId: extId,
      toolName: "synthesize",
      input: { text: "hi" },
      output: { content: [{ type: "text", text: "ok" }] },
      success: true,
      durationMs: 0,
    });
  }
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("listToolCallExtensionIdsForMessage", () => {
  test("returns the DISTINCT extension ids anchored to the message", async () => {
    const ids = await listToolCallExtensionIdsForMessage(MSG_A);
    expect(ids.sort()).toEqual([EXT_KOKORO, EXT_OTHER].sort());
  });

  test("message with no tool-call rows → [] (no recorded identity)", async () => {
    const ids = await listToolCallExtensionIdsForMessage(MSG_B);
    expect(ids).toEqual([]);
  });

  test("unknown messageId → []", async () => {
    const ids = await listToolCallExtensionIdsForMessage("msg-never-existed");
    expect(ids).toEqual([]);
  });

  test("empty messageId short-circuits to []", async () => {
    const ids = await listToolCallExtensionIdsForMessage("");
    expect(ids).toEqual([]);
  });
});
