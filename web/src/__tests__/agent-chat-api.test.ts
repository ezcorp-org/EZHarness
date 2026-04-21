import { test, expect, describe, beforeEach, mock } from "bun:test";

// ── Shared state used by mocks ─────────────────────────────────────

type Conversation = {
  id: string;
  userId: string | null;
  projectId: string | null;
  parentConversationId: string | null;
  agentConfigId: string | null;
  systemPrompt: string | null;
  model?: string;
  provider?: string;
};

let mockSubConv: Conversation | null = null;
let mockParentConv: Conversation | null = null;
let mockLatestLeaf: { id: string } | null = null;
let mockScopeResponse: Response | null = null;
let mockUser = { id: "user-1", email: "test@test.com", name: "Test", role: "member" };
let mockAgentConfig: { id: string; name: string; prompt: string; model?: string; provider?: string } | null = null;

// ── Mock db/query layer ─────────────────────────────────────────────

const mockGetConversation = mock(async (id: string) => {
  if (id === "sub-conv-1") return mockSubConv;
  if (id === "parent-conv-1") return mockParentConv;
  return null;
});
const mockGetLatestLeaf = mock(async (_convId: string) => mockLatestLeaf);
const mockCreateMessage = mock(async (_convId: string, opts: any) => ({
  id: "msg-new-" + crypto.randomUUID().slice(0, 8),
  role: opts.role,
  content: opts.content,
  parentMessageId: opts.parentMessageId,
  createdAt: new Date(),
}));

mock.module("$server/db/queries/conversations", () => ({
  getConversation: mockGetConversation,
  getLatestLeaf: mockGetLatestLeaf,
  createMessage: mockCreateMessage,
}));

const mockGetAgentConfig = mock(async (_id: string) => mockAgentConfig);
mock.module("$server/db/queries/agent-configs", () => ({
  getAgentConfig: mockGetAgentConfig,
}));

// ── Mock auth + scope ──────────────────────────────────────────────

mock.module("$server/auth/middleware", () => ({
  requireAuth: (locals: any) => locals?.user ?? mockUser,
}));

mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => mockScopeResponse,
}));

// ── Mock event bus + executor ──────────────────────────────────────

const mockBusEmit = mock((..._args: any[]) => {});
const mockBus = { emit: mockBusEmit };

const mockActiveRun = { id: "run-active", status: "running" };
let mockGetActiveRunResult: any = null;
const mockStreamChat = mock(async (..._args: any[]) => ({}));
const mockExecutor = {
  streamChat: mockStreamChat,
  getActiveRunForConversation: mock((_id: string) => mockGetActiveRunResult),
};

mock.module("$lib/server/context", () => ({
  getBus: () => mockBus,
  getExecutor: () => mockExecutor,
  getCommandRegistry: () => ({
    listCommands: async () => [],
    findCommand: async () => null,
    invalidate: () => {},
  }),
}));

mock.module("$server/db/queries/projects", () => ({
  getProject: async () => null,
}));

// ── Mock pending-messages ──────────────────────────────────────────

const mockEnqueue = mock((..._args: any[]) => {});
mock.module("$server/runtime/pending-messages", () => ({
  enqueue: mockEnqueue,
}));

mock.module("$server/types", () => ({ CURRENT_MODEL_SENTINEL: "__current__" }));

// ── Import handler AFTER mocks ─────────────────────────────────────

const { POST } = await import(
  "../routes/api/conversations/[id]/agent-chat/+server"
);

// ── Helpers ─────────────────────────────────────────────────────────

