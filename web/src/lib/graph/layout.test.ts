/**
 * Unit suite for the pure layered DAG layout engine (`layout.ts`).
 *
 * Covers every line and branch: ranking (incl. multi-parent relaxation that
 * does NOT raise the rank), deterministic within-rank ordering, coordinate
 * assignment, bezier routing, and the fail-open cycle handling that keeps a
 * corrupt payload from hanging the browser tab.
 *
 * Exact-coordinate assertions are deliberate — the layout is a hard
 * determinism contract (the visual-evidence screenshots hash on it), so the
 * numbers are pinned rather than described.
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatGraph,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
} from "$server/runtime/chat-graph/types";
import { DEFAULT_LAYOUT_OPTIONS, layoutGraph } from "./layout";

// --- Fixtures ----------------------------------------------------------

const T = (n: number) => `2026-07-26T10:00:0${n}.000Z`;

function node(id: string, createdAt: string, over: Partial<GraphNode> = {}): GraphNode {
  return { id, kind: "prompt", label: id, status: "success", createdAt, ...over };
}

function edge(from: string, to: string, kind: GraphEdgeKind = "sequence"): GraphEdge {
  return { from, to, kind };
}

function graph(nodes: GraphNode[], edges: GraphEdge[] = []): ChatGraph {
  return { level: 1, rootId: nodes[0]?.id ?? null, conversationId: "conv-1", nodes, edges };
}

/** id → laid-out node, for assertions that don't care about array position. */
function byId(result: ReturnType<typeof layoutGraph>) {
  return new Map(result.nodes.map((n) => [n.id, n]));
}

const { nodeWidth, nodeHeight, rankGap, nodeGap, padding } = DEFAULT_LAYOUT_OPTIONS;

// --- Degenerate inputs -------------------------------------------------

describe("degenerate inputs", () => {
  test("empty graph lays out to a valid empty result", () => {
    const r = layoutGraph(graph([], []));
    expect(r.nodes).toEqual([]);
    expect(r.edges).toEqual([]);
    expect(r.width).toBe(0);
    expect(r.height).toBe(0);
    expect(r.hasCycle).toBe(false);
  });

  test("empty graph with dangling edges still returns empty, no throw", () => {
    const r = layoutGraph(graph([], [edge("ghost-a", "ghost-b")]));
    expect(r.nodes).toEqual([]);
    expect(r.edges).toEqual([]);
  });

  test("single node sits at the padding origin and sizes the content box", () => {
    const r = layoutGraph(graph([node("a", T(1))]));
    expect(r.nodes).toEqual([
      {
        id: "a",
        x: padding,
        y: padding,
        width: nodeWidth,
        height: nodeHeight,
        rank: 0,
        node: node("a", T(1)),
      },
    ]);
    expect(r.width).toBe(nodeWidth + padding * 2); // 200
    expect(r.height).toBe(nodeHeight + padding * 2); // 76
    expect(r.hasCycle).toBe(false);
  });

  test("duplicate node ids collapse to the first occurrence", () => {
    const first = node("a", T(1), { label: "first" });
    const dupe = node("a", T(9), { label: "second" });
    const r = layoutGraph(graph([first, dupe, node("b", T(2))], [edge("a", "b")]));
    expect(r.nodes).toHaveLength(2);
    expect(byId(r).get("a")!.node.label).toBe("first");
  });

  test("the input graph is never mutated", () => {
    const nodes = [node("b", T(2)), node("a", T(1))];
    const edges = [edge("a", "b")];
    const g = graph(nodes, edges);
    const snapshot = structuredClone(g);
    layoutGraph(g);
    expect(g).toEqual(snapshot);
    expect(g.nodes[0]!.id).toBe("b"); // row sorting did not reorder the source
  });
});

// --- Edge filtering ----------------------------------------------------

