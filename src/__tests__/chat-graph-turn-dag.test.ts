/**
 * `src/runtime/chat-graph/build-turn-dag.ts` — LEVEL 2.
 *
 * Pure builder, hand-built rows. The cases that matter are the ones where
 * the level-2 rules are easy to get subtly wrong:
 *   - the turn SLICE (where a turn stops, and what the window bounds are)
 *   - the reconstruction order (thinking → tools → assistant text)
 *   - the POSITIONAL observability duration zip, including two calls to the
 *     SAME tool name, and `tool_calls.durationMs === 0` meaning UNKNOWN
 *   - branch structure inside one turn (an A-B retry's sibling assistants)
 *   - spawns and `run_error` rows, neither of which carries a message id
 */

import { describe, expect, test } from "bun:test";
import {
  buildTurnDag,
  type TurnDagInput,
  type TurnDagMessage,
  type TurnDagObservabilityEvent,
  type TurnDagToolCall,
} from "../runtime/chat-graph/build-turn-dag";

const T0 = Date.parse("2026-07-26T12:00:00.000Z");

function at(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

function msg(
  id: string,
  role: string,
  seconds: number,
  parentMessageId: string | null,
  extra: Partial<TurnDagMessage> = {},
): TurnDagMessage {
  return {
    id,
    role,
    content: `${id} text`,
    thinkingContent: null,
    parentMessageId,
    createdAt: at(seconds),
    ...extra,
  };
}

function call(
  id: string,
  messageId: string | null,
  toolName: string,
  seconds: number,
  extra: Partial<TurnDagToolCall> = {},
): TurnDagToolCall {
  return {
    id,
    messageId,
    toolName,
    extensionId: "builtin",
    status: "success",
    durationMs: 0,
    createdAt: at(seconds),
    ...extra,
  };
}

function obs(
  id: string,
  eventType: string,
  seconds: number,
  data: Record<string, unknown>,
  durationMs: number | null = null,
  messageId: string | null = null,
): TurnDagObservabilityEvent {
  return { id, eventType, messageId, data, durationMs, createdAt: at(seconds) };
}

function build(input: Partial<TurnDagInput> & Pick<TurnDagInput, "messages" | "turnMessageId">) {
  return buildTurnDag({
    conversationId: "conv-1",
    toolCalls: [],
    subConversations: [],
    observability: [],
    ...input,
  });
}

/** A prompt + one assistant reply, the baseline every case extends. */
const SIMPLE_TURN: TurnDagMessage[] = [
  msg("u1", "user", 0, null),
  msg("a1", "assistant", 5, "u1"),
];

describe("buildTurnDag — turn selection", () => {
  test("an unknown turn id yields null (the route's 404)", () => {
    expect(build({ messages: SIMPLE_TURN, turnMessageId: "nope" })).toBeNull();
  });

  test("a turn id naming a non-user row yields null", () => {
    expect(build({ messages: SIMPLE_TURN, turnMessageId: "a1" })).toBeNull();
  });

  test("a prompt with no reply at all is a single-node graph", () => {
    const graph = build({ messages: [msg("u1", "user", 0, null)], turnMessageId: "u1" })!;
    expect(graph.level).toBe(2);
    expect(graph.rootId).toBe("u1");
    expect(graph.conversationId).toBe("conv-1");
    expect(graph.nodes).toEqual([
      { label: "u1 text", id: "u1", kind: "prompt", status: "success", createdAt: at(0) },
    ]);
    expect(graph.edges).toEqual([]);
  });

  test("the level-2 prompt is NOT drillable — it is already the root", () => {
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1" })!;
    expect(graph.nodes[0]!.drillable).toBeUndefined();
  });

  test("the turn stops at the next user row", () => {
    const messages = [
      msg("u1", "user", 0, null),
      msg("a1", "assistant", 1, "u1"),
      msg("u2", "user", 2, "a1"),
      msg("a2", "assistant", 3, "u2"),
    ];
    const graph = build({ messages, turnMessageId: "u1" })!;
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "a1"]);
  });

  test("a root-level row with no parent never joins another turn", () => {
    const messages = [msg("u1", "user", 0, null), msg("orphan", "extension", 1, null)];
    const graph = build({ messages, turnMessageId: "u1" })!;
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1"]);
  });

  test("synthetic rows inside the turn are members but not nodes", () => {
    const messages = [
      msg("u1", "user", 0, null),
      msg("pre1", "preprocess-result", 1, "u1"),
      msg("a1", "assistant", 2, "pre1"),
    ];
    const graph = build({ messages, turnMessageId: "u1" })!;
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "a1"]);
    // The assistant still anchors to the prompt, through the synthetic row.
    expect(graph.edges).toEqual([{ from: "u1", to: "a1", kind: "sequence" }]);
  });
});

