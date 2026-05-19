import { test, expect, describe, mock, beforeEach } from "bun:test";

// Mock the DB layer before importing
const mockReturning = mock();
const mockValues = mock(() => ({ returning: mockReturning }));
const mockInsert = mock(() => ({ values: mockValues }));
const mockOrderBy = mock();
const mockWhere = mock(() => ({ orderBy: mockOrderBy }));
const mockFrom = mock(() => ({ where: mockWhere }));
const mockSelect = mock(() => ({ from: mockFrom }));
const mockGetDb = mock(() => ({ insert: mockInsert, select: mockSelect }));

mock.module("../../../src/db/connection", () => ({ getDb: mockGetDb }));
mock.module("../../../src/db/queries/settings", () => ({ getSetting: mock(() => null) }));

// Must import after mocking
const { createSubConversation, getSubConversations } = await import("../../../src/db/queries/conversations");

describe("Sub-Conversation Lifecycle (SUBC-01, SUBC-03, SUBC-04)", () => {
  beforeEach(() => {
    mockReturning.mockReset();
    mockOrderBy.mockReset();
  });

  test("createSubConversation creates conversation with parent reference", async () => {
    mockReturning.mockReturnValue([{
      id: "sub-1", projectId: "proj-1",
      parentConversationId: "conv-1", parentMessageId: "msg-1",
      title: "Sub conversation", agentConfigId: "agent-1",
    }]);

    const result = await createSubConversation("proj-1", {
      parentConversationId: "conv-1",
      parentMessageId: "msg-1",
      agentConfigId: "agent-1",
      title: "Sub conversation",
    });
    expect(result).toBeDefined();
    expect(result.parentConversationId).toBe("conv-1");
    expect(result.parentMessageId).toBe("msg-1");
  });

  test("createSubConversation requires parentConversationId", async () => {
    await expect(
      createSubConversation("proj-1", { parentConversationId: "", parentMessageId: "msg-1" })
    ).rejects.toThrow("parentConversationId is required");
  });

  test("getSubConversations returns child conversations", async () => {
    const children = [
      { id: "sub-1", parentConversationId: "conv-1", createdAt: new Date() },
      { id: "sub-2", parentConversationId: "conv-1", createdAt: new Date() },
    ];
    mockOrderBy.mockReturnValue(children);

    const results = await getSubConversations("conv-1");
    expect(results).toBeArray();
    expect(results.length).toBe(2);
  });

  test.todo("only triggering message passes as initial context", () => {});
  test.todo("sub-conversation uses agent's own system prompt only", () => {});
  test.todo("return to main inserts last agent message as summary", () => {});
  test.todo("sub-conversation has separate message scope", () => {});
});

// ── Client Store Tests ──────────────────────────────────────────────
// Re-implement store logic without Svelte 5 runes for testability (same pattern as inline-tool-store tests)

interface SubConversationState {
  id: string;
  agentConfigId: string;
  agentName: string;
  parentConversationId: string;
  parentMessageId: string;
}

interface SubConvoMessage {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

class TestSubConversationStore {
  activeSubConversation: SubConversationState | null = null;
  subConvoMessages: SubConvoMessage[] = [];
  isStreaming = false;

  get isInSubConversation(): boolean { return this.activeSubConversation !== null; }
  get activeSubConversationId(): string | null { return this.activeSubConversation?.id ?? null; }

  startSubConversation(opts: SubConversationState): void {
    this.activeSubConversation = opts;
    this.subConvoMessages = [];
    this.isStreaming = false;
  }

  endSubConversation(): SubConvoMessage[] {
    const messages = this.subConvoMessages;
    this.activeSubConversation = null;
    this.subConvoMessages = [];
    this.isStreaming = false;
    return messages;
  }

  addMessage(msg: SubConvoMessage): void {
    this.subConvoMessages = [...this.subConvoMessages, msg];
  }

  setStreaming(streaming: boolean): void { this.isStreaming = streaming; }
}

describe("Sub-Conversation Client Store", () => {
  let store: TestSubConversationStore;

  beforeEach(() => {
    store = new TestSubConversationStore();
  });

  test("tracks activeSubConversationId and isInSubConversation", () => {
    expect(store.isInSubConversation).toBe(false);
    expect(store.activeSubConversationId).toBeNull();

    store.startSubConversation({
      id: "sub-1", agentConfigId: "cfg-1", agentName: "Helper",
      parentConversationId: "conv-1", parentMessageId: "msg-1",
    });

    expect(store.isInSubConversation).toBe(true);
    expect(store.activeSubConversationId).toBe("sub-1");
  });

  test("addMessage appends to subConvoMessages", () => {
    store.startSubConversation({
      id: "sub-1", agentConfigId: "cfg-1", agentName: "Helper",
      parentConversationId: "conv-1", parentMessageId: "msg-1",
    });

    store.addMessage({ id: "m1", role: "user", content: "hello", createdAt: new Date() });
    store.addMessage({ id: "m2", role: "assistant", content: "hi", createdAt: new Date() });

    expect(store.subConvoMessages.length).toBe(2);
  });

  test("endSubConversation clears state and returns messages", () => {
    store.startSubConversation({
      id: "sub-1", agentConfigId: "cfg-1", agentName: "Helper",
      parentConversationId: "conv-1", parentMessageId: "msg-1",
    });
    store.addMessage({ id: "m1", role: "assistant", content: "done", createdAt: new Date() });

    const msgs = store.endSubConversation();
    expect(msgs.length).toBe(1);
    expect(store.isInSubConversation).toBe(false);
    expect(store.subConvoMessages.length).toBe(0);
  });

  test("streaming state management", () => {
    expect(store.isStreaming).toBe(false);
    store.setStreaming(true);
    expect(store.isStreaming).toBe(true);
    store.setStreaming(false);
    expect(store.isStreaming).toBe(false);
  });
});
