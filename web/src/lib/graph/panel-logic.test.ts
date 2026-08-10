/**
 * Unit suite for the chat-graph panel's pure navigation logic.
 *
 * Every drill target, every URL shape, and every quiet-notice condition is
 * pinned here so `ChatGraphPanel.svelte` can stay a template with no
 * decisions in it.
 */
import { describe, expect, test } from "bun:test";
import type { ChatGraph, GraphNode } from "$server/runtime/chat-graph/types";
import {
  drillFrame,
  frameTitle,
  graphNotices,
  graphUrl,
  isEmptyGraph,
  popTo,
  ROOT_FRAME_LABEL,
  rootFrame,
  type GraphFrame,
} from "./panel-logic";

function node(over: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "n1",
    kind: "prompt",
    label: "hello",
    status: "success",
    createdAt: "2026-07-26T10:00:00.000Z",
    ...over,
  };
}

function graph(over: Partial<ChatGraph> = {}): ChatGraph {
  return { level: 1, rootId: null, conversationId: "conv-1", nodes: [], edges: [], ...over };
}

describe("rootFrame", () => {
  test("is a level-1 frame for the given conversation", () => {
    expect(rootFrame("conv-1")).toEqual({ conversationId: "conv-1", label: ROOT_FRAME_LABEL });
  });

  test("has no turnId, so it reads as level 1", () => {
    expect(rootFrame("conv-1").turnId).toBeUndefined();
  });
});

describe("graphUrl", () => {
  test("level 1 omits the turn query entirely", () => {
    expect(graphUrl(rootFrame("conv-1"))).toBe("/api/conversations/conv-1/graph");
  });

  test("level 2 keys on ?turn=", () => {
    expect(graphUrl({ conversationId: "conv-1", turnId: "msg-9", label: "x" })).toBe(
      "/api/conversations/conv-1/graph?turn=msg-9",
    );
  });

  test("encodes both ids", () => {
    expect(graphUrl({ conversationId: "a/b", turnId: "c&d=e", label: "x" })).toBe(
      "/api/conversations/a%2Fb/graph?turn=c%26d%3De",
    );
  });
});

describe("frameTitle", () => {
  test("null frame falls back to the generic title", () => {
    expect(frameTitle(null)).toBe("Conversation graph");
  });

  test("level 1 is the conversation map", () => {
    expect(frameTitle(rootFrame("conv-1"))).toBe("Conversation map");
  });

  test("level 2 is the turn trace", () => {
    expect(frameTitle({ conversationId: "conv-1", turnId: "m1", label: "x" })).toBe("Turn trace");
  });
});

describe("drillFrame", () => {
  const current: GraphFrame = rootFrame("conv-1");

  test("a non-drillable node is a leaf", () => {
    expect(drillFrame(node({ kind: "tool", drillable: false }), current)).toBeNull();
  });

  test("an absent drillable flag is a leaf (the flag is opt-in)", () => {
    expect(drillFrame(node({ kind: "prompt" }), current)).toBeNull();
  });

  test("a drillable prompt drills to level 2 of the SAME conversation", () => {
    expect(
      drillFrame(node({ id: "msg-7", kind: "prompt", drillable: true, label: "Fix it" }), current),
    ).toEqual({
      conversationId: "conv-1",
      turnId: "msg-7",
      label: "Fix it",
    });
  });

  test("a drillable subagent drills to level 1 of the CHILD conversation", () => {
    const n = node({
      id: "sub-1",
      kind: "subagent",
      drillable: true,
      subConversationId: "conv-2",
      label: "reviewer",
    });
    expect(drillFrame(n, current)).toEqual({ conversationId: "conv-2", label: "reviewer" });
  });

  test("a subagent with no subConversationId is a leaf, not a wrong navigation", () => {
    expect(drillFrame(node({ kind: "subagent", drillable: true }), current)).toBeNull();
  });

  test("a drillable node of any other kind is a leaf", () => {
    expect(drillFrame(node({ kind: "assistant", drillable: true }), current)).toBeNull();
  });

  test("prompt drilling keeps the CURRENT conversation, not the root one", () => {
    const inSub: GraphFrame = { conversationId: "conv-9", label: "reviewer" };
    expect(
      drillFrame(node({ id: "m2", kind: "prompt", drillable: true }), inSub)?.conversationId,
    ).toBe("conv-9");
  });
});

describe("popTo", () => {
  const a = rootFrame("c1");
  const b: GraphFrame = { conversationId: "c1", turnId: "m1", label: "b" };
  const c: GraphFrame = { conversationId: "c2", label: "c" };

  test("pops back to an earlier index", () => {
    expect(popTo([a, b, c], 0)).toEqual([a]);
    expect(popTo([a, b, c], 1)).toEqual([a, b]);
  });

  test("the last index is a no-op (already there)", () => {
    expect(popTo([a, b, c], 2)).toEqual([a, b, c]);
  });

  test("out-of-range indices are no-ops", () => {
    expect(popTo([a, b], -1)).toEqual([a, b]);
    expect(popTo([a, b], 9)).toEqual([a, b]);
  });

  test("never mutates the input", () => {
    const stack = [a, b, c];
    popTo(stack, 0);
    expect(stack).toHaveLength(3);
  });
});

describe("graphNotices", () => {
  test("a clean graph has nothing to say", () => {
    expect(graphNotices(graph(), false)).toEqual([]);
  });

  test("no graph yet has nothing to say", () => {
    expect(graphNotices(null, false)).toEqual([]);
  });

  test("degraded is a notice, not an error", () => {
    const out = graphNotices(graph({ degraded: true }), false);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Branch history is unavailable");
  });

  test("a cycle is reported even when the graph is otherwise fine", () => {
    const out = graphNotices(graph(), true);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("loop");
  });

  test("both conditions stack, degraded first", () => {
    const out = graphNotices(graph({ degraded: true }), true);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("Branch history");
    expect(out[1]).toContain("loop");
  });

  test("degraded:false is not a notice", () => {
    expect(graphNotices(graph({ degraded: false }), false)).toEqual([]);
  });
});

describe("isEmptyGraph", () => {
  test("not-yet-loaded is not empty (that is the loading state)", () => {
    expect(isEmptyGraph(null)).toBe(false);
  });

  test("a loaded graph with no nodes is empty", () => {
    expect(isEmptyGraph(graph())).toBe(true);
  });

  test("a loaded graph with nodes is not empty", () => {
    expect(isEmptyGraph(graph({ nodes: [node()] }))).toBe(false);
  });
});