function makeEvent(subConvId: string, body?: Record<string, unknown>) {
  return {
    request: new Request(
      `http://localhost/api/conversations/${subConvId}/agent-chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? { content: "hello agent" }),
      },
    ),
    params: { id: subConvId },
    locals: { user: mockUser },
  } as any;
}

function resetMocks() {
  mockSubConv = {
    id: "sub-conv-1",
    userId: null,
    projectId: "proj-1",
    parentConversationId: "parent-conv-1",
    agentConfigId: "agent-cfg-1",
    systemPrompt: "You are a test agent",
    model: null,
    provider: null,
  };
  mockParentConv = {
    id: "parent-conv-1",
    userId: "user-1",
    projectId: "proj-1",
    parentConversationId: null,
    agentConfigId: null,
    systemPrompt: null,
    model: "claude-sonnet",
    provider: "anthropic",
  };
  mockLatestLeaf = { id: "leaf-msg-1" };
  mockAgentConfig = {
    id: "agent-cfg-1",
    name: "TestAgent",
    prompt: "You are a test agent",
  };
  mockScopeResponse = null;
  mockGetActiveRunResult = null;

  mockGetConversation.mockReset();
  mockGetConversation.mockImplementation(async (id: string) => {
    if (id === "sub-conv-1") return mockSubConv;
    if (id === "parent-conv-1") return mockParentConv;
    return null;
  });
  mockGetLatestLeaf.mockReset();
  mockGetLatestLeaf.mockImplementation(async () => mockLatestLeaf);
  mockCreateMessage.mockReset();
  mockCreateMessage.mockImplementation(async (_convId: string, opts: any) => ({
    id: "msg-new",
    role: opts.role,
    content: opts.content,
    parentMessageId: opts.parentMessageId,
    createdAt: new Date(),
  }));
  mockGetAgentConfig.mockReset();
  mockGetAgentConfig.mockImplementation(async () => mockAgentConfig);
  mockExecutor.getActiveRunForConversation.mockReset();
  mockExecutor.getActiveRunForConversation.mockImplementation(() => mockGetActiveRunResult);
  mockStreamChat.mockReset();
  mockStreamChat.mockImplementation(async () => ({}));
  mockBusEmit.mockClear();
  mockEnqueue.mockClear();
}

// ── Tests ───────────────────────────────────────────────────────────

describe("POST /api/conversations/[id]/agent-chat", () => {
  beforeEach(resetMocks);

  // ── Validation ────────────────────────────────────────────────────

  test("returns 400 for missing content", async () => {
    const res = await POST(makeEvent("sub-conv-1", {}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("content");
  });

  test("returns 400 for empty string content", async () => {
    const res = await POST(makeEvent("sub-conv-1", { content: "   " }));
    expect(res.status).toBe(400);
  });

  test("returns 404 for missing conversation", async () => {
    const res = await POST(makeEvent("nonexistent"));
    expect(res.status).toBe(404);
  });

  test("returns 400 for non-sub-conversation (no parentConversationId)", async () => {
    mockSubConv!.parentConversationId = null;
    const res = await POST(makeEvent("sub-conv-1"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("sub-conversation");
  });

  test("returns 404 when parent conv belongs to different user", async () => {
    mockParentConv!.userId = "other-user";
    const res = await POST(makeEvent("sub-conv-1"));
    expect(res.status).toBe(404);
  });

  // ── Message saving ────────────────────────────────────────────────

  test("saves user message with correct parentMessageId from latest leaf", async () => {
    mockLatestLeaf = { id: "leaf-abc" };
    await POST(makeEvent("sub-conv-1"));

    expect(mockCreateMessage).toHaveBeenCalledTimes(1);
    expect(mockCreateMessage).toHaveBeenCalledWith("sub-conv-1", {
      role: "user",
      content: "hello agent",
      parentMessageId: "leaf-abc",
    });
  });

  test("saves message with undefined parentMessageId when no leaf exists", async () => {
    mockLatestLeaf = null;
    await POST(makeEvent("sub-conv-1"));

    expect(mockCreateMessage).toHaveBeenCalledWith("sub-conv-1", {
      role: "user",
      content: "hello agent",
      parentMessageId: undefined,
    });
  });

  // ── Agent running → queue ─────────────────────────────────────────

  test("when agent is running: enqueues message and returns queued status", async () => {
    mockGetActiveRunResult = mockActiveRun;
    const res = await POST(makeEvent("sub-conv-1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("queued");
    expect(body.messageId).toBe("msg-new");
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith("sub-conv-1", expect.objectContaining({
      messageId: "msg-new",
      content: "hello agent",
    }));
  });

  test("when agent is running: does NOT call executor.streamChat", async () => {
    mockGetActiveRunResult = mockActiveRun;
    await POST(makeEvent("sub-conv-1"));
    expect(mockStreamChat).not.toHaveBeenCalled();
  });

  // ── Agent idle → start new run ────────────────────────────────────

  test("when agent is idle: starts new run and returns started status", async () => {
    mockGetActiveRunResult = null;
    const res = await POST(makeEvent("sub-conv-1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("started");
    expect(body.messageId).toBe("msg-new");
    expect(body.runId).toBeString();
  });

  test("when agent is idle: calls executor.streamChat with correct params", async () => {
    mockGetActiveRunResult = null;
    await POST(makeEvent("sub-conv-1"));

    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    const [subConvId, content, opts] = mockStreamChat.mock.calls[0];
    expect(subConvId).toBe("sub-conv-1");
    expect(content).toBe("hello agent");
    expect(opts.agentConfigId).toBe("agent-cfg-1");
    expect(opts.projectId).toBe("proj-1");
    expect(opts.system).toBe("You are a test agent");
  });

  test("when agent is idle: does NOT enqueue", async () => {
    mockGetActiveRunResult = null;
    await POST(makeEvent("sub-conv-1"));
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test("when agent is idle: emits agent:spawn event", async () => {
    mockGetActiveRunResult = null;
    await POST(makeEvent("sub-conv-1"));

    expect(mockBusEmit).toHaveBeenCalledWith(
      "agent:spawn",
      expect.objectContaining({
        agentName: "TestAgent",
        agentConfigId: "agent-cfg-1",
        subConversationId: "sub-conv-1",
        parentConversationId: "parent-conv-1",
        task: "hello agent",
      }),
    );
  });

  test("when agent is idle and no agent config: still starts run", async () => {
    mockGetActiveRunResult = null;
    mockSubConv!.agentConfigId = null;
    mockGetAgentConfig.mockImplementation(async () => null);

    const res = await POST(makeEvent("sub-conv-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("started");
    expect(mockStreamChat).toHaveBeenCalledTimes(1);
  });

  // ── __current__ sentinel resolution ───────────────────────────────

  test("resolves __current__ sentinel to parent conv model/provider", async () => {
    mockGetActiveRunResult = null;
    mockAgentConfig = {
      id: "agent-cfg-1",
      name: "TestAgent",
      prompt: "You are a test agent",
      model: "__current__",
      provider: "__current__",
    };
    mockParentConv!.model = "gpt-4o" as any;
    mockParentConv!.provider = "openai" as any;

    await POST(makeEvent("sub-conv-1"));

    const [, , opts] = mockStreamChat.mock.calls[0];
    expect(opts.model).toBe("gpt-4o");
    expect(opts.provider).toBe("openai");
  });

  test("never passes __current__ sentinel to streamChat", async () => {
    mockGetActiveRunResult = null;
    mockAgentConfig = {
      id: "agent-cfg-1",
      name: "TestAgent",
      prompt: "You are a test agent",
      model: "__current__",
      provider: "__current__",
    };

    await POST(makeEvent("sub-conv-1"));

    const [, , opts] = mockStreamChat.mock.calls[0];
    expect(opts.model).not.toBe("__current__");
    expect(opts.provider).not.toBe("__current__");
  });

  // ── agent:complete emission (regression: main chat must auto-refresh) ─
  //
  // Before this fix, agent-chat only emitted agent:spawn and let the
  // streamChat promise resolve silently. The main chat page only refreshes
  // its message list on agent:complete events that carry parentConversationId,
  // so private chats with sub-agents never updated the parent thread until a
  // full page refresh. These tests pin the emission contract.

  async function flushMicrotasks() {
    // streamChat resolves async; the .then()/.catch() handlers run on the next
    // microtask cycle. Two awaits is enough for the chained `getLatestLeaf` +
    // `bus.emit` to complete.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  test("emits agent:complete with parentConversationId after streamChat resolves", async () => {
    mockGetActiveRunResult = null;
    // Reply leaf the handler reads to build the result preview
    mockGetLatestLeaf.mockImplementation(async () => ({ id: "leaf-after", content: "agent reply text" } as any));

    await POST(makeEvent("sub-conv-1"));
    await flushMicrotasks();

    const completeCall = mockBusEmit.mock.calls.find((c) => c[0] === "agent:complete");
    expect(completeCall).toBeDefined();
    expect(completeCall![1]).toMatchObject({
      subConversationId: "sub-conv-1",
      parentConversationId: "parent-conv-1",
      agentName: "TestAgent",
      agentConfigId: "agent-cfg-1",
      success: true,
    });
    expect((completeCall![1] as any).resultPreview).toContain("agent reply text");
  });

  test("emits agent:complete with success=false when streamChat rejects", async () => {
    mockGetActiveRunResult = null;
    mockStreamChat.mockImplementation(async () => {
      throw new Error("model timeout");
    });

    await POST(makeEvent("sub-conv-1"));
    await flushMicrotasks();

    const completeCall = mockBusEmit.mock.calls.find((c) => c[0] === "agent:complete");
    expect(completeCall).toBeDefined();
    expect(completeCall![1]).toMatchObject({
      subConversationId: "sub-conv-1",
      parentConversationId: "parent-conv-1",
      success: false,
    });
    expect((completeCall![1] as any).resultPreview).toContain("model timeout");
  });

  test("does NOT emit agent:complete when message is queued (agent already running)", async () => {
    mockGetActiveRunResult = mockActiveRun;
    await POST(makeEvent("sub-conv-1"));
    await flushMicrotasks();

    const completeCall = mockBusEmit.mock.calls.find((c) => c[0] === "agent:complete");
    expect(completeCall).toBeUndefined();
  });

  test("agent:complete carries the same runId as agent:spawn", async () => {
    mockGetActiveRunResult = null;
    mockGetLatestLeaf.mockImplementation(async () => ({ id: "leaf-after", content: "ok" } as any));

    await POST(makeEvent("sub-conv-1"));
    await flushMicrotasks();

    const spawn = mockBusEmit.mock.calls.find((c) => c[0] === "agent:spawn");
    const complete = mockBusEmit.mock.calls.find((c) => c[0] === "agent:complete");
    expect(spawn).toBeDefined();
    expect(complete).toBeDefined();
    expect((complete![1] as any).runId).toBe((spawn![1] as any).runId);
  });

  // ── Multi-level parent walk (the team-member case the user reported) ─
  //
  // Teams nest: main-conv → orchestrator-sub-conv → member-sub-conv.
  // When the user chats privately with a TEAM MEMBER through the team
  // panel's drill-down view, member-sub-conv.parentConversationId points
  // to orchestrator-sub-conv, NOT the user's main chat. If we emit
  // agent:complete with the orchestrator id, the chat page's listener
  // (which filters by main convId) ignores it — and the main thread
  // never refreshes. These tests pin that we walk to the ROOT and emit
  // the user's main chat id, so the listener actually fires.

  describe("nested team-member sub-conversation (multi-level parent)", () => {
    beforeEach(() => {
      // Override the conversation lookup to model:
      //   member-sub-conv → orchestrator-sub-conv → main-conv (user-owned)
      mockGetConversation.mockImplementation(async (id: string) => {
        if (id === "member-sub-conv") {
          return {
            id: "member-sub-conv",
            userId: null,
            projectId: "proj-1",
            parentConversationId: "orchestrator-sub-conv",
            agentConfigId: "member-cfg",
            systemPrompt: "Member agent",
            model: null,
            provider: null,
          } as any;
        }
        if (id === "orchestrator-sub-conv") {
          return {
            id: "orchestrator-sub-conv",
            userId: null, // orchestrator is system-owned, not user-owned
            projectId: "proj-1",
            parentConversationId: "main-conv",
            agentConfigId: "team-cfg",
            systemPrompt: null,
            model: null,
            provider: null,
          } as any;
        }
        if (id === "main-conv") {
          return {
            id: "main-conv",
            userId: "user-1", // root: owned by the user
            projectId: "proj-1",
            parentConversationId: null,
            agentConfigId: null,
            systemPrompt: null,
            model: "claude-sonnet",
            provider: "anthropic",
          } as any;
        }
        return null;
      });
      mockAgentConfig = { id: "member-cfg", name: "MemberAgent", prompt: "..." };
    });

    test("auth passes when the ROOT (not direct parent) is owned by the user", async () => {
      const res = await POST(makeEvent("member-sub-conv"));
      expect(res.status).toBe(200); // would be 404 if we only checked direct parent
    });

    test("emits agent:spawn with parentConversationId = ROOT main-conv (not orchestrator)", async () => {
      await POST(makeEvent("member-sub-conv"));

      const spawn = mockBusEmit.mock.calls.find((c) => c[0] === "agent:spawn");
      expect(spawn).toBeDefined();
      expect((spawn![1] as any).parentConversationId).toBe("main-conv");
      // Regression guard: this used to be "orchestrator-sub-conv"
      expect((spawn![1] as any).parentConversationId).not.toBe("orchestrator-sub-conv");
    });

    test("emits agent:complete with parentConversationId = ROOT main-conv (the user's chat page can match this)", async () => {
      mockGetLatestLeaf.mockImplementation(async (cid: string) => {
        if (cid === "member-sub-conv") return { id: "leaf", content: "member done" } as any;
        return null;
      });

      await POST(makeEvent("member-sub-conv"));
      await flushMicrotasks();

      const complete = mockBusEmit.mock.calls.find((c) => c[0] === "agent:complete");
      expect(complete).toBeDefined();
      expect((complete![1] as any).parentConversationId).toBe("main-conv");
      // Regression guard: pre-fix this was "orchestrator-sub-conv" so the
      // chat page filter `parentConversationId !== convId` always rejected it
      expect((complete![1] as any).parentConversationId).not.toBe("orchestrator-sub-conv");
    });

    test("auth FAILS when the root is not owned by the user (and user is not admin)", async () => {
      mockGetConversation.mockImplementation(async (id: string) => {
        if (id === "member-sub-conv") {
          return { id: "member-sub-conv", userId: null, projectId: "p", parentConversationId: "orchestrator-sub-conv", agentConfigId: "x", systemPrompt: null } as any;
        }
        if (id === "orchestrator-sub-conv") {
          return { id: "orchestrator-sub-conv", userId: null, projectId: "p", parentConversationId: "main-conv", agentConfigId: null, systemPrompt: null } as any;
        }
        if (id === "main-conv") {
          return { id: "main-conv", userId: "different-user", projectId: "p", parentConversationId: null, agentConfigId: null, systemPrompt: null } as any;
        }
        return null;
      });

      const res = await POST(makeEvent("member-sub-conv"));
      expect(res.status).toBe(404);
    });

    test("walk terminates safely on a parent cycle (no infinite loop)", async () => {
      // Deliberately construct a 2-node cycle: A → B → A.
      // The bounded loop should give up and check whatever it found.
      mockGetConversation.mockImplementation(async (id: string) => {
        if (id === "cycle-a") {
          return { id: "cycle-a", userId: "user-1", projectId: "p", parentConversationId: "cycle-b", agentConfigId: "x", systemPrompt: null } as any;
        }
        if (id === "cycle-b") {
          return { id: "cycle-b", userId: "user-1", projectId: "p", parentConversationId: "cycle-a", agentConfigId: null, systemPrompt: null } as any;
        }
        return null;
      });

      // Should return a response (not hang). We don't care which status —
      // the contract is "doesn't infinite-loop the request".
      const res = await POST(makeEvent("cycle-a"));
      expect(res).toBeInstanceOf(Response);
    });
  });
});
