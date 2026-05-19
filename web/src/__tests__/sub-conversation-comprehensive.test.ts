import { test, expect, describe, beforeEach } from "bun:test";

// ── Store reimplementation (no Svelte 5 $state runes) ───────────────

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

// ── Helpers ─────────────────────────────────────────────────────────

const makeState = (agent: string, id = `sub-${agent}`): SubConversationState => ({
  id,
  agentConfigId: `cfg-${agent}`,
  agentName: agent,
  parentConversationId: "conv-1",
  parentMessageId: "msg-1",
});

const makeMsg = (id: string, role: "user" | "assistant", content: string): SubConvoMessage => ({
  id, role, content, createdAt: new Date(),
});

// ── Store Unit Tests ────────────────────────────────────────────────

describe("Sub-Conversation Store - Unit Tests", () => {
  let store: TestSubConversationStore;

  beforeEach(() => {
    store = new TestSubConversationStore();
  });

  test("start sub-conversation with 'researcher' agent, verify all state fields", () => {
    const state = makeState("researcher");
    store.startSubConversation(state);

    expect(store.isInSubConversation).toBe(true);
    expect(store.activeSubConversationId).toBe("sub-researcher");
    expect(store.activeSubConversation!.agentName).toBe("researcher");
    expect(store.activeSubConversation!.agentConfigId).toBe("cfg-researcher");
    expect(store.activeSubConversation!.parentConversationId).toBe("conv-1");
    expect(store.activeSubConversation!.parentMessageId).toBe("msg-1");
    expect(store.subConvoMessages).toEqual([]);
    expect(store.isStreaming).toBe(false);
  });

  test("start with 'coder', add 5 alternating messages, verify count and order", () => {
    store.startSubConversation(makeState("coder"));

    store.addMessage(makeMsg("m1", "user", "Write a function"));
    store.addMessage(makeMsg("m2", "assistant", "Here is the function"));
    store.addMessage(makeMsg("m3", "user", "Add error handling"));
    store.addMessage(makeMsg("m4", "assistant", "Done, added try/catch"));
    store.addMessage(makeMsg("m5", "user", "Looks good"));

    expect(store.subConvoMessages.length).toBe(5);
    expect(store.subConvoMessages[0]!.role).toBe("user");
    expect(store.subConvoMessages[1]!.role).toBe("assistant");
    expect(store.subConvoMessages[4]!.id).toBe("m5");
    // Verify order preserved
    const ids = store.subConvoMessages.map(m => m.id);
    expect(ids).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  test("endSubConversation returns all messages in order", () => {
    store.startSubConversation(makeState("reviewer"));
    store.addMessage(makeMsg("m1", "user", "Review this PR"));
    store.addMessage(makeMsg("m2", "assistant", "Found 3 issues"));
    store.addMessage(makeMsg("m3", "user", "Fix them"));

    const returned = store.endSubConversation();
    expect(returned.length).toBe(3);
    expect(returned[0]!.id).toBe("m1");
    expect(returned[2]!.id).toBe("m3");
  });

  test("cannot have two sub-conversations at same time (second overwrites first)", () => {
    store.startSubConversation(makeState("researcher"));
    store.addMessage(makeMsg("m1", "user", "Research topic A"));

    store.startSubConversation(makeState("debugger"));

    expect(store.activeSubConversation!.agentName).toBe("debugger");
    expect(store.activeSubConversationId).toBe("sub-debugger");
    expect(store.subConvoMessages).toEqual([]);
  });

  test("endSubConversation when none active returns empty array", () => {
    const msgs = store.endSubConversation();
    expect(msgs).toEqual([]);
    expect(store.isInSubConversation).toBe(false);
  });

  test("setStreaming(true) during active, verify isStreaming", () => {
    store.startSubConversation(makeState("coder"));
    expect(store.isStreaming).toBe(false);

    store.setStreaming(true);
    expect(store.isStreaming).toBe(true);
  });

  test("streaming resets on endSubConversation", () => {
    store.startSubConversation(makeState("researcher"));
    store.setStreaming(true);
    expect(store.isStreaming).toBe(true);

    store.endSubConversation();
    expect(store.isStreaming).toBe(false);
  });

  test("streaming resets on startSubConversation (new sub-convo clears previous)", () => {
    store.startSubConversation(makeState("researcher"));
    store.setStreaming(true);
    expect(store.isStreaming).toBe(true);

    store.startSubConversation(makeState("coder"));
    expect(store.isStreaming).toBe(false);
  });

  test("activeSubConversationId matches started conversation", () => {
    expect(store.activeSubConversationId).toBeNull();

    store.startSubConversation(makeState("debugger", "debug-42"));
    expect(store.activeSubConversationId).toBe("debug-42");

    store.endSubConversation();
    expect(store.activeSubConversationId).toBeNull();
  });

  test("addMessage with different agent names in sequence", () => {
    // Start researcher, add messages, end, start coder, add messages
    store.startSubConversation(makeState("researcher"));
    store.addMessage(makeMsg("r1", "user", "Research X"));
    store.addMessage(makeMsg("r2", "assistant", "Found results"));
    const researchMsgs = store.endSubConversation();

    store.startSubConversation(makeState("coder"));
    store.addMessage(makeMsg("c1", "user", "Implement X"));
    store.addMessage(makeMsg("c2", "assistant", "Done"));
    const coderMsgs = store.endSubConversation();

    expect(researchMsgs.length).toBe(2);
    expect(coderMsgs.length).toBe(2);
    expect(researchMsgs[0]!.content).toBe("Research X");
    expect(coderMsgs[0]!.content).toBe("Implement X");
  });
});

// ── Integration Tests ───────────────────────────────────────────────

describe("Sub-Conversation Store - Integration Tests", () => {
  let store: TestSubConversationStore;

  beforeEach(() => {
    store = new TestSubConversationStore();
  });

  test("full lifecycle: start → messages → streaming → end → verify", () => {
    // Start with researcher
    store.startSubConversation(makeState("researcher"));
    expect(store.isInSubConversation).toBe(true);

    // User sends message
    store.addMessage(makeMsg("m1", "user", "Find papers on transformers"));
    expect(store.subConvoMessages.length).toBe(1);

    // Assistant starts streaming
    store.setStreaming(true);
    expect(store.isStreaming).toBe(true);

    // Assistant message arrives
    store.addMessage(makeMsg("m2", "assistant", "I found 5 relevant papers"));

    // Streaming ends
    store.setStreaming(false);
    expect(store.isStreaming).toBe(false);

    // End sub-conversation
    const messages = store.endSubConversation();

    // Verify returned messages
    expect(messages.length).toBe(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toBe("I found 5 relevant papers");

    // Verify clean state
    expect(store.isInSubConversation).toBe(false);
    expect(store.activeSubConversationId).toBeNull();
    expect(store.subConvoMessages).toEqual([]);
    expect(store.isStreaming).toBe(false);
  });

  test("agent switch: researcher → end → coder → verify fresh state", () => {
    // Researcher session
    store.startSubConversation(makeState("researcher"));
    store.addMessage(makeMsg("r1", "user", "Research task"));
    store.addMessage(makeMsg("r2", "assistant", "Research complete"));
    const researchResult = store.endSubConversation();
    expect(researchResult.length).toBe(2);

    // Coder session — should have fresh state
    store.startSubConversation(makeState("coder"));
    expect(store.subConvoMessages).toEqual([]);
    expect(store.activeSubConversation!.agentName).toBe("coder");

    store.addMessage(makeMsg("c1", "user", "Code task"));
    expect(store.subConvoMessages.length).toBe(1);
    // No researcher messages leaked
    expect(store.subConvoMessages.every(m => m.id.startsWith("c"))).toBe(true);
  });

  test("rapid start/end 3 times with different agents, verify clean each time", () => {
    const agents = ["researcher", "coder", "reviewer"];

    for (const agent of agents) {
      store.startSubConversation(makeState(agent));
      expect(store.isInSubConversation).toBe(true);
      expect(store.activeSubConversation!.agentName).toBe(agent);
      expect(store.subConvoMessages).toEqual([]);

      store.addMessage(makeMsg(`${agent}-m1`, "user", `Task for ${agent}`));
      const msgs = store.endSubConversation();

      expect(msgs.length).toBe(1);
      expect(msgs[0]!.content).toBe(`Task for ${agent}`);
      expect(store.isInSubConversation).toBe(false);
      expect(store.subConvoMessages).toEqual([]);
      expect(store.isStreaming).toBe(false);
    }
  });
});
