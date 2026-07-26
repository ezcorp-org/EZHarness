/**
 * Pure layered DAG layout for the chat graph panel (`ChatGraphPanel` /
 * `GraphCanvas`).
 *
 * The repo ships NO graph library (no d3 / dagre / elk / cytoscape /
 * svelte-flow) and adding one is against the dependency policy in the root
 * CLAUDE.md — this module is the replacement. It is a Sugiyama-lite layered
 * layout: longest-path ranking, deterministic within-rank ordering, even
 * coordinate assignment, cubic-bezier edge routing.
 *
 * INVARIANTS (all load-bearing — tests pin every one):
 *
 *   - **Pure.** No `Date.now()`, no `Math.random()`, no DOM, no I/O. The input
 *     `ChatGraph` is never mutated (rows are sorted on fresh arrays).
 *   - **Deterministic.** The same input always produces a byte-identical
 *     result, including every SVG path string. The visual-evidence
 *     screenshots depend on this.
 *   - **Fail-open.** The payload is *supposed* to be a DAG, but a corrupt one
 *     must never hang the browser tab. Cycles are detected, the back-edge is
 *     broken for ranking purposes, a layout is still produced, and
 *     `LayoutResult.hasCycle` surfaces it to the caller.
 *
 * Vertical flow: a rank is a row and `y` grows downward, because the panel is
 * a tall narrow right-side dock.
 */
import type { ChatGraph, GraphEdge, GraphEdgeKind, GraphNode } from "$server/runtime/chat-graph/types";

/** Tunables. Every field is optional; see `DEFAULT_LAYOUT_OPTIONS`. */
export interface LayoutOptions {
	/** Node box width, px. */
	nodeWidth?: number;
	/** Node box height, px. */
	nodeHeight?: number;
	/** Vertical gap between two rank rows, px. */
	rankGap?: number;
	/** Horizontal gap between two siblings in the same rank, px. */
	nodeGap?: number;
	/** Margin between the content and the edge of the viewBox, px. */
	padding?: number;
}

/**
 * Resolved defaults. Exported so the renderer can reference the same numbers
 * (e.g. for a minimum panel width) instead of re-declaring them.
 */
export const DEFAULT_LAYOUT_OPTIONS = {
	nodeWidth: 168,
	nodeHeight: 44,
	rankGap: 40,
	nodeGap: 24,
	padding: 16,
} as const satisfies Required<LayoutOptions>;

export interface LaidOutNode {
	/** Same as `node.id`, hoisted so `{#each … as n (n.id)}` reads cleanly. */
	id: string;
	/** Top-left corner in viewBox coordinates (origin is the top-left of the content box). */
	x: number;
	y: number;
	width: number;
	height: number;
	/**
	 * Row index, 0 = topmost row. This is the COMPACTED rank: longest-path
	 * ranking can leave a rank empty once a cycle has been broken, so the
	 * distinct ranks are renumbered 0..n-1 and no blank row is ever emitted.
	 */
	rank: number;
	/** The source node, untouched. */
	node: GraphNode;
}

export interface LaidOutEdge {
	from: string;
	to: string;
	kind: GraphEdgeKind;
	/** SVG cubic-bezier, ready for `<path d={…}>`. Bottom-centre → top-centre. */
	path: string;
}

export interface LayoutResult {
	/** Ordered by rank, then by the within-rank order (createdAt, then id). */
	nodes: LaidOutNode[];
	/** Input order, minus edges that reference a missing node or loop to self. */
	edges: LaidOutEdge[];
	/** Content width including padding. Feed straight into the SVG `viewBox`. */
	width: number;
	/** Content height including padding. */
	height: number;
	/**
	 * True when the input was NOT acyclic. The layout is still valid — a
	 * back-edge was broken to rank the nodes — but the caller should surface a
	 * quiet notice, because the data is corrupt.
	 */
	hasCycle: boolean;
}

/**
 * Lay a `ChatGraph` out as a top-to-bottom layered DAG.
 *
 * Tolerates, without throwing: an empty graph (returns a 0×0 empty result),
 * a single node, multiple roots, disconnected components, duplicate node ids
 * (first occurrence wins), edges referencing an unknown node (dropped),
 * self-edges (dropped, and counted as a cycle), and genuine cycles.
 */
export function layoutGraph(graph: ChatGraph, opts?: LayoutOptions): LayoutResult {
	const o = resolveOptions(opts);
	const byId = indexNodes(graph.nodes);
	if (byId.size === 0) {
		return { nodes: [], edges: [], width: 0, height: 0, hasCycle: false };
	}

	const { kept, hasSelfEdge } = filterEdges(graph.edges, byId);
	const { rank, hasCycle } = assignRanks(byId, kept);
	const { nodes, width, height } = placeNodes(byId, rank, o);

	const placedById = new Map(nodes.map((n) => [n.id, n]));
	const edges = kept.map((e) => ({
		from: e.from,
		to: e.to,
		kind: e.kind,
		path: edgePath(placedById.get(e.from)!, placedById.get(e.to)!, o.rankGap),
	}));

	return { nodes, edges, width, height, hasCycle: hasCycle || hasSelfEdge };
}

