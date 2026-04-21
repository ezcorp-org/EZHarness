import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Mock DB layer ────────────────────────────────────────────────────

let mockMessages: any[] = [];
let mockToolCallRows: any[] = [];
let mockSubConvoRows: any[] = [];

function resetMockState() {
  mockMessages = [];
  mockToolCallRows = [];
  mockSubConvoRows = [];
}

// Mock getMessages (used internally by getMessagesWithToolCalls)
mock.module("../db/connection", () => ({
  getDb: () => {
    const chain: any = {
      select: () => chain,
      from: (table: any) => {
        // Detect which table by checking if it's toolCalls (has toolName) vs messages
        chain._table = table;
        return chain;
      },
      where: (_condition: any) => chain,
      orderBy: (_order: any) => {
        // If we're querying toolCalls table, return tool call rows
        // The chain is used for both messages and toolCalls queries
        return Promise.resolve(chain._isToolCalls ? mockToolCallRows : []);
      },
      execute: (_sql: any) => Promise.resolve({ rows: mockSubConvoRows }),
    };

    // Override select to track which select pass we're on
    let selectCount = 0;
    chain.select = () => {
      selectCount++;
      return chain;
    };
    chain.from = (table: any) => {
      // toolCalls table has a `toolName` field in schema
      chain._isToolCalls = table?.toolName !== undefined;
      return chain;
    };
    chain.where = (_: any) => chain;
    chain.orderBy = (_: any) => {
      if (chain._isToolCalls) return Promise.resolve(mockToolCallRows);
      return Promise.resolve(mockMessages);
    };

    return chain;
  },
}));

// We also need to mock getMessages since getMessagesWithToolCalls calls it
mock.module("../db/queries/settings", () => ({
  getSetting: async () => undefined,
}));

// ── Import subjects after mocks ──────────────────────────────────────

import { truncateOutput, getMessagesWithToolCalls } from "../db/queries/conversations";

// Guard helper: narrow array-index access (`arr[i]`) from
// `T | undefined` to `T` in a single place. Throws descriptively so
// that a shape/length regression in the fixture surfaces the real cause.
function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

// ── truncateOutput tests (kept from original) ────────────────────────

describe("truncateOutput", () => {
  test("returns null for null input", () => {
    expect(truncateOutput(null)).toBeNull();
  });

  test("returns first line of string", () => {
    expect(truncateOutput("line1\nline2")).toBe("line1");
  });

  test("truncates long first line with ellipsis", () => {
    const long = "a".repeat(200);
    const result = truncateOutput(long, 120);
    expect(result).toBe("a".repeat(120) + "...");
  });

  test("extracts text from object with text property", () => {
    expect(truncateOutput({ text: "hello" })).toBe("hello");
  });

  test("extracts content from object with content property", () => {
    expect(truncateOutput({ content: "world" })).toBe("world");
  });

  test("extracts text from ToolCallResult content array", () => {
    expect(truncateOutput({ content: [{ type: "text", text: "file contents here" }] })).toBe("file contents here");
  });

  test("joins multiple text blocks from ToolCallResult content array", () => {
    expect(truncateOutput({
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
    })).toBe("line1");  // truncateOutput takes first line
  });

  test("falls back to JSON.stringify for unknown objects", () => {
    expect(truncateOutput({ foo: "bar" })).toBe('{"foo":"bar"}');
  });
});

// ── getMessagesWithToolCalls tests ───────────────────────────────────

