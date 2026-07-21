/**
 * Daily Briefing read-tools — error-path coverage.
 *
 * Drives the defensive branches the happy-path PGlite suite
 * (briefing-tools.test.ts) never reaches:
 *   - get_conversation_summary's outer catch when the message read throws.
 *   - get_task_snapshots' task-tracking-host-unavailable degrade (the lazy
 *     import resolves a non-function export).
 *   - get_task_snapshots' outer catch when a conversation read throws.
 *
 * DB queries + the task-tracking host are mocked so the throws are
 * deterministic (no real DB); the task-host mock is re-registered per case.
 */

import { afterAll, describe, expect, test, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

let convThrows = false;
let msgThrows = false;
mock.module("../db/queries/conversations", () => ({
  getConversation: async (id: string) => {
    if (convThrows) throw new Error("db conversation read boom");
    return { id, userId: "u1", title: "t", updatedAt: new Date() };
  },
  getMessages: async (_id: string) => {
    if (msgThrows) throw new Error("db message read boom");
    return [];
  },
}));

// Default: a valid host export. Individual tests re-register a non-function
// export to drive the "task tracking unavailable" degrade.
mock.module("../runtime/task-tracking-host", () => ({
  getTaskSnapshotForConversation: async () => undefined,
}));

const { createGetConversationSummaryTool, createGetTaskSnapshotsTool } = await import(
  "../runtime/briefing/tools"
);

const CTX = { userId: "u1", conversationId: "briefing", briefingAgentConfigId: "a1" } as const;

afterAll(() => restoreModuleMocks());

describe("briefing read-tools — error paths", () => {
  test("get_conversation_summary folds a message-read throw into an error result", async () => {
    convThrows = false;
    msgThrows = true;
    const tool = createGetConversationSummaryTool(CTX);
    const res = (await tool.execute("call-1", { conversationId: "conv-x" })) as {
      content: { text: string }[];
      details: { isError?: boolean };
    };
    expect(res.details.isError).toBe(true);
    expect(res.content[0]?.text).toContain("db message read boom");
    msgThrows = false;
  });

  test("get_task_snapshots degrades when the task-tracking host export is not a function", async () => {
    convThrows = false;
    // Re-point the lazy import at a non-function export → the tool throws
    // "export missing" internally and returns the unavailable note.
    mock.module("../runtime/task-tracking-host", () => ({
      getTaskSnapshotForConversation: 42 as unknown,
    }));
    const tool = createGetTaskSnapshotsTool(CTX);
    const res = (await tool.execute("call-2", { conversationIds: ["conv-a"] })) as {
      details: { unavailable?: boolean; isError?: boolean };
    };
    expect(res.details.isError).toBeFalsy();
    expect(res.details.unavailable).toBe(true);
    // Restore a valid host export for the next case.
    mock.module("../runtime/task-tracking-host", () => ({
      getTaskSnapshotForConversation: async () => undefined,
    }));
  });

  test("get_task_snapshots folds a conversation-read throw into an error result", async () => {
    convThrows = true;
    const tool = createGetTaskSnapshotsTool(CTX);
    const res = (await tool.execute("call-3", { conversationIds: ["conv-b"] })) as {
      content: { text: string }[];
      details: { isError?: boolean };
    };
    expect(res.details.isError).toBe(true);
    expect(res.content[0]?.text).toContain("db conversation read boom");
    convThrows = false;
  });
});
