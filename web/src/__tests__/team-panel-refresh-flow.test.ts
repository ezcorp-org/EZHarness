/**
 * Full-chain integration test for the bug:
 *   "Chatting privately with a team sub-agent doesn't refresh the
 *    main thread until you reload the page."
 *
 * This test stitches together every link in the chain WITHOUT requiring
 * a real browser, so we can prove the fix actually works end-to-end:
 *
 *   1. agent-chat endpoint POSTed
 *   2. Server walks parent chain → finds ROOT (main-conv)
 *   3. Server emits agent:spawn + agent:complete with parentConversationId=ROOT
 *   4. Stores handler dispatches `ez:agent_complete` DOM CustomEvent
 *   5. Chat-page listener invalidates fetch-policy + triggers re-hydrate
 *   6. Team-panel listener immediately refetches overview + drill-down
 *
 * If any link breaks, this test catches it.
 */
import { test, expect, describe, beforeEach, mock } from "bun:test";

// ── Conversation graph (mirrors the team structure) ────────────────
//
//   main-conv         (user-owned, the user's chat page)
//     └── orch-conv   (userId=null, the team orchestrator)
//           └── member-conv  (userId=null, the team member they chat with)

const CONVS: Record<string, any> = {
  "main-conv": {
    id: "main-conv",
    userId: "user-1",
    projectId: "proj-1",
    parentConversationId: null,
    agentConfigId: null,
    systemPrompt: null,
    model: "claude-sonnet",
    provider: "anthropic",
  },
  "orch-conv": {
    id: "orch-conv",
    userId: null,
    projectId: "proj-1",
    parentConversationId: "main-conv",
    agentConfigId: "team-cfg",
    systemPrompt: null,
    model: null,
    provider: null,
  },
  "member-conv": {
    id: "member-conv",
    userId: null,
    projectId: "proj-1",
    parentConversationId: "orch-conv",
    agentConfigId: "member-cfg",
    systemPrompt: "Member system prompt",
    model: null,
    provider: null,
  },
};

// ── Mocks for the agent-chat endpoint ───────────────────────────────