describe("getMessagesWithToolCalls", () => {
  beforeEach(() => resetMockState());

  test("returns messages with embedded toolCalls array", async () => {
    const now = new Date();
    mockMessages = [
      { id: "msg-1", conversationId: "conv-1", role: "user", content: "hi", createdAt: now },
      { id: "msg-2", conversationId: "conv-1", role: "assistant", content: "hello", createdAt: now },
    ];
    mockToolCallRows = [
      {
        id: "tc-1", messageId: "msg-2", extensionId: "ext-1", toolName: "search",
        input: { q: "test" }, output: { text: "result" }, success: true, durationMs: 100, createdAt: now,
      },
    ];
    mockSubConvoRows = [];

    const result = await getMessagesWithToolCalls("conv-1");

    expect(result.messages).toHaveLength(2);
    const msg0 = at(result.messages, 0, "result.messages");
    const msg1 = at(result.messages, 1, "result.messages");
    expect(msg0.toolCalls).toEqual([]);
    expect(msg1.toolCalls).toHaveLength(1);
    const tc = at(msg1.toolCalls, 0, "messages[1].toolCalls");
    expect(tc.toolName).toBe("search");
    expect(tc.status).toBe("success");
  });

  test("messages with no tool calls have empty toolCalls array", async () => {
    const now = new Date();
    mockMessages = [
      { id: "msg-1", conversationId: "conv-1", role: "user", content: "hi", createdAt: now },
    ];
    mockToolCallRows = [];
    mockSubConvoRows = [];

    const result = await getMessagesWithToolCalls("conv-1");

    expect(result.messages).toHaveLength(1);
    expect(at(result.messages, 0, "result.messages").toolCalls).toEqual([]);
  });

  test("tool call status is 'interrupted' when success is null and output is null", async () => {
    const now = new Date();
    mockMessages = [
      { id: "msg-1", conversationId: "conv-1", role: "assistant", content: "working...", createdAt: now },
    ];
    mockToolCallRows = [
      {
        id: "tc-1", messageId: "msg-1", extensionId: "ext-1", toolName: "run",
        input: {}, output: null, success: null, durationMs: 0, createdAt: now,
      },
    ];
    mockSubConvoRows = [];

    const result = await getMessagesWithToolCalls("conv-1");

    expect(at(at(result.messages, 0, "result.messages").toolCalls, 0, "toolCalls").status).toBe("interrupted");
  });

  test("tool call status is 'success' when success is true", async () => {
    const now = new Date();
    mockMessages = [
      { id: "msg-1", conversationId: "conv-1", role: "assistant", content: "done", createdAt: now },
    ];
    mockToolCallRows = [
      {
        id: "tc-1", messageId: "msg-1", extensionId: "ext-1", toolName: "run",
        input: {}, output: { text: "ok" }, success: true, durationMs: 50, createdAt: now,
      },
    ];
    mockSubConvoRows = [];

    const result = await getMessagesWithToolCalls("conv-1");

    expect(at(at(result.messages, 0, "result.messages").toolCalls, 0, "toolCalls").status).toBe("success");
  });

  test("tool call status is 'error' when success is false", async () => {
    const now = new Date();
    mockMessages = [
      { id: "msg-1", conversationId: "conv-1", role: "assistant", content: "failed", createdAt: now },
    ];
    mockToolCallRows = [
      {
        id: "tc-1", messageId: "msg-1", extensionId: "ext-1", toolName: "run",
        input: {}, output: { text: "error msg" }, success: false, durationMs: 10, createdAt: now,
      },
    ];
    mockSubConvoRows = [];

    const result = await getMessagesWithToolCalls("conv-1");

    expect(at(at(result.messages, 0, "result.messages").toolCalls, 0, "toolCalls").status).toBe("error");
  });

  test("includes sub-conversation summaries", async () => {
    const now = new Date();
    mockMessages = [
      { id: "msg-1", conversationId: "conv-1", role: "user", content: "hi", createdAt: now },
    ];
    mockToolCallRows = [];
    mockSubConvoRows = [
      { id: "sub-1", agent_name: "researcher", agent_config_id: null, message_count: 3, last_message_preview: "Found 5 results", parent_message_id: "msg-1" },
      { id: "sub-2", agent_name: null, agent_config_id: null, message_count: 1, last_message_preview: null, parent_message_id: null },
    ];

    const result = await getMessagesWithToolCalls("conv-1");

    expect(result.subConversations).toHaveLength(2);
    expect(result.subConversations[0]).toEqual({
      id: "sub-1",
      agentName: "researcher",
      agentConfigId: null,
      messageCount: 3,
      lastMessagePreview: "Found 5 results",
      parentMessageId: "msg-1",
    });
    expect(result.subConversations[1]).toEqual({
      id: "sub-2",
      agentName: null,
      agentConfigId: null,
      messageCount: 1,
      lastMessagePreview: null,
      parentMessageId: null,
    });
  });

  test("returns empty arrays for conversation with no messages", async () => {
    mockMessages = [];
    mockToolCallRows = [];
    mockSubConvoRows = [];

    const result = await getMessagesWithToolCalls("conv-empty");

    expect(result.messages).toEqual([]);
    expect(result.subConversations).toEqual([]);
  });
});