describe("buildTurnDag — reconstruction order", () => {
  test("thinking → tool calls by createdAt → assistant text", () => {
    const messages = [msg("u1", "user", 0, null), msg("a1", "assistant", 9, "u1", { thinkingContent: "let me check" })];
    const toolCalls = [call("tc-2", "a1", "write", 4), call("tc-1", "a1", "read", 2)];
    const graph = build({ messages, turnMessageId: "u1", toolCalls })!;
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "thinking:a1", "tc-1", "tc-2", "a1"]);
    expect(graph.edges).toEqual([
      { from: "u1", to: "thinking:a1", kind: "sequence" },
      { from: "thinking:a1", to: "tc-1", kind: "sequence" },
      { from: "tc-1", to: "tc-2", kind: "sequence" },
      { from: "tc-2", to: "a1", kind: "sequence" },
    ]);
  });

  test("no thinking node when thinkingContent is absent or whitespace", () => {
    const blank = build({
      messages: [msg("u1", "user", 0, null), msg("a1", "assistant", 1, "u1", { thinkingContent: "   \n " })],
      turnMessageId: "u1",
    })!;
    expect(blank.nodes.some((n) => n.kind === "thinking")).toBe(false);
    const none = build({ messages: SIMPLE_TURN, turnMessageId: "u1" })!;
    expect(none.nodes.some((n) => n.kind === "thinking")).toBe(false);
  });

  test("at most ONE thinking node per assistant message", () => {
    const messages = [
      msg("u1", "user", 0, null),
      msg("a1", "assistant", 1, "u1", { thinkingContent: "step one\n\nstep two\n\nstep three" }),
    ];
    const graph = build({ messages, turnMessageId: "u1" })!;
    expect(graph.nodes.filter((n) => n.kind === "thinking")).toHaveLength(1);
    expect(graph.nodes[1]!.id).toBe("thinking:a1");
    // The blob is stored on the assistant row, so it carries that timestamp.
    expect(graph.nodes[1]!.createdAt).toBe(at(1));
  });

  test("a turn with zero tool calls is prompt → assistant", () => {
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1" })!;
    expect(graph.nodes.map((n) => n.kind)).toEqual(["prompt", "assistant"]);
    expect(graph.edges).toEqual([{ from: "u1", to: "a1", kind: "sequence" }]);
  });

  test("a multi-step run chains the second assistant after the first", () => {
    const messages = [
      msg("u1", "user", 0, null),
      msg("a1", "assistant", 2, "u1"),
      msg("a2", "assistant", 6, "a1"),
    ];
    const toolCalls = [call("tc-1", "a1", "read", 1), call("tc-2", "a2", "write", 4)];
    const graph = build({ messages, turnMessageId: "u1", toolCalls })!;
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "tc-1", "a1", "tc-2", "a2"]);
    expect(graph.edges).toEqual([
      { from: "u1", to: "tc-1", kind: "sequence" },
      { from: "tc-1", to: "a1", kind: "sequence" },
      { from: "a1", to: "tc-2", kind: "sequence" },
      { from: "tc-2", to: "a2", kind: "sequence" },
    ]);
  });

  test("tool calls belonging to another message are not pulled in", () => {
    const messages = [
      msg("u1", "user", 0, null),
      msg("a1", "assistant", 2, "u1"),
      msg("u2", "user", 3, "a1"),
      msg("a2", "assistant", 5, "u2"),
    ];
    const toolCalls = [call("tc-mine", "a1", "read", 1), call("tc-theirs", "a2", "read", 4)];
    const graph = build({ messages, turnMessageId: "u1", toolCalls })!;
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "tc-mine", "a1"]);
  });

  test("an unanchored (orphaned) tool call is skipped", () => {
    const toolCalls = [call("tc-orphan", null, "read", 1)];
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1", toolCalls })!;
    expect(graph.nodes.some((n) => n.kind === "tool")).toBe(false);
  });

  test("a tool node carries its extension id and status", () => {
    const toolCalls = [call("tc-1", "a1", "search", 1, { extensionId: "ext-web", status: "error" })];
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1", toolCalls })!;
    const tool = graph.nodes.find((n) => n.id === "tc-1")!;
    expect(tool.extensionId).toBe("ext-web");
    expect(tool.status).toBe("error");
    expect(tool.label).toBe("search");
  });
});