describe("edge filtering", () => {
  test("edges referencing a missing node are ignored, not thrown on", () => {
    const g = graph(
      [node("a", T(1)), node("b", T(2))],
      [
        edge("missing", "b"), // unknown source
        edge("a", "missing"), // unknown target
        edge("a", "b"), // valid
      ],
    );
    const r = layoutGraph(g);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.from).toBe("a");
    expect(r.edges[0]!.to).toBe("b");
    expect(r.hasCycle).toBe(false);
  });

  test("a self-edge is dropped and reported as a cycle", () => {
    const r = layoutGraph(graph([node("a", T(1))], [edge("a", "a")]));
    expect(r.edges).toEqual([]);
    expect(r.nodes).toHaveLength(1);
    expect(r.hasCycle).toBe(true);
  });

  test("a self-edge on a MISSING node is dropped without claiming a cycle", () => {
    const r = layoutGraph(graph([node("a", T(1))], [edge("ghost", "ghost")]));
    expect(r.edges).toEqual([]);
    expect(r.hasCycle).toBe(false);
  });

  test("a repeated edge is kept exactly once", () => {
    // The renderer keys its {#each} by from/to/kind, and Svelte throws
    // `each_key_duplicate` on a repeat — so a duplicated edge in a corrupt
    // payload would take the whole panel down if it reached the template.
    const g = graph(
      [node("a", T(1)), node("b", T(2))],
      [edge("a", "b"), edge("a", "b"), edge("a", "b")],
    );
    const r = layoutGraph(g);
    expect(r.edges).toHaveLength(1);
    // Deduping is not a cycle — the graph is still a plain a→b.
    expect(r.hasCycle).toBe(false);
  });

  test("the same pair with DIFFERENT kinds is two real edges, not a duplicate", () => {
    const g = graph(
      [node("a", T(1)), node("b", T(2))],
      [edge("a", "b", "sequence"), edge("a", "b", "spawn")],
    );
    const r = layoutGraph(g);
    expect(r.edges.map((e) => e.kind)).toEqual(["sequence", "spawn"]);
  });

  test("every kept edge has a unique render key", () => {
    // The invariant the renderer actually depends on, asserted directly
    // against a payload that repeats edges, self-loops and dangles.
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("c", T(3))],
      [
        edge("a", "b"),
        edge("a", "b"),
        edge("a", "c", "spawn"),
        edge("a", "c", "spawn"),
        edge("b", "b"),
        edge("a", "ghost"),
      ],
    );
    const keys = layoutGraph(g).edges.map((e) => `${e.from}->${e.to}-${e.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["a->b-sequence", "a->c-spawn"]);
  });

  test("edge kind is carried through untouched", () => {
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("c", T(3))],
      [edge("a", "b", "spawn"), edge("a", "c", "branch")],
    );
    const r = layoutGraph(g);
    expect(r.edges.map((e) => e.kind)).toEqual(["spawn", "branch"]);
  });
});

// --- Ranking -----------------------------------------------------------

describe("rank assignment", () => {
  test("a chain ranks by depth", () => {
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("c", T(3))],
      [edge("a", "b"), edge("b", "c")],
    );
    const m = byId(layoutGraph(g));
    expect(m.get("a")!.rank).toBe(0);
    expect(m.get("b")!.rank).toBe(1);
    expect(m.get("c")!.rank).toBe(2);
  });

  test("longest path wins when a node has parents at different depths", () => {
    // a→b→c and a→c: c must sit BELOW b, not beside it.
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("c", T(3))],
      [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    );
    const m = byId(layoutGraph(g));
    expect(m.get("b")!.rank).toBe(1);
    expect(m.get("c")!.rank).toBe(2);
  });

  test("a diamond keeps the join node at one rank below both parents", () => {
    // Second relaxation of `d` proposes the SAME rank — it must not bump it.
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("c", T(3)), node("d", T(4))],
      [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
    );
    const m = byId(layoutGraph(g));
    expect(m.get("b")!.rank).toBe(1);
    expect(m.get("c")!.rank).toBe(1);
    expect(m.get("d")!.rank).toBe(2);
  });

  test("multiple roots all rank 0", () => {
    const g = graph(
      [node("r1", T(1)), node("r2", T(2)), node("child", T(3))],
      [edge("r1", "child"), edge("r2", "child")],
    );
    const m = byId(layoutGraph(g));
    expect(m.get("r1")!.rank).toBe(0);
    expect(m.get("r2")!.rank).toBe(0);
    expect(m.get("child")!.rank).toBe(1);
  });

  test("disconnected components share the rank space", () => {
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("x", T(3)), node("y", T(4)), node("lone", T(5))],
      [edge("a", "b"), edge("x", "y")],
    );
    const r = layoutGraph(g);
    const m = byId(r);
    expect(m.get("a")!.rank).toBe(0);
    expect(m.get("x")!.rank).toBe(0);
    expect(m.get("lone")!.rank).toBe(0);
    expect(m.get("b")!.rank).toBe(1);
    expect(m.get("y")!.rank).toBe(1);
    // Rank 0 holds three nodes, rank 1 holds two → the box is sized by rank 0.
    expect(r.width).toBe(3 * nodeWidth + 2 * nodeGap + padding * 2);
  });

  test("a sub-agent spawn edge adds a second parent without breaking ranking", () => {
    // prompt→assistant→sub, plus the spawn edge prompt→sub.
    const g = graph(
      [
        node("p", T(1), { kind: "prompt" }),
        node("asst", T(2), { kind: "assistant" }),
        node("sub", T(3), { kind: "subagent", drillable: true }),
      ],
      [edge("p", "asst"), edge("asst", "sub"), edge("p", "sub", "spawn")],
    );
    const m = byId(layoutGraph(g));
    expect(m.get("sub")!.rank).toBe(2);
  });
});

// --- Within-rank ordering ----------------------------------------------

describe("within-rank ordering", () => {
  test("siblings order by createdAt ascending regardless of input order", () => {
    const g = graph(
      [node("root", T(0)), node("late", T(5)), node("early", T(1)), node("mid", T(3))],
      [edge("root", "late"), edge("root", "early"), edge("root", "mid")],
    );
    const r = layoutGraph(g);
    const rank1 = r.nodes.filter((n) => n.rank === 1);
    expect(rank1.map((n) => n.id)).toEqual(["early", "mid", "late"]);
    // x increases left-to-right in that order.
    expect(rank1[0]!.x).toBeLessThan(rank1[1]!.x);
    expect(rank1[1]!.x).toBeLessThan(rank1[2]!.x);
  });

  test("same createdAt ties break on id ascending", () => {
    const same = T(2);
    const g = graph(
      [node("root", T(0)), node("zz", same), node("aa", same), node("mm", same)],
      [edge("root", "zz"), edge("root", "aa"), edge("root", "mm")],
    );
    const ids = layoutGraph(g)
      .nodes.filter((n) => n.rank === 1)
      .map((n) => n.id);
    expect(ids).toEqual(["aa", "mm", "zz"]);
  });

  test("unparseable createdAt sorts last, then by id", () => {
    const g = graph(
      [
        node("root", T(0)),
        node("bad-z", "not-a-date"),
        node("good", T(4)),
        node("bad-a", "also-garbage"),
      ],
      [edge("root", "bad-z"), edge("root", "good"), edge("root", "bad-a")],
    );
    const ids = layoutGraph(g)
      .nodes.filter((n) => n.rank === 1)
      .map((n) => n.id);
    expect(ids).toEqual(["good", "bad-a", "bad-z"]);
  });

  test("result nodes are emitted rank-major, ordered within each rank", () => {
    const g = graph(
      [node("a", T(1)), node("c", T(3)), node("b", T(2)), node("d", T(4))],
      [edge("a", "b"), edge("a", "c"), edge("b", "d")],
    );
    const r = layoutGraph(g);
    expect(r.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    expect(r.nodes.map((n) => n.rank)).toEqual([0, 1, 1, 2]);
  });
});

// --- Coordinates -------------------------------------------------------

describe("coordinate assignment", () => {
  test("a two-node chain pins exact coordinates", () => {
    const g = graph([node("a", T(1)), node("b", T(2))], [edge("a", "b")]);
    const r = layoutGraph(g);
    const m = byId(r);
    expect(m.get("a")).toMatchObject({ x: 16, y: 16, width: 168, height: 44, rank: 0 });
    expect(m.get("b")).toMatchObject({ x: 16, y: 100, width: 168, height: 44, rank: 1 });
    expect(r.width).toBe(200);
    expect(r.height).toBe(160);
  });

  test("rows are centred against the widest row", () => {
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("c", T(3))],
      [edge("a", "b"), edge("a", "c")],
    );
    const r = layoutGraph(g);
    const m = byId(r);
    // Widest row = 2 nodes = 2*168 + 24 = 360. Single-node row 0 is centred.
    expect(r.width).toBe(360 + padding * 2); // 392
    expect(m.get("a")!.x).toBe(padding + (360 - nodeWidth) / 2); // 112
    expect(m.get("b")!.x).toBe(padding); // 16
    expect(m.get("c")!.x).toBe(padding + nodeWidth + nodeGap); // 208
    // Rank rows are evenly spaced.
    expect(m.get("b")!.y - m.get("a")!.y).toBe(nodeHeight + rankGap);
  });

  test("height grows one rank-step per rank", () => {
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("c", T(3))],
      [edge("a", "b"), edge("b", "c")],
    );
    const r = layoutGraph(g);
    expect(r.height).toBe(3 * nodeHeight + 2 * rankGap + padding * 2); // 244
  });

  test("custom options are honoured for every dimension", () => {
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("c", T(3))],
      [edge("a", "b"), edge("a", "c")],
    );
    const r = layoutGraph(g, {
      nodeWidth: 100,
      nodeHeight: 20,
      rankGap: 10,
      nodeGap: 4,
      padding: 5,
    });
    const m = byId(r);
    expect(m.get("a")).toMatchObject({ width: 100, height: 20, y: 5 });
    expect(m.get("b")!.y).toBe(5 + 20 + 10); // 35
    expect(m.get("b")!.x).toBe(5);
    expect(m.get("c")!.x).toBe(5 + 100 + 4); // 109
    expect(r.width).toBe(2 * 100 + 4 + 10); // 214
    expect(r.height).toBe(2 * 20 + 10 + 10); // 60
  });

  test("the source node is passed through by reference-equal value", () => {
    const a = node("a", T(1), { meta: { hello: "world" }, excluded: true });
    const r = layoutGraph(graph([a]));
    expect(r.nodes[0]!.node).toBe(a);
    expect(r.nodes[0]!.node.excluded).toBe(true);
  });
});

// --- Edge routing ------------------------------------------------------

describe("edge routing", () => {
  test("a single-rank edge is a vertical bezier with exact control points", () => {
    const g = graph([node("a", T(1)), node("b", T(2))], [edge("a", "b")]);
    const r = layoutGraph(g);
    // bottom-centre (100,60) → top-centre (100,100); bend = max(40*0.5, 40*0.35) = 20.
    expect(r.edges[0]!.path).toBe("M 100 60 C 100 80 100 80 100 100");
  });

  test("a fork's two edges start at the same anchor and end apart", () => {
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("c", T(3))],
      [edge("a", "b"), edge("a", "c")],
    );
    const r = layoutGraph(g);
    expect(r.edges[0]!.path).toBe("M 196 60 C 196 80 100 80 100 100");
    expect(r.edges[1]!.path).toBe("M 196 60 C 196 80 292 80 292 100");
  });

  test("an edge spanning more than one rank curves proportionally", () => {
    // a→b→c plus the long a→c hop across two ranks.
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("c", T(3))],
      [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    );
    const r = layoutGraph(g);
    const long = r.edges.find((e) => e.from === "a" && e.to === "c")!;
    // y1 = 60, y2 = 184 → span 124, bend = max(20, 43.4) = 43.4.
    expect(long.path).toBe("M 100 60 C 100 103.4 100 140.6 100 184");
    // The one-rank hop keeps the smaller floor bend.
    const short = r.edges.find((e) => e.from === "a" && e.to === "b")!;
    expect(short.path).toBe("M 100 60 C 100 80 100 80 100 100");
  });

  test("path coordinates are rounded to 2dp with no float noise", () => {
    const g = graph([node("a", T(1)), node("b", T(2))], [edge("a", "b")]);
    const r = layoutGraph(g, { nodeWidth: 33, rankGap: 7, nodeHeight: 11, padding: 3 });
    expect(r.edges[0]!.path).not.toContain("0000");
    expect(r.edges[0]!.path).toMatch(
      /^M [\d.]+ [\d.]+ C [\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+ [\d.]+$/,
    );
  });

  test("every emitted edge resolves to a laid-out endpoint", () => {
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("c", T(3))],
      [edge("a", "b"), edge("b", "c"), edge("a", "c")],
    );
    const r = layoutGraph(g);
    const ids = new Set(r.nodes.map((n) => n.id));
    for (const e of r.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
      expect(e.path.startsWith("M ")).toBe(true);
    }
  });
});

// --- Cycle safety (fail open) ------------------------------------------

describe("cycle safety", () => {
  test("a two-node cycle still lays out and raises hasCycle", () => {
    const g = graph([node("a", T(1)), node("b", T(2))], [edge("a", "b"), edge("b", "a")]);
    const r = layoutGraph(g);
    expect(r.hasCycle).toBe(true);
    expect(r.nodes).toHaveLength(2);
    expect(r.edges).toHaveLength(2);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });

  test("a cycle hanging off a valid root keeps the root at rank 0", () => {
    // root → b, and b ↔ c cycle.
    const g = graph(
      [node("root", T(1)), node("b", T(2)), node("c", T(3))],
      [edge("root", "b"), edge("b", "c"), edge("c", "b")],
    );
    const r = layoutGraph(g);
    expect(r.hasCycle).toBe(true);
    expect(byId(r).get("root")!.rank).toBe(0);
    expect(r.nodes).toHaveLength(3);
    // Ranks are compacted — no blank row is left behind by the break.
    const ranks = [...new Set(r.nodes.map((n) => n.rank))].sort((x, y) => x - y);
    expect(ranks).toEqual([...ranks.keys()]);
  });

  test("the cycle entry point is picked deterministically by (createdAt, id)", () => {
    // A three-node cycle listed out of sort order, so the entry-point scan
    // hits both "this one is better" and "this one is worse".
    const g = graph(
      [node("c", T(3)), node("b", T(2)), node("d", T(4))],
      [edge("b", "c"), edge("c", "d"), edge("d", "b")],
    );
    const r = layoutGraph(g);
    expect(r.hasCycle).toBe(true);
    // `b` sorts first, so it is the broken-into entry and lands on row 0.
    expect(byId(r).get("b")!.rank).toBe(0);
    expect(r.nodes).toHaveLength(3);
  });

  test("a fully cyclic graph terminates instead of hanging", () => {
    const ids = ["n0", "n1", "n2", "n3", "n4", "n5"];
    const nodes = ids.map((id, i) => node(id, T(i)));
    const edges = ids.map((id, i) => edge(id, ids[(i + 1) % ids.length]!));
    const r = layoutGraph(graph(nodes, edges));
    expect(r.hasCycle).toBe(true);
    expect(r.nodes).toHaveLength(ids.length);
    expect(r.edges).toHaveLength(ids.length);
  });

  test("longest-path rank survives a cycle break", () => {
    // a→b→d, plus the c↔d cycle. `c` is the break entry (earliest
    // createdAt of the two), so `d` is relaxed TWICE: first from `b`
    // proposing rank 2, then from the freshly-released `c` proposing
    // rank 1. Ranking must keep the deeper of the two.
    //
    // Acyclic input can never exercise this — FIFO Kahn pops in
    // non-decreasing rank order there, so the later proposal is always
    // the deeper one. Only a broken cycle can walk the rank backwards,
    // which is exactly why this fixture is here.
    const g = graph(
      [node("b", T(0)), node("c", T(1)), node("d", T(2)), node("a", T(3))],
      [edge("b", "d"), edge("c", "d"), edge("d", "c"), edge("a", "b")],
    );
    const r = layoutGraph(g);
    const m = byId(r);
    expect(r.hasCycle).toBe(true);
    expect(m.get("a")!.rank).toBe(0);
    expect(m.get("c")!.rank).toBe(0);
    expect(m.get("b")!.rank).toBe(1);
    // The shallower proposal from `c` must NOT drag `d` up beside `b`.
    expect(m.get("d")!.rank).toBe(2);
  });

  test("two independent cycles are both broken", () => {
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("x", T(3)), node("y", T(4))],
      [edge("a", "b"), edge("b", "a"), edge("x", "y"), edge("y", "x")],
    );
    const r = layoutGraph(g);
    expect(r.hasCycle).toBe(true);
    expect(r.nodes).toHaveLength(4);
  });

  test("an acyclic graph never reports a cycle", () => {
    const g = graph(
      [node("a", T(1)), node("b", T(2)), node("c", T(3))],
      [edge("a", "b"), edge("b", "c")],
    );
    expect(layoutGraph(g).hasCycle).toBe(false);
  });
});

// --- Determinism -------------------------------------------------------

describe("determinism", () => {
  const complex = () =>
    graph(
      [
        node("p1", T(1), { kind: "prompt", drillable: true }),
        node("a1", T(2), { kind: "assistant" }),
        node("think", T(2), { kind: "thinking" }),
        node("t1", T(3), { kind: "tool", status: "error" }),
        node("sub", T(4), { kind: "subagent", drillable: true }),
        node("p2", T(5), { kind: "prompt", excluded: true }),
      ],
      [
        edge("p1", "think"),
        edge("p1", "a1"),
        edge("a1", "t1"),
        edge("p1", "sub", "spawn"),
        edge("a1", "p2", "branch"),
      ],
    );

  test("two runs over the same input are byte-identical", () => {
    const a = layoutGraph(complex());
    const b = layoutGraph(complex());
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("shuffling the input node order does not change the layout", () => {
    const base = layoutGraph(complex());
    const shuffled = complex();
    shuffled.nodes.reverse();
    const r = layoutGraph(shuffled);
    expect(r.nodes).toEqual(base.nodes);
    expect(r.width).toBe(base.width);
    expect(r.height).toBe(base.height);
  });

  test("a cyclic input is also deterministic across runs", () => {
    const build = () =>
      graph(
        [node("c", T(3)), node("a", T(1)), node("b", T(2))],
        [edge("a", "b"), edge("b", "c"), edge("c", "a")],
      );
    expect(JSON.stringify(layoutGraph(build()))).toBe(JSON.stringify(layoutGraph(build())));
  });
});

// --- Exported defaults -------------------------------------------------

describe("DEFAULT_LAYOUT_OPTIONS", () => {
  test("every dimension is a positive number", () => {
    for (const v of Object.values(DEFAULT_LAYOUT_OPTIONS)) {
      expect(typeof v).toBe("number");
      expect(v).toBeGreaterThan(0);
    }
  });

  test("omitting options matches passing the defaults explicitly", () => {
    const g = graph([node("a", T(1)), node("b", T(2))], [edge("a", "b")]);
    expect(layoutGraph(g)).toEqual(layoutGraph(g, { ...DEFAULT_LAYOUT_OPTIONS }));
  });
});