// ── options ─────────────────────────────────────────────────────────────────

function resolveOptions(opts: LayoutOptions | undefined): Required<LayoutOptions> {
	return {
		nodeWidth: opts?.nodeWidth ?? DEFAULT_LAYOUT_OPTIONS.nodeWidth,
		nodeHeight: opts?.nodeHeight ?? DEFAULT_LAYOUT_OPTIONS.nodeHeight,
		rankGap: opts?.rankGap ?? DEFAULT_LAYOUT_OPTIONS.rankGap,
		nodeGap: opts?.nodeGap ?? DEFAULT_LAYOUT_OPTIONS.nodeGap,
		padding: opts?.padding ?? DEFAULT_LAYOUT_OPTIONS.padding,
	};
}

// ── input normalisation ─────────────────────────────────────────────────────

/**
 * id → node, first occurrence wins. `GraphNode.id` is contractually unique
 * within one graph; deduping here means a corrupt payload can't place the
 * same node twice (which would also double-anchor every edge touching it).
 */
function indexNodes(list: readonly GraphNode[]): Map<string, GraphNode> {
	const byId = new Map<string, GraphNode>();
	for (const n of list) {
		if (!byId.has(n.id)) byId.set(n.id, n);
	}
	return byId;
}

/**
 * Drop edges we cannot route: an endpoint that isn't a node, or a self-loop.
 * A self-loop is reported separately — it is a one-node cycle, so it must
 * still raise `hasCycle` even though ranking never sees it.
 */
function filterEdges(
	list: readonly GraphEdge[],
	byId: ReadonlyMap<string, GraphNode>,
): { kept: GraphEdge[]; hasSelfEdge: boolean } {
	const kept: GraphEdge[] = [];
	let hasSelfEdge = false;
	for (const e of list) {
		if (!byId.has(e.from) || !byId.has(e.to)) continue;
		if (e.from === e.to) {
			hasSelfEdge = true;
			continue;
		}
		kept.push(e);
	}
	return { kept, hasSelfEdge };
}

// ── rank assignment ─────────────────────────────────────────────────────────

/**
 * Longest-path ranking via Kahn's algorithm. A node's rank is one more than
 * the deepest of its predecessors; every in-degree-0 node (so: every root of
 * every disconnected component, and every isolated node) ranks 0.
 *
 * The relaxation result is independent of the queue order — a node is only
 * popped once ALL of its incoming edges have been relaxed — so a plain FIFO
 * is enough and the output stays deterministic.
 *
 * CYCLE SAFETY: when the queue drains with nodes left over, those nodes are
 * in (or downstream of) a cycle. Rather than spin, the lowest-sorting
 * survivor is force-released — its remaining back-edges are treated as broken
 * — and the drain resumes. Each pass settles at least one node, so this
 * terminates in at most O(n) passes for any input, including an adversarial
 * one.
 */
function assignRanks(
	byId: ReadonlyMap<string, GraphNode>,
	edges: readonly GraphEdge[],
): { rank: Map<string, number>; hasCycle: boolean } {
	const rank = new Map<string, number>();
	const indegree = new Map<string, number>();
	const outgoing = new Map<string, string[]>();
	for (const id of byId.keys()) {
		rank.set(id, 0);
		indegree.set(id, 0);
		outgoing.set(id, []);
	}
	for (const e of edges) {
		outgoing.get(e.from)!.push(e.to);
		indegree.set(e.to, indegree.get(e.to)! + 1);
	}

	const queue: string[] = [];
	for (const [id, deg] of indegree) {
		if (deg === 0) queue.push(id);
	}

	const settled = new Set<string>();
	let hasCycle = false;
	while (settled.size < byId.size) {
		while (queue.length > 0) {
			const id = queue.shift()!;
			settled.add(id);
			const next = rank.get(id)! + 1;
			for (const to of outgoing.get(id)!) {
				const deg = indegree.get(to)! - 1;
				indegree.set(to, deg);
				// THIS is the back-edge break: an edge into an already-settled
				// node closes a loop, so it must neither re-rank that node nor
				// re-queue it. Unreachable for valid (acyclic) input — a node
				// only settles once every incoming edge has been relaxed.
				if (settled.has(to)) continue;
				// Keep the DEEPEST proposal. For acyclic input this guard is a
				// formality — FIFO Kahn pops in non-decreasing rank order, so
				// the last proposal is always the deepest. After a cycle break
				// that no longer holds: a force-released node can propose a
				// SHALLOWER rank to a node another branch already pushed down.
				if (rank.get(to)! < next) rank.set(to, next);
				if (deg === 0) queue.push(to);
			}
		}
		if (settled.size < byId.size) {
			hasCycle = true;
			// Force-release: the entry point still has unrelaxed incoming
			// edges (they are the loop), so it is queued regardless of its
			// in-degree. Its counter is deliberately NOT reset — the settled
			// guard above is the single mechanism that stops it being queued
			// twice, and one mechanism is easier to reason about than two.
			queue.push(pickCycleEntry(byId, settled));
		}
	}

	return { rank, hasCycle };
}