describe("buildTurnDag — durations", () => {
  test("a non-zero tool_calls column value is used as-is", () => {
    const toolCalls = [call("tc-1", "a1", "search", 1, { durationMs: 1234 })];
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1", toolCalls })!;
    expect(graph.nodes.find((n) => n.id === "tc-1")!.durationMs).toBe(1234);
  });

  test("durationMs === 0 with no observability row is ABSENT, never 0", () => {
    const toolCalls = [call("tc-1", "a1", "search", 1)];
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1", toolCalls })!;
    const tool = graph.nodes.find((n) => n.id === "tc-1")!;
    expect(tool.durationMs).toBeUndefined();
    expect("durationMs" in tool).toBe(false);
  });

  test("durationMs === 0 adopts a matching observability row's real duration", () => {
    const toolCalls = [call("tc-1", "a1", "search", 1)];
    const observability = [obs("ev-1", "tool_call", 1, { toolName: "search" }, 420)];
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1", toolCalls, observability })!;
    expect(graph.nodes.find((n) => n.id === "tc-1")!.durationMs).toBe(420);
  });

  test("two calls to the SAME tool name zip positionally", () => {
    const toolCalls = [call("tc-1", "a1", "read", 1), call("tc-2", "a1", "read", 2)];
    const observability = [
      obs("ev-1", "tool_call", 1, { toolName: "read" }, 100),
      obs("ev-2", "tool_call", 2, { toolName: "read" }, 200),
    ];
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1", toolCalls, observability })!;
    expect(graph.nodes.find((n) => n.id === "tc-1")!.durationMs).toBe(100);
    expect(graph.nodes.find((n) => n.id === "tc-2")!.durationMs).toBe(200);
  });

  test("buckets are per tool NAME — interleaved names do not cross-contaminate", () => {
    const toolCalls = [
      call("tc-1", "a1", "read", 1),
      call("tc-2", "a1", "write", 2),
      call("tc-3", "a1", "read", 3),
    ];
    const observability = [
      obs("ev-1", "tool_call", 1, { toolName: "read" }, 11),
      obs("ev-2", "tool_error", 2, { toolName: "write" }, 22),
      obs("ev-3", "tool_call", 3, { toolName: "read" }, 33),
    ];
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1", toolCalls, observability })!;
    expect(graph.nodes.find((n) => n.id === "tc-1")!.durationMs).toBe(11);
    expect(graph.nodes.find((n) => n.id === "tc-2")!.durationMs).toBe(22);
    expect(graph.nodes.find((n) => n.id === "tc-3")!.durationMs).toBe(33);
  });

  test("a third call with no counterpart at that index stays unknown", () => {
    const toolCalls = [
      call("tc-1", "a1", "read", 1),
      call("tc-2", "a1", "read", 2),
      call("tc-3", "a1", "read", 3),
    ];
    const observability = [
      obs("ev-1", "tool_call", 1, { toolName: "read" }, 100),
      obs("ev-2", "tool_call", 2, { toolName: "read" }, 200),
    ];
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1", toolCalls, observability })!;
    expect(graph.nodes.find((n) => n.id === "tc-3")!.durationMs).toBeUndefined();
  });

  test("observability rows outside the turn window do not leak in", () => {
    const messages = [
      msg("u1", "user", 0, null),
      msg("a1", "assistant", 2, "u1"),
      msg("u2", "user", 3, "a1"),
      msg("a2", "assistant", 8, "u2"),
    ];
    const toolCalls = [call("tc-1", "a1", "read", 1)];
    // The 5s row belongs to the NEXT turn (which starts at 3s).
    const observability = [obs("ev-late", "tool_call", 5, { toolName: "read" }, 999)];
    const graph = build({ messages, turnMessageId: "u1", toolCalls, observability })!;
    expect(graph.nodes.find((n) => n.id === "tc-1")!.durationMs).toBeUndefined();
  });

  test("an earlier turn's rows do not bound this turn's window", () => {
    const messages = [
      msg("u0", "user", 0, null),
      msg("a0", "assistant", 1, "u0"),
      msg("u1", "user", 2, "a0"),
      msg("a1", "assistant", 6, "u1"),
    ];
    const toolCalls = [call("tc-1", "a1", "read", 4)];
    const observability = [obs("ev-1", "tool_call", 4, { toolName: "read" }, 55)];
    const graph = build({ messages, turnMessageId: "u1", toolCalls, observability })!;
    expect(graph.nodes.find((n) => n.id === "tc-1")!.durationMs).toBe(55);
  });

  test("an observability row with a null duration or no toolName never matches", () => {
    const toolCalls = [call("tc-1", "a1", "read", 1)];
    const observability = [
      obs("ev-bad", "tool_call", 1, { toolName: 42 }, 700),
      obs("ev-null", "tool_call", 1, { toolName: "read" }, null),
    ];
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1", toolCalls, observability })!;
    expect(graph.nodes.find((n) => n.id === "tc-1")!.durationMs).toBeUndefined();
  });

  test("the assistant node adopts its turn_summary duration (keyed by messageId)", () => {
    const observability = [
      obs("ev-sum", "turn_summary", 5, { llmDurationMs: 800 }, 1500, "a1"),
      // A turn_summary with no messageId cannot be attributed and is ignored.
      obs("ev-loose", "turn_summary", 5, {}, 9999, null),
      // A zero duration is unknown, not "instant".
      obs("ev-zero", "turn_summary", 5, {}, 0, "a-other"),
    ];
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1", observability })!;
    expect(graph.nodes.find((n) => n.id === "a1")!.durationMs).toBe(1500);
  });

  test("an assistant with no turn_summary has no duration", () => {
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1" })!;
    expect(graph.nodes.find((n) => n.id === "a1")!.durationMs).toBeUndefined();
  });
});

