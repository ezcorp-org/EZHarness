/**
 * `src/runtime/chat-graph/build-conversation-dag.ts` — LEVEL 1.
 *
 * The builder is pure, so every case here is a hand-built row set. The
 * shapes mirror the real producers exactly:
 *   - `treeNodes` = `computeSessionTree().nodes` (`SessionTreeNode`)
 *   - `messages` / `subConversations` = `getMessagesWithToolCalls()`
 *
 * The cases worth pinning are the ones where the "collapse assistants into
 * edges" rule could quietly lose structure: a rewind fork, an excluded
 * branch, a spawn hanging off a turn, and degraded mode.
 */

import { describe, expect, test } from "bun:test";
import {
  buildConversationDag,
  type ConversationDagInput,
  type ConversationDagSubConversation,
  type ConversationTreeNode,
} from "../runtime/chat-graph/build-conversation-dag";

const T0 = Date.parse("2026-07-26T12:00:00.000Z");

/** ISO timestamp `seconds` after the fixture epoch. */
function at(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

interface RowSpec {
  id: string;
  role: string;
  parentId?: string | null;
  seconds: number;
  excluded?: boolean;
  content?: string;
}

/** Build the tree+messages pair for a row set so they can never drift. */
function rows(specs: RowSpec[]): Pick<ConversationDagInput, "treeNodes" | "messages"> {
  const treeNodes: ConversationTreeNode[] = specs.map((s) => ({
    id: s.id,
    parentId: s.parentId ?? null,
    role: s.role,
    excluded: s.excluded ?? false,
    createdAt: at(s.seconds),
  }));
  return {
    treeNodes,
    messages: specs.map((s) => ({ id: s.id, role: s.role, content: s.content ?? `${s.id} text` })),
  };
}

function build(
  specs: RowSpec[],
  subConversations: ConversationDagSubConversation[] = [],
  degraded?: boolean,
) {
  return buildConversationDag({
    conversationId: "conv-1",
    ...rows(specs),
    subConversations,
    ...(degraded ? { degraded: true } : {}),
  });
}

describe("buildConversationDag — shape", () => {
  test("an empty conversation yields a null rootId and no nodes", () => {
    const graph = build([]);
    expect(graph).toEqual({
      level: 1,
      rootId: null,
      conversationId: "conv-1",
      nodes: [],
      edges: [],
    });
  });

  test("a conversation with only an assistant row still has no prompt nodes", () => {
    // Defensive: `rootId` keys off NODES, not rows, so a conversation whose
    // only rows are non-prompts reads as empty rather than claiming a root.
    const graph = build([{ id: "a1", role: "assistant", seconds: 1 }]);
    expect(graph.nodes).toEqual([]);
    expect(graph.rootId).toBeNull();
  });

  test("a single prompt is one drillable node with no edges", () => {
    const graph = build([
      { id: "u1", role: "user", seconds: 0, content: "hello there" },
      { id: "a1", role: "assistant", parentId: "u1", seconds: 1 },
    ]);
    expect(graph.level).toBe(1);
    expect(graph.rootId).toBe("conv-1");
    expect(graph.nodes).toEqual([
      {
        label: "hello there",
        id: "u1",
        kind: "prompt",
        status: "success",
        createdAt: at(0),
        drillable: true,
      },
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.degraded).toBeUndefined();
  });

  test("EVERY prompt node is drillable — the headline interaction", () => {
    const graph = build([
      { id: "u1", role: "user", seconds: 0 },
      { id: "a1", role: "assistant", parentId: "u1", seconds: 1 },
      { id: "u2", role: "user", parentId: "a1", seconds: 2 },
      { id: "a2", role: "assistant", parentId: "u2", seconds: 3 },
      { id: "u3", role: "user", parentId: "a2", seconds: 4 },
    ]);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes.every((n) => n.drillable === true)).toBe(true);
  });

  test("a long prompt is truncated and keeps the original in fullLabel", () => {
    const long = "z".repeat(200);
    const graph = build([{ id: "u1", role: "user", seconds: 0, content: long }]);
    expect(graph.nodes[0]!.label.length).toBeLessThan(long.length);
    expect(graph.nodes[0]!.fullLabel).toBe(long);
  });
});

describe("buildConversationDag — assistants collapse into edges", () => {
  test("consecutive prompts chain through the assistant between them", () => {
    const graph = build([
      { id: "u1", role: "user", seconds: 0 },
      { id: "a1", role: "assistant", parentId: "u1", seconds: 1 },
      { id: "u2", role: "user", parentId: "a1", seconds: 2 },
    ]);
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "u2"]);
    expect(graph.edges).toEqual([{ from: "u1", to: "u2", kind: "sequence" }]);
  });

  test("synthetic rows between prompts are skipped, not turned into nodes", () => {
    const graph = build([
      { id: "u1", role: "user", seconds: 0 },
      { id: "a1", role: "assistant", parentId: "u1", seconds: 1 },
      { id: "cap1", role: "capability-event", parentId: "a1", seconds: 2 },
      { id: "u2", role: "user", parentId: "cap1", seconds: 3 },
    ]);
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "u2"]);
    expect(graph.edges).toEqual([{ from: "u1", to: "u2", kind: "sequence" }]);
  });

  test("the LIVE message role wins over the session tree's snapshot", () => {
    // The session tree snapshots role at append time and is not reconciled
    // on same-id updates, so a row whose live role is `user` must still
    // become a prompt even when the tree remembers something else.
    const graph = buildConversationDag({
      conversationId: "conv-1",
      treeNodes: [{ id: "u1", parentId: null, role: "extension", excluded: false, createdAt: at(0) }],
      messages: [{ id: "u1", role: "user", content: "live role" }],
      subConversations: [],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1"]);
  });

  test("a tree node with no live message row falls back to the tree's role", () => {
    const graph = buildConversationDag({
      conversationId: "conv-1",
      treeNodes: [{ id: "u1", parentId: null, role: "user", excluded: false, createdAt: at(0) }],
      messages: [],
      subConversations: [],
    });
    expect(graph.nodes).toHaveLength(1);
    // No row means no text — the node exists for topology, with an empty label.
    expect(graph.nodes[0]!.label).toBe("");
  });
});