/**
 * The deterministic tie-break for breaking a cycle: the lowest-sorting node
 * that has not been settled yet, by the same (createdAt, id) key used for
 * within-rank ordering. Never called unless at least one node is unsettled.
 */
function pickCycleEntry(byId: ReadonlyMap<string, GraphNode>, settled: ReadonlySet<string>): string {
	let best: GraphNode | null = null;
	for (const n of byId.values()) {
		if (settled.has(n.id)) continue;
		if (best === null || compareNodes(n, best) < 0) best = n;
	}
	return best!.id;
}

// ── ordering ────────────────────────────────────────────────────────────────

/**
 * Sort key for `createdAt`. Unparseable timestamps sort last (and then by id)
 * rather than throwing or silently landing at epoch 0.
 */
function timeKey(iso: string): number {
	const t = Date.parse(iso);
	return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Primary key `createdAt` ascending, tie-break on `id` ascending.
 *
 * There is deliberately no equal-ids arm: `indexNodes` has already deduped by
 * id, `Array.prototype.sort` never compares an element with itself, and
 * `pickCycleEntry` only ever compares two distinct map entries — so `a.id ===
 * b.id` cannot occur, and an arm for it would be dead code.
 */
function compareNodes(a: GraphNode, b: GraphNode): number {
	const ta = timeKey(a.createdAt);
	const tb = timeKey(b.createdAt);
	if (ta !== tb) return ta < tb ? -1 : 1;
	return a.id < b.id ? -1 : 1;
}

// ── coordinate assignment ───────────────────────────────────────────────────

function placeNodes(
	byId: ReadonlyMap<string, GraphNode>,
	rank: ReadonlyMap<string, number>,
	o: Required<LayoutOptions>,
): { nodes: LaidOutNode[]; width: number; height: number } {
	const rows = new Map<number, GraphNode[]>();
	for (const n of byId.values()) {
		const r = rank.get(n.id)!;
		const row = rows.get(r);
		if (row) row.push(n);
		else rows.set(r, [n]);
	}

	// Compact: renumber the distinct ranks 0..n-1 so a cycle-break can't leave
	// a blank row in the middle of the drawing.
	const rankValues = [...rows.keys()].sort((a, b) => a - b);
	const rowWidths = rankValues.map((r) => rowWidth(rows.get(r)!.length, o));
	const maxRowWidth = rowWidths.reduce((a, b) => Math.max(a, b), 0);

	const nodes: LaidOutNode[] = [];
	rankValues.forEach((r, rowIndex) => {
		const row = rows.get(r)!;
		row.sort(compareNodes);
		// Centre each row against the widest one.
		const startX = o.padding + (maxRowWidth - rowWidths[rowIndex]!) / 2;
		const y = o.padding + rowIndex * (o.nodeHeight + o.rankGap);
		row.forEach((n, i) => {
			nodes.push({
				id: n.id,
				x: startX + i * (o.nodeWidth + o.nodeGap),
				y,
				width: o.nodeWidth,
				height: o.nodeHeight,
				rank: rowIndex,
				node: n,
			});
		});
	});

	const rowCount = rankValues.length;
	return {
		nodes,
		width: maxRowWidth + o.padding * 2,
		height: rowCount * o.nodeHeight + (rowCount - 1) * o.rankGap + o.padding * 2,
	};
}

function rowWidth(count: number, o: Required<LayoutOptions>): number {
	return count * o.nodeWidth + (count - 1) * o.nodeGap;
}

// ── edge routing ────────────────────────────────────────────────────────────

/**
 * Cubic bezier from the source's bottom-centre to the target's top-centre.
 *
 * The control points are pulled straight down / straight up so an edge leaves
 * and enters vertically. The pull scales with the vertical span, which keeps
 * a multi-rank edge a smooth sweep instead of a near-straight diagonal, and
 * it never collapses to zero (the `rankGap` floor) so a broken back-edge —
 * which runs upward or sideways — still draws a visible curve rather than a
 * degenerate line.
 */
function edgePath(from: LaidOutNode, to: LaidOutNode, rankGap: number): string {
	const x1 = from.x + from.width / 2;
	const y1 = from.y + from.height;
	const x2 = to.x + to.width / 2;
	const y2 = to.y;
	const bend = Math.max(rankGap * 0.5, Math.abs(y2 - y1) * 0.35);
	return `M ${r2(x1)} ${r2(y1)} C ${r2(x1)} ${r2(y1 + bend)} ${r2(x2)} ${r2(y2 - bend)} ${r2(x2)} ${r2(y2)}`;
}

/** Round to 2dp and drop trailing zeros, so path strings stay short and stable. */
function r2(v: number): string {
	return String(Math.round(v * 100) / 100);
}
