/**
 * Integration coverage for `loadHistory`'s `preprocess-result` filter —
 * the spec invariant "the LLM never sees preprocess-result rows"
 * (tasks/deterministic-preprocess.md, locked decision 6).
 *
 * Deterministic-preprocess rows are persisted IN-CHAIN (user →
 * preprocess-result… → assistant) so the transcript renders the card,
 * which means WITHOUT this filter the JSON payload would fall through
 * load-history's user-message mapper and reach the LLM as a fake user
 * turn — the exact leak class the ez-action-result filter closed
 * (load-history-ez-action-filter.test.ts). Same filter-at-the-source
 * shape; this suite pins the new role.
 *
 * Branch shape under test: user → preprocess-result → assistant → user
 * Expected post-load history: user → assistant → user (row is ABSENT).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { tmpdir } from "node:os";

mockDbConnection();

const { loadHistory } = await import("../runtime/stream-chat/load-history");
const { PREPROCESS_RESULT_ROLE } = await import("../runtime/stream-chat/preprocess-shared");
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
    email: "loadhist-preprocess@test.com",
    passwordHash: "h",
    name: "LH-PP",
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

describe("loadHistory — preprocess-result filter", () => {
  test("preprocess-result row is ABSENT from the LLM-visible history (not mapped to user)", async () => {
    const conv = await createConversation(projectId, { userId });
    const u1 = await createMessage(conv.id, {
      role: "user",
      content: "what is this slab worth?",
    });
    // The deterministic-preprocess runner persists this shape and chains
    // the assistant turn off it (setup-tools.ts).
    const rowPayload = JSON.stringify({
      extensionName: "graded-card-scanner",
      toolName: "identify_slab",
      cardType: "grade-delta-chart",
      ok: true,
      output: '{"cert":"49392223","grader":"PSA"}',
    });
    const pp = await createMessage(conv.id, {
      role: PREPROCESS_RESULT_ROLE,
      content: rowPayload,
      parentMessageId: u1.id,
    });
    const a1 = await createMessage(conv.id, {
      role: "assistant",
      content: "That slab is a PSA 9 Charizard.",
      parentMessageId: pp.id,
    });
    const u2 = await createMessage(conv.id, {
      role: "user",
      content: "second user turn (after the card)",
      parentMessageId: a1.id,
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

    const blob = result.history.map((m) => textOf(m.content)).join("\n");
    expect(blob).toContain("what is this slab worth?");
    expect(blob).toContain("That slab is a PSA 9 Charizard.");
    expect(blob).toContain("second user turn (after the card)");
    // The JSON card payload MUST NOT have leaked in any form.
    expect(blob).not.toContain("grade-delta-chart");
    expect(blob).not.toContain("identify_slab");
    expect(blob).not.toContain('"ok":true');
    expect(blob).not.toContain("preprocess-result");
  });

  test("two chained preprocess-result rows (multi-attachment turn) both filtered", async () => {
    // One user message with two matching attachments produces two chained
    // rows; both must drop from the LLM view.
    const conv = await createConversation(projectId, { userId });
    const u1 = await createMessage(conv.id, { role: "user", content: "go" });
    const p1 = await createMessage(conv.id, {
      role: PREPROCESS_RESULT_ROLE,
      content: JSON.stringify({ extensionName: "s", toolName: "t", ok: true, output: "A" }),
      parentMessageId: u1.id,
    });
    const p2 = await createMessage(conv.id, {
      role: PREPROCESS_RESULT_ROLE,
      content: JSON.stringify({ extensionName: "s", toolName: "t", ok: false, output: "B" }),
      parentMessageId: p1.id,
    });

    const result = await loadHistory(mkCtx(), conv.id, {
      parentMessageId: p2.id,
      projectId,
    });

    expect(result.history.length).toBe(1);
    expect(result.history[0]!.role).toBe("user");
    expect(textOf(result.history[0]!.content)).toBe("go");
  });

  test("malformed JSON content is still filtered (filter is role-based, not content-based)", async () => {
    const conv = await createConversation(projectId, { userId });
    const u1 = await createMessage(conv.id, { role: "user", content: "x" });
    const pp = await createMessage(conv.id, {
      role: PREPROCESS_RESULT_ROLE,
      content: "{not-valid-json",
      parentMessageId: u1.id,
    });
    const u2 = await createMessage(conv.id, {
      role: "user",
      content: "y",
      parentMessageId: pp.id,
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