describe("buildConversationDag — forks", () => {
  test("a rewind fork renders two branch edges, and the abandoned leg stays excluded", () => {
    //        u1
    //      /    \
    //    a1      a1b        (retry of the same turn)
    //     |        |
    //    u2       u3        (u2's branch was rewound away and excluded)
    const graph = build([
      { id: "u1", role: "user", seconds: 0 },
      { id: "a1", role: "assistant", parentId: "u1", seconds: 1 },
      { id: "u2", role: "user", parentId: "a1", seconds: 2, excluded: true },
      { id: "a1b", role: "assistant", parentId: "u1", seconds: 3 },
      { id: "u3", role: "user", parentId: "a1b", seconds: 4 },
    ]);
    expect(graph.edges).toEqual([
      { from: "u1", to: "u2", kind: "branch" },
      { from: "u1", to: "u3", kind: "branch" },
    ]);
    const u2 = graph.nodes.find((n) => n.id === "u2")!;
    const u3 = graph.nodes.find((n) => n.id === "u3")!;
    expect(u2.excluded).toBe(true);
    // Excluded is OMITTED (not `false`) on the live leg, per the contract.
    expect(u3.excluded).toBeUndefined();
    // The excluded branch is kept as a node — greyed, not dropped.
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "u2", "u3"]);
  });

  test("sibling ROOT prompts are separate roots, not a chain", () => {
    const graph = build([
      { id: "u1", role: "user", seconds: 0 },
      { id: "u2", role: "user", seconds: 1 },
    ]);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([]);
  });

  test("a corrupt parent cycle above a prompt terminates instead of hanging", () => {
    // x1 → x2 → x1: no prompt is reachable, so u-less topology yields no edge.
    const graph = buildConversationDag({
      conversationId: "conv-1",
      treeNodes: [
        { id: "u1", parentId: "x1", role: "user", excluded: false, createdAt: at(0) },
        { id: "x1", parentId: "x2", role: "assistant", excluded: false, createdAt: at(1) },
        { id: "x2", parentId: "x1", role: "assistant", excluded: false, createdAt: at(2) },
      ],
      messages: [{ id: "u1", role: "user", content: "cycle" }],
      subConversations: [],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1"]);
    expect(graph.edges).toEqual([]);
  });

  test("nodes are ordered by createdAt even when the tree returns them out of order", () => {
    const graph = buildConversationDag({
      conversationId: "conv-1",
      treeNodes: [
        { id: "u2", parentId: "a1", role: "user", excluded: false, createdAt: at(2) },
        { id: "a1", parentId: "u1", role: "assistant", excluded: false, createdAt: at(1) },
        { id: "u1", parentId: null, role: "user", excluded: false, createdAt: at(0) },
      ],
      messages: [
        { id: "u1", role: "user", content: "first" },
        { id: "u2", role: "user", content: "second" },
        { id: "a1", role: "assistant", content: "reply" },
      ],
      subConversations: [],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "u2"]);
  });
});

