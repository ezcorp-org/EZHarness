/**
 * `src/runtime/chat-graph/load.ts` — the subsystem's only IO layer.
 *
 * The graph ALGEBRA is pinned by the two pure-builder suites; this one
 * pins the seam: which queries run, how DB row shapes are mapped onto the
 * builder inputs, and — the load-bearing behaviour — that a missing
 * session tree DEGRADES to the flat `messages.parentMessageId` chain
 * instead of propagating `/tree`'s 409.
 *
 * DB collaborators are stubbed with `mock.module` declared BEFORE the SUT
 * import, mirroring `finalize-error-persist-slot.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

const T0 = Date.parse("2026-07-26T12:00:00.000Z");
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

interface StubMessage {
  id: string;
  role: string;
  content: string;
  thinkingContent: string | null;
  parentMessageId: string | null;
  excluded: boolean;
  createdAt: Date;
  toolCalls: Array<Record<string, unknown>>;
}

const state = {
  messages: [] as StubMessage[],
  subConversations: [] as Array<Record<string, unknown>>,
  observability: [] as Array<Record<string, unknown>>,
  producerEnabled: true,
  treeNodes: [] as Array<Record<string, unknown>>,
  treeThrows: false,
};

const calls = { messagesWithToolCalls: 0, observability: 0, sessionTree: 0 };

mock.module("../db/queries/conversations", () => ({
  getMessagesWithToolCalls: async () => {
    calls.messagesWithToolCalls++;
    return {
      messages: state.messages,
      subConversations: state.subConversations,
      orphanedToolCalls: [],
    };
  },
}));

mock.module("../db/queries/observability", () => ({
  getConversationObservability: async () => {
    calls.observability++;
    return state.observability;
  },
}));

mock.module("../db/session-sync", () => ({
  isSessionHistoryProducerEnabled: async () => state.producerEnabled,
  computeSessionTree: async (conversationId: string) => {
    calls.sessionTree++;
    if (state.treeThrows) throw new Error("session storage unavailable");
    return { conversationId, currentLeaf: null, nodes: state.treeNodes };
  },
}));

const { loadConversationGraph, loadTurnGraph } = await import("../runtime/chat-graph/load");

function message(
  id: string,
  role: string,
  seconds: number,
  parentMessageId: string | null,
  extra: Partial<StubMessage> = {},
): StubMessage {
  return {
    id,
    role,
    content: `${id} text`,
    thinkingContent: null,
    parentMessageId,
    excluded: false,
    createdAt: at(seconds),
    toolCalls: [],
    ...extra,
  };
}

/** A `ToolCallSummary` as `getMessagesWithToolCalls` returns it. */
function toolCall(
  id: string,
  messageId: string,
  toolName: string,
  seconds: number,
  durationMs = 0,
) {
  return {
    id,
    extensionId: "builtin",
    toolName,
    input: null,
    outputSummary: null,
    fullOutput: null,
    success: true,
    durationMs,
    status: "success" as const,
    cardType: null,
    cardLayout: null,
    messageId,
    createdAt: at(seconds),
  };
}

/** The default fixture: one turn, one tool call, one spawn. */
function seedConversation(): void {
  state.messages = [
    message("u1", "user", 0, null, { content: "why is the sky blue" }),
    message("a1", "assistant", 5, "u1", {
      thinkingContent: "rayleigh scattering",
      toolCalls: [toolCall("tc-1", "a1", "search", 2)],
    }),
    message("u2", "user", 6, "a1"),
  ];
  state.subConversations = [
    {
      id: "sub-1",
      agentName: "researcher",
      agentConfigId: "ac-1",
      messageCount: 4,
      lastMessagePreview: "done",
      parentMessageId: "a1",
    },
  ];
  state.treeNodes = state.messages.map((m) => ({
    id: m.id,
    parentId: m.parentMessageId,
    role: m.role,
    excluded: m.excluded,
    createdAt: m.createdAt.toISOString(),
  }));
}

beforeEach(() => {
  state.messages = [];
  state.subConversations = [];
  state.observability = [];
  state.treeNodes = [];
  state.producerEnabled = true;
  state.treeThrows = false;
  calls.messagesWithToolCalls = 0;
  calls.observability = 0;
  calls.sessionTree = 0;
});