describe("buildTurnDag — branches inside one turn", () => {
  test("an A-B retry's sibling assistants fan out as branch edges", () => {
    const messages = [
      msg("u1", "user", 0, null),
      msg("a1", "assistant", 2, "u1"),
      msg("a2", "assistant", 4, "u1"),
    ];
    const graph = build({ messages, turnMessageId: "u1" })!;
    expect(graph.edges).toEqual([
      { from: "u1", to: "a1", kind: "branch" },
      { from: "u1", to: "a2", kind: "branch" },
    ]);
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "a1", "a2"]);
  });

  test("each retry leg keeps its own thinking and tool nodes", () => {
    const messages = [
      msg("u1", "user", 0, null),
      msg("a1", "assistant", 3, "u1", { thinkingContent: "attempt one" }),
      msg("a2", "assistant", 7, "u1", { thinkingContent: "attempt two" }),
    ];
    const toolCalls = [call("tc-1", "a1", "read", 1), call("tc-2", "a2", "read", 5)];
    const graph = build({ messages, turnMessageId: "u1", toolCalls })!;
    expect(graph.edges).toContainEqual({ from: "u1", to: "thinking:a1", kind: "branch" });
    expect(graph.edges).toContainEqual({ from: "u1", to: "thinking:a2", kind: "branch" });
    expect(graph.edges).toContainEqual({ from: "thinking:a1", to: "tc-1", kind: "sequence" });
    expect(graph.edges).toContainEqual({ from: "thinking:a2", to: "tc-2", kind: "sequence" });
  });
});