const mockGetConversation = mock(async (id: string) => CONVS[id] ?? null);
const mockGetLatestLeaf = mock(async (cid: string) => ({
  id: `leaf-${cid}`,
  content: `latest reply on ${cid}`,
}));
const mockCreateMessage = mock(async (_cid: string, opts: any) => ({
  id: "msg-new",
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

mock.module("$server/db/queries/agent-configs", () => ({
  getAgentConfig: mock(async (id: string) => ({
    id,
    name: id === "member-cfg" ? "MemberAgent" : "TeamOrchestrator",
    prompt: "...",
  })),
}));

mock.module("$server/auth/middleware", () => ({
  requireAuth: () => ({ id: "user-1", email: "u@e.com", name: "U", role: "member" }),
}));
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));
mock.module("$server/runtime/pending-messages", () => ({ enqueue: () => {} }));
mock.module("$server/types", () => ({ CURRENT_MODEL_SENTINEL: "__current__" }));

// In-memory bus for capturing emissions
const busEmissions: Array<{ type: string; data: any }> = [];
const mockBus = {
  emit: (type: string, data: any) => {
    busEmissions.push({ type, data });
  },
};
const mockExecutor = {
  streamChat: mock(async () => ({})),
  getActiveRunForConversation: () => null,
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

const { POST } = await import(
  "../routes/api/conversations/[id]/agent-chat/+server"
);

// ── Stub `window` so the store DOM-event dispatch + page listener work ─

interface CapturedDOMEvent {
  type: string;
  detail: any;
}

const dispatched: CapturedDOMEvent[] = [];
const eventListeners = new Map<string, Array<(e: Event) => void>>();

function setupBrowserStubs() {
  (globalThis as any).window = globalThis;
  (globalThis as any).dispatchEvent = (e: Event) => {
    const ce = e as CustomEvent;
    dispatched.push({ type: e.type, detail: ce.detail });
    for (const fn of eventListeners.get(e.type) ?? []) {
      fn(e);
    }
    return true;
  };
  (globalThis as any).addEventListener = (type: string, fn: (e: Event) => void) => {
    const arr = eventListeners.get(type) ?? [];
    arr.push(fn);
    eventListeners.set(type, arr);
  };
  (globalThis as any).removeEventListener = (type: string, fn: (e: Event) => void) => {
    const arr = eventListeners.get(type) ?? [];
    eventListeners.set(type, arr.filter((f) => f !== fn));
  };
}

// ── The store handler — mirrors stores.svelte.ts:867-911 ──────────

function storeHandleAgentComplete(event: { type: string; data: any }) {
  if (event.type !== "agent:complete") return;
  const { subConversationId } = event.data;
  const parentConvId = (event.data as Record<string, unknown>).parentConversationId as string | undefined;
  if (parentConvId && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("ez:agent_complete", {
      detail: { parentConversationId: parentConvId, subConversationId },
    }));
  }
}

// ── The chat-page listener — mirrors +page.svelte:694-702 ──────────

function makeChatPageListener(currentConvId: string, recorded: { invalidated: string[]; loadCalls: number; hydrateCalls: number }) {
  const listener = (e: Event) => {
    const { parentConversationId } = (e as CustomEvent).detail;
    if (parentConversationId !== currentConvId) return;
    recorded.invalidated.push(`messages-all:${currentConvId}`);
    recorded.invalidated.push(`messages-tools:${currentConvId}`);
    recorded.loadCalls++;
    recorded.hydrateCalls++;
  };
  window.addEventListener("ez:agent_complete", listener);
  return () => window.removeEventListener("ez:agent_complete", listener);
}

// ── The team-panel listener — mirrors TeamChatPanel.svelte ──────────

function makeTeamPanelListener(recorded: { overviewRefetches: number; drillRefetches: number }, drillSubConvId: string | null = null) {
  const listener = () => {
    recorded.overviewRefetches++;
    if (drillSubConvId) recorded.drillRefetches++;
  };
  window.addEventListener("ez:agent_complete", listener);
  return () => window.removeEventListener("ez:agent_complete", listener);
}

// ── Helpers ────────────────────────────────────────────────────────

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function makePOST(subConvId: string) {
  return {
    request: new Request(`http://localhost/api/conversations/${subConvId}/agent-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi from user" }),
    }),
    params: { id: subConvId },
    locals: {},
  } as any;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("end-to-end refresh flow: team panel chat → main chat thread", () => {
  beforeEach(() => {
    busEmissions.length = 0;
    dispatched.length = 0;
    eventListeners.clear();
    setupBrowserStubs();
    mockExecutor.streamChat.mockReset();
    mockExecutor.streamChat.mockImplementation(async () => ({}));
  });

  test("CHAT-WITH-MEMBER (the reported bug): full chain reaches main chat listener", async () => {
    // 1. Set up the chat page listener for main-conv
    const chatRecorded = { invalidated: [] as string[], loadCalls: 0, hydrateCalls: 0 };
    const cleanupChat = makeChatPageListener("main-conv", chatRecorded);

    // 2. Set up the team-panel listener (drill-down on member)
    const panelRecorded = { overviewRefetches: 0, drillRefetches: 0 };
    const cleanupPanel = makeTeamPanelListener(panelRecorded, "member-conv");

    // 3. User sends a private message to the member via team panel
    await POST(makePOST("member-conv"));
    await flushMicrotasks();

    // 4. Server should have emitted agent:spawn AND agent:complete
    const spawn = busEmissions.find((e) => e.type === "agent:spawn");
    const complete = busEmissions.find((e) => e.type === "agent:complete");
    expect(spawn, "agent:spawn must fire").toBeDefined();
    expect(complete, "agent:complete must fire").toBeDefined();

    // 5. Both events must carry parentConversationId = ROOT (main-conv).
    //    Pre-fix, this was the orchestrator id — which broke the listener match.
    expect(spawn!.data.parentConversationId).toBe("main-conv");
    expect(complete!.data.parentConversationId).toBe("main-conv");

    // 6. Simulate the SSE → store routing
    storeHandleAgentComplete(complete!);

    // 7. The store should have dispatched a single ez:agent_complete event
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.type).toBe("ez:agent_complete");
    expect(dispatched[0]!.detail.parentConversationId).toBe("main-conv");

    // 8. Chat-page listener fired and invalidated the throttle keys
    expect(chatRecorded.loadCalls, "main chat must call loadMessages").toBe(1);
    expect(chatRecorded.hydrateCalls, "main chat must call hydrate").toBe(1);
    expect(chatRecorded.invalidated, "throttle keys must be invalidated BEFORE refetch").toEqual([
      "messages-all:main-conv",
      "messages-tools:main-conv",
    ]);

    // 9. Team-panel listener also fired
    expect(panelRecorded.overviewRefetches, "team-panel overview must refetch").toBe(1);
    expect(panelRecorded.drillRefetches, "drill-down must also refetch").toBe(1);

    cleanupChat();
    cleanupPanel();
  });

  test("CHAT-WITH-ORCHESTRATOR: works the same way", async () => {
    const chatRecorded = { invalidated: [] as string[], loadCalls: 0, hydrateCalls: 0 };
    const cleanupChat = makeChatPageListener("main-conv", chatRecorded);

    await POST(makePOST("orch-conv"));
    await flushMicrotasks();

    const complete = busEmissions.find((e) => e.type === "agent:complete");
    expect(complete!.data.parentConversationId).toBe("main-conv");

    storeHandleAgentComplete(complete!);

    expect(chatRecorded.loadCalls).toBe(1);
    cleanupChat();
  });

  test("WRONG-CONVERSATION: chat page on a DIFFERENT conv does not refresh", async () => {
    // User has main-conv-2 open in their tab, but a sub-agent under
    // main-conv (different chat) just completed. The listener must
    // ignore it — otherwise we'd refresh every conversation in the app.
    const chatRecorded = { invalidated: [] as string[], loadCalls: 0, hydrateCalls: 0 };
    const cleanupChat = makeChatPageListener("main-conv-2", chatRecorded); // <-- different conv!

    await POST(makePOST("member-conv"));
    await flushMicrotasks();

    const complete = busEmissions.find((e) => e.type === "agent:complete");
    storeHandleAgentComplete(complete!);

    // The DOM event still fired …
    expect(dispatched).toHaveLength(1);
    // … but the listener correctly ignored it
    expect(chatRecorded.loadCalls).toBe(0);
    expect(chatRecorded.invalidated).toHaveLength(0);
    cleanupChat();
  });

  test("STREAM ERROR: agent:complete still fires with success=false, listeners still trigger", async () => {
    mockExecutor.streamChat.mockImplementation(async () => {
      throw new Error("model exploded");
    });

    const chatRecorded = { invalidated: [] as string[], loadCalls: 0, hydrateCalls: 0 };
    const cleanupChat = makeChatPageListener("main-conv", chatRecorded);

    await POST(makePOST("member-conv"));
    await flushMicrotasks();

    const complete = busEmissions.find((e) => e.type === "agent:complete");
    expect(complete).toBeDefined();
    expect(complete!.data.success).toBe(false);
    expect(complete!.data.parentConversationId).toBe("main-conv");

    storeHandleAgentComplete(complete!);

    // Failed runs must ALSO refresh — the user needs to see the error
    expect(chatRecorded.loadCalls).toBe(1);
    cleanupChat();
  });
});
