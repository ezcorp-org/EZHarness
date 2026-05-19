import { test, expect, describe } from "bun:test";
import { exportToMarkdown, exportToJson } from "../lib/export";

// Export functions are pure -- no DB needed

const mockConversation = {
  id: "conv-1",
  projectId: "proj-1",
  title: "Test Conversation",
  model: "gpt-4o",
  provider: "openai",
  systemPrompt: null as string | null,
  createdAt: new Date("2026-01-15T10:00:00Z"),
  updatedAt: new Date("2026-01-15T11:00:00Z"),
};

const mockMessages = [
  {
    id: "msg-1",
    conversationId: "conv-1",
    role: "user",
    content: "Hello, how are you?",
    model: null as string | null,
    provider: null as string | null,
    usage: null as { inputTokens: number; outputTokens: number } | null,
    runId: null as string | null,
    parentMessageId: null as string | null,
    createdAt: new Date("2026-01-15T10:00:00Z"),
  },
  {
    id: "msg-2",
    conversationId: "conv-1",
    role: "assistant",
    content: "I'm doing great! How can I help you today?",
    model: "gpt-4o",
    provider: "openai",
    usage: { inputTokens: 10, outputTokens: 20 },
    runId: "run-1",
    parentMessageId: "msg-1",
    createdAt: new Date("2026-01-15T10:00:05Z"),
  },
  {
    id: "msg-3",
    conversationId: "conv-1",
    role: "user",
    content: "Can you write some code?\n\n```typescript\nconsole.log('hello');\n```",
    model: null as string | null,
    provider: null as string | null,
    usage: null as { inputTokens: number; outputTokens: number } | null,
    runId: null as string | null,
    parentMessageId: "msg-2",
    createdAt: new Date("2026-01-15T10:01:00Z"),
  },
];

describe("exportToMarkdown", () => {
  test("produces correct format with headers and metadata", () => {
    const md = exportToMarkdown(mockConversation, mockMessages);

    expect(md).toContain("# Test Conversation");
    expect(md).toContain("**Created:**");
    expect(md).toContain("**Model:** gpt-4o");
    expect(md).toContain("---");
    expect(md).toContain("### **You**");
    expect(md).toContain("### **Assistant** (gpt-4o)");
    expect(md).toContain("Hello, how are you?");
    expect(md).toContain("I'm doing great!");
    // Preserves code blocks
    expect(md).toContain("```typescript");
    expect(md).toContain("console.log('hello');");
  });

  test("handles assistant with no model", () => {
    const msgs = [
      { ...mockMessages[0]! },
      { ...mockMessages[1]!, model: null },
    ];
    const md = exportToMarkdown(mockConversation, msgs);
    expect(md).toContain("### **Assistant** (unknown)");
  });

  test("handles empty messages", () => {
    const md = exportToMarkdown(mockConversation, []);
    expect(md).toContain("# Test Conversation");
    expect(md).not.toContain("### **You**");
  });
});

describe("exportToJson", () => {
  test("produces valid JSON with conversation and messages", () => {
    const jsonStr = exportToJson(mockConversation, mockMessages);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.conversation.id).toBe("conv-1");
    expect(parsed.conversation.title).toBe("Test Conversation");
    expect(parsed.conversation.model).toBe("gpt-4o");
    expect(parsed.conversation.provider).toBe("openai");
    expect(parsed.conversation.createdAt).toBeDefined();
    expect(parsed.conversation.updatedAt).toBeDefined();

    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[0].content).toBe("Hello, how are you?");
    expect(parsed.messages[1].role).toBe("assistant");
    expect(parsed.messages[1].model).toBe("gpt-4o");
    expect(parsed.messages[1].usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(parsed.messages[2].content).toContain("```typescript");

    expect(parsed.exportedAt).toBeDefined();
    // Verify exportedAt is a valid ISO date
    expect(new Date(parsed.exportedAt).toISOString()).toBe(parsed.exportedAt);
  });

  test("handles empty messages", () => {
    const jsonStr = exportToJson(mockConversation, []);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.messages).toHaveLength(0);
    expect(parsed.conversation.title).toBe("Test Conversation");
  });
});