describe("buildTurnDag — sub-agent spawns", () => {
  test("a spawn from an assistant message hangs off that assistant", () => {
    const graph = build({
      messages: SIMPLE_TURN,
      turnMessageId: "u1",
      subConversations: [{ id: "sub-1", agentName: "researcher", parentMessageId: "a1" }],
    })!;
    expect(graph.nodes.find((n) => n.id === "sub-1")).toEqual({
      label: "researcher",
      id: "sub-1",
      kind: "subagent",
      status: "success",
      createdAt: at(5),
      drillable: true,
      subConversationId: "sub-1",
    });
    expect(graph.edges).toContainEqual({ from: "a1", to: "sub-1", kind: "spawn" });
  });

  test("an unnamed agent falls back to a readable label", () => {
    const graph = build({
      messages: SIMPLE_TURN,
      turnMessageId: "u1",
      subConversations: [{ id: "sub-1", agentName: null, parentMessageId: "a1" }],
    })!;
    expect(graph.nodes.find((n) => n.id === "sub-1")!.label).toBe("sub-agent");
  });

  test("a spawn anchored to a synthetic row falls back to the prompt", () => {
    const messages = [
      msg("u1", "user", 0, null),
      msg("ext1", "extension", 1, "u1"),
      msg("a1", "assistant", 2, "ext1"),
    ];
    const graph = build({
      messages,
      turnMessageId: "u1",
      subConversations: [{ id: "sub-1", agentName: "helper", parentMessageId: "ext1" }],
    })!;
    expect(graph.edges).toContainEqual({ from: "u1", to: "sub-1", kind: "spawn" });
  });

  test("spawns outside this turn (or with no parent) are excluded", () => {
    const messages = [
      msg("u1", "user", 0, null),
      msg("a1", "assistant", 2, "u1"),
      msg("u2", "user", 3, "a1"),
      msg("a2", "assistant", 4, "u2"),
    ];
    const graph = build({
      messages,
      turnMessageId: "u1",
      subConversations: [
        { id: "sub-other", agentName: "next turn", parentMessageId: "a2" },
        { id: "sub-loose", agentName: "no parent", parentMessageId: null },
      ],
    })!;
    expect(graph.nodes.some((n) => n.kind === "subagent")).toBe(false);
  });

  test("an agent_error row marks that sub-agent's node as failed", () => {
    const observability = [
      obs("ev-err", "agent_error", 5, { subConversationId: "sub-1" }),
      // A malformed row must not throw or mark anything.
      obs("ev-junk", "agent_error", 5, { subConversationId: 7 }),
    ];
    const graph = build({
      messages: SIMPLE_TURN,
      turnMessageId: "u1",
      subConversations: [
        { id: "sub-1", agentName: "failed", parentMessageId: "a1" },
        { id: "sub-2", agentName: "fine", parentMessageId: "a1" },
      ],
      observability,
    })!;
    expect(graph.nodes.find((n) => n.id === "sub-1")!.status).toBe("error");
    expect(graph.nodes.find((n) => n.id === "sub-2")!.status).toBe("success");
  });
});

describe("buildTurnDag — run errors", () => {
  test("a run_error attaches to the last node that had already happened", () => {
    const messages = [msg("u1", "user", 0, null), msg("a1", "assistant", 9, "u1")];
    const toolCalls = [call("tc-1", "a1", "read", 1), call("tc-2", "a1", "write", 2)];
    const observability = [obs("ev-err", "run_error", 3, { error: "provider timed out" })];
    const graph = build({ messages, turnMessageId: "u1", toolCalls, observability })!;
    const node = graph.nodes.find((n) => n.id === "error:ev-err")!;
    expect(node).toEqual({
      label: "provider timed out",
      id: "error:ev-err",
      kind: "error",
      status: "error",
      createdAt: at(3),
    });
    // tc-2 ran at 2s; the assistant row was not written until 9s.
    expect(graph.edges).toContainEqual({ from: "tc-2", to: "error:ev-err", kind: "sequence" });
  });

  test("a run that died before producing anything attaches to the prompt", () => {
    const messages = [msg("u1", "user", 0, null)];
    const observability = [obs("ev-err", "run_error", 1, { error: "boom" })];
    const graph = build({ messages, turnMessageId: "u1", observability })!;
    expect(graph.edges).toEqual([{ from: "u1", to: "error:ev-err", kind: "sequence" }]);
  });

  test("a run_error with no readable message gets a fallback label", () => {
    const observability = [
      obs("ev-a", "run_error", 1, { error: 500 }),
      obs("ev-b", "run_error", 2, { error: "" }),
    ];
    const graph = build({ messages: SIMPLE_TURN, turnMessageId: "u1", observability })!;
    expect(graph.nodes.find((n) => n.id === "error:ev-a")!.label).toBe("Run failed");
    expect(graph.nodes.find((n) => n.id === "error:ev-b")!.label).toBe("Run failed");
  });

  test("a run_error from a later turn is not attributed to this one", () => {
    const messages = [
      msg("u1", "user", 0, null),
      msg("a1", "assistant", 1, "u1"),
      msg("u2", "user", 2, "a1"),
    ];
    const observability = [obs("ev-err", "run_error", 4, { error: "later" })];
    const graph = build({ messages, turnMessageId: "u1", observability })!;
    expect(graph.nodes.some((n) => n.kind === "error")).toBe(false);
  });
});