describe("loadConversationGraph", () => {
  test("joins the session tree, messages and sub-conversations into level 1", async () => {
    seedConversation();
    const graph = await loadConversationGraph("conv-1");
    expect(calls.sessionTree).toBe(1);
    expect(graph.level).toBe(1);
    expect(graph.conversationId).toBe("conv-1");
    expect(graph.degraded).toBeUndefined();
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "u2", "sub-1"]);
    expect(graph.nodes[0]!.label).toBe("why is the sky blue");
    expect(graph.edges).toEqual([
      { from: "u1", to: "u2", kind: "sequence" },
      { from: "u1", to: "sub-1", kind: "spawn" },
    ]);
  });

  test("an empty conversation returns an empty graph without a null crash", async () => {
    const graph = await loadConversationGraph("conv-empty");
    expect(graph.nodes).toEqual([]);
    expect(graph.rootId).toBeNull();
  });

  test("producer flag OFF → flat chain from parentMessageId, degraded, tree never read", async () => {
    seedConversation();
    state.producerEnabled = false;
    const graph = await loadConversationGraph("conv-1");
    expect(calls.sessionTree).toBe(0);
    expect(graph.degraded).toBe(true);
    // Level 1 still works: same prompts, same edges.
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "u2", "sub-1"]);
    expect(graph.edges).toContainEqual({ from: "u1", to: "u2", kind: "sequence" });
  });

  test("degraded mode preserves the live excluded flag", async () => {
    state.producerEnabled = false;
    state.messages = [
      message("u1", "user", 0, null),
      message("a1", "assistant", 1, "u1"),
      message("u2", "user", 2, "a1", { excluded: true }),
    ];
    const graph = await loadConversationGraph("conv-1");
    expect(graph.nodes.find((n) => n.id === "u2")!.excluded).toBe(true);
  });

  test("a session-tree read that throws degrades instead of failing the request", async () => {
    seedConversation();
    state.treeThrows = true;
    const graph = await loadConversationGraph("conv-1");
    expect(calls.sessionTree).toBe(1);
    expect(graph.degraded).toBe(true);
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "u2", "sub-1"]);
  });

  test("a non-Error throw still degrades (the String() fallback)", async () => {
    seedConversation();
    mock.module("../db/session-sync", () => ({
      isSessionHistoryProducerEnabled: async () => true,
      computeSessionTree: async () => {
        throw "storage offline";
      },
    }));
    const graph = await loadConversationGraph("conv-1");
    expect(graph.degraded).toBe(true);
  });
});

describe("loadTurnGraph", () => {
  beforeEach(() => {
    // Re-register the well-behaved session-sync stub after the non-Error
    // throw case above replaced it.
    mock.module("../db/session-sync", () => ({
      isSessionHistoryProducerEnabled: async () => state.producerEnabled,
      computeSessionTree: async (conversationId: string) => {
        calls.sessionTree++;
        if (state.treeThrows) throw new Error("session storage unavailable");
        return { conversationId, currentLeaf: null, nodes: state.treeNodes };
      },
    }));
  });

  test("maps rows into level 2 and never reads the session tree", async () => {
    seedConversation();
    state.observability = [
      {
        id: "ev-1",
        eventType: "tool_call",
        messageId: null,
        data: { toolName: "search" },
        durationMs: 750,
        createdAt: at(2),
      },
      {
        id: "ev-2",
        eventType: "turn_summary",
        messageId: "a1",
        data: {},
        durationMs: 4000,
        createdAt: at(5),
      },
    ];
    const graph = await loadTurnGraph("conv-1", "u1");
    expect(graph).not.toBeNull();
    expect(calls.observability).toBe(1);
    // Level 2 reads topology from `messages.parentMessageId`, so it never
    // needs the session tree — and never 409s.
    expect(calls.sessionTree).toBe(0);
    expect(graph!.level).toBe(2);
    expect(graph!.rootId).toBe("u1");
    expect(graph!.nodes.map((n) => n.id)).toEqual(["u1", "thinking:a1", "tc-1", "a1", "sub-1"]);
    // durationMs 0 in the column → adopted from the observability row.
    expect(graph!.nodes.find((n) => n.id === "tc-1")!.durationMs).toBe(750);
    expect(graph!.nodes.find((n) => n.id === "a1")!.durationMs).toBe(4000);
  });

  test("an observability row with a null data payload does not throw", async () => {
    seedConversation();
    state.observability = [
      {
        id: "ev-null",
        eventType: "tool_call",
        messageId: null,
        data: null,
        durationMs: 10,
        createdAt: at(2),
      },
    ];
    const graph = await loadTurnGraph("conv-1", "u1");
    expect(graph!.nodes.find((n) => n.id === "tc-1")!.durationMs).toBeUndefined();
  });

  test("a turn id that is not a user message of this conversation returns null", async () => {
    seedConversation();
    // Only THIS conversation's rows are ever fetched, so an id from another
    // conversation simply is not found — the route turns that into a 404.
    expect(await loadTurnGraph("conv-1", "u-from-another-conversation")).toBeNull();
    expect(await loadTurnGraph("conv-1", "a1")).toBeNull();
  });
});