describe("buildConversationDag — sub-agent spawns", () => {
  const conversation: RowSpec[] = [
    { id: "u1", role: "user", seconds: 0 },
    { id: "a1", role: "assistant", parentId: "u1", seconds: 1 },
    { id: "u2", role: "user", parentId: "a1", seconds: 2 },
  ];

  test("a spawn hangs off the turn whose message spawned it", () => {
    const graph = build(conversation, [
      { id: "sub-1", agentName: "researcher", parentMessageId: "a1" },
    ]);
    expect(graph.nodes.find((n) => n.id === "sub-1")).toEqual({
      label: "researcher",
      id: "sub-1",
      kind: "subagent",
      status: "success",
      // The SPAWNING message's timestamp, not the child conversation's.
      createdAt: at(1),
      drillable: true,
      subConversationId: "sub-1",
    });
    expect(graph.edges).toContainEqual({ from: "u1", to: "sub-1", kind: "spawn" });
  });

  test("a spawn anchored directly to the user row attaches to that prompt", () => {
    const graph = build(conversation, [{ id: "sub-1", agentName: "helper", parentMessageId: "u2" }]);
    expect(graph.edges).toContainEqual({ from: "u2", to: "sub-1", kind: "spawn" });
  });

  test("an unnamed agent gets a readable fallback label", () => {
    const graph = build(conversation, [{ id: "sub-1", agentName: null, parentMessageId: "a1" }]);
    expect(graph.nodes.find((n) => n.id === "sub-1")!.label).toBe("sub-agent");
  });

  test("a spawn with no parent message is dropped rather than floated as an orphan", () => {
    const graph = build(conversation, [
      { id: "sub-1", agentName: "orphan", parentMessageId: null },
    ]);
    expect(graph.nodes.some((n) => n.kind === "subagent")).toBe(false);
    expect(graph.edges.some((e) => e.kind === "spawn")).toBe(false);
  });

  test("a spawn whose parent resolves to no prompt is dropped", () => {
    const graph = build(conversation, [
      { id: "sub-1", agentName: "unattributable", parentMessageId: "ghost" },
    ]);
    expect(graph.nodes.some((n) => n.kind === "subagent")).toBe(false);
  });
});

describe("buildConversationDag — degraded mode", () => {
  test("the flat chain still produces the full level-1 graph, flagged degraded", () => {
    const graph = build(
      [
        { id: "u1", role: "user", seconds: 0 },
        { id: "a1", role: "assistant", parentId: "u1", seconds: 1 },
        { id: "u2", role: "user", parentId: "a1", seconds: 2 },
      ],
      [],
      true,
    );
    expect(graph.degraded).toBe(true);
    expect(graph.nodes.map((n) => n.id)).toEqual(["u1", "u2"]);
    expect(graph.edges).toEqual([{ from: "u1", to: "u2", kind: "sequence" }]);
  });
});
