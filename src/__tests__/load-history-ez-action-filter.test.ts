/**
 * Integration coverage for `loadHistory`'s `ez-action-result` filter —
 * the spec invariant "the LLM never sees ez-action-result rows".
 *
 * Why this test exists: load-history's row-to-pi-ai mapper used to branch
 * only on `role === "assistant"`. Every other role (including the new
 * `ez-action-result` synthetic row) fell through to the user-message
 * mapping, sending the JSON-encoded `EzActionResult` payload to the LLM
 * as a fake user turn. The downstream filter in build-pi-agent.ts'
 * `convertToLlm` only sees the POST-mapping role (`"user"`) so it can't
 * catch the leak.
 *
 * The fix: explicit role filter at the source — return null from the
 * mapper for `ez-action-result` rows and drop the nulls before shaping
 * into pi-ai messages. This test pins the invariant down at the
 * integration level so a future contributor who refactors the mapper
 * can't silently regress.
 *
 * Branch shape under test: user → assistant → ez-action-result → user
 * Expected post-load history shape: user → assistant → user (3 rows;
 * ez-action-result row is ABSENT, NOT mapped to user).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { tmpdir } from "node:os";

mockDbConnection();

const { loadHistory } = await import("../runtime/stream-chat/load-history");
const { createUser } = await import("../db/queries/users");
const { createProject } = await import("../db/queries/projects");
const { createConversation, createMessage } = await import(
  "../db/queries/conversations"
);
import type { StreamChatContext } from "../runtime/stream-chat/context";

const SAFE_CWD = tmpdir();

let userId = "";
let projectId = "";

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "loadhist-ezaction@test.com",
    passwordHash: "h",
    name: "LH-EZ",
  });
  userId = u.id;
  const p = await createProject({ name: "p", path: "/tmp" });
  projectId = p.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  process.chdir(SAFE_CWD);
});

function mkCtx(): StreamChatContext {
  return { system: undefined } as unknown as StreamChatContext;
}

/** Flatten pi-ai content (string | parts array) into one text blob. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) =>
      typeof p === "object" && p !== null && "text" in p
        ? String((p as { text: unknown }).text)
        : "",
    )
    .join("\n");
}

describe("loadHistory — ez-action-result filter", () => {
  test("ez-action-result row is ABSENT from the LLM-visible history (not mapped to user)", async () => {
    const conv = await createConversation(projectId, { userId });
    const u1 = await createMessage(conv.id, {
      role: "user",
      content: "first user turn",
    });
    const a1 = await createMessage(conv.id, {
      role: "assistant",
      content: "first assistant reply",
      parentMessageId: u1.id,
    });
    // The dispatcher persists this kind of row when the user fires
    // `![EZ:distill]` from the action bar — synthetic, JSON-encoded.
    const ezResultPayload = JSON.stringify({
      kind: "success",
      card: {
        title: "Lesson captured",
        body: "always-quote-paths",
        variant: "success",
      },
      ref: { kind: "lesson", slug: "always-quote-paths" },
    });
    const ez = await createMessage(conv.id, {
      role: "ez-action-result",
      content: ezResultPayload,
      parentMessageId: a1.id,
    });
    const u2 = await createMessage(conv.id, {
      role: "user",
      content: "second user turn (after the action card)",
      parentMessageId: ez.id,
    });

    const result = await loadHistory(mkCtx(), conv.id, {
      parentMessageId: u2.id,
      projectId,
    });

    // 4 DB rows, 1 filtered → 3 LLM messages.
    expect(result.history.length).toBe(3);
    expect(result.history.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);

    // The JSON-encoded card payload MUST NOT have leaked into history,
    // either as a fake user turn or anywhere else.
    const blob = result.history.map((m) => textOf(m.content)).join("\n");
    expect(blob).toContain("first user turn");
    expect(blob).toContain("first assistant reply");
    expect(blob).toContain("second user turn (after the action card)");
    // None of these card fragments should appear in any LLM message.
    expect(blob).not.toContain("Lesson captured");
    expect(blob).not.toContain("always-quote-paths");
    expect(blob).not.toContain("ez-action-result");
    // The raw JSON shouldn't be there either (covers both stringified-
    // payload + accidental object-literal leakage paths).
    expect(blob).not.toContain('"kind":"success"');
  });

  test("two consecutive ez-action-result rows both filtered (no loop-counter regressions)", async () => {
    // Defensive: a single message can fire multiple `![EZ:*]` actions
    // (`!EZ:distill !EZ:summarize` in one turn), persisting two synthetic
    // rows in sequence. Both must drop.
    const conv = await createConversation(projectId, { userId });
    const u1 = await createMessage(conv.id, { role: "user", content: "go" });
    const ez1 = await createMessage(conv.id, {
      role: "ez-action-result",
      content: JSON.stringify({
        kind: "decline",
        card: { title: "A", body: "a", variant: "info" },
      }),
      parentMessageId: u1.id,
    });
    const ez2 = await createMessage(conv.id, {
      role: "ez-action-result",
      content: JSON.stringify({
        kind: "success",
        card: { title: "B", body: "b", variant: "success" },
      }),
      parentMessageId: ez1.id,
    });

    const result = await loadHistory(mkCtx(), conv.id, {
      parentMessageId: ez2.id,
      projectId,
    });

    expect(result.history.length).toBe(1);
    expect(result.history[0]!.role).toBe("user");
    const blob = result.history.map((m) => textOf(m.content)).join("\n");
    expect(blob).toBe("go");
  });

  test("ez-action-result with malformed JSON content is still filtered (filter is role-based, not content-based)", async () => {
    // The filter doesn't try to parse content — it triggers on role
    // alone. A row with corrupted JSON must still drop, not crash and
    // not leak.
    const conv = await createConversation(projectId, { userId });
    const u1 = await createMessage(conv.id, { role: "user", content: "x" });
    const ez = await createMessage(conv.id, {
      role: "ez-action-result",
      content: "{not-valid-json", // intentionally malformed
      parentMessageId: u1.id,
    });
    const u2 = await createMessage(conv.id, {
      role: "user",
      content: "y",
      parentMessageId: ez.id,
    });

    const result = await loadHistory(mkCtx(), conv.id, {
      parentMessageId: u2.id,
      projectId,
    });
    expect(result.history.length).toBe(2);
    expect(result.history.map((m) => m.role)).toEqual(["user", "user"]);
    const blob = result.history.map((m) => textOf(m.content)).join("\n");
    expect(blob).not.toContain("not-valid-json");
  });
});
