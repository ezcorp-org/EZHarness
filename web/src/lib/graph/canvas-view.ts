/**
 * Pure presentation + keyboard-navigation logic for `GraphCanvas.svelte`.
 *
 * The canvas itself is an SVG template with no decisions in it: every string
 * it prints and every focus move it makes is computed here, so the rules are
 * unit-testable and the component stays line-coverable.
 *
 * Colour lives in CSS (the component's scoped `<style>` keys off
 * `data-kind` / `data-status`), NOT here — this module never returns a hex
 * value or a Tailwind class, so light/dark theming stays a stylesheet
 * concern.
 */
import { formatDuration } from "$lib/format-duration";
import type { GraphEdgeKind, GraphNode, GraphNodeKind, GraphNodeStatus } from "$server/runtime/chat-graph/types";

/**
 * Rendered when `GraphNode.durationMs` is absent.
 *
 * Binding contract (`src/runtime/chat-graph/types.ts`): an absent duration
 * means "not known", and built-in tools persist a hardcoded 0 — so "0ms"
 * would be a fabricated number. It is an em dash or nothing.
 */
export const DURATION_UNKNOWN = "—";

/**
 * Duration for a node box.
 *
 * Sub-second calls are the common case for tools, and the shared
 * `formatDuration` floors to whole seconds ("0s"), so milliseconds are
 * handled here and anything ≥ 1s is delegated to the shared formatter.
 * Non-finite and negative values are corrupt, not fast: they read as unknown.
 */
export function formatNodeDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return DURATION_UNKNOWN;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return formatDuration(ms);
}

/** Human name for each node kind. Also the visible sub-label on the node box. */
export const KIND_LABEL: Record<GraphNodeKind, string> = {
	prompt: "Prompt",
	assistant: "Reply",
	thinking: "Thinking",
	tool: "Tool",
	subagent: "Sub-agent",
	error: "Error",
};

/** Human name for each status. Screen-reader text only — the dot carries it visually. */
export const STATUS_LABEL: Record<GraphNodeStatus, string> = {
	success: "succeeded",
	error: "failed",
	running: "running",
	interrupted: "interrupted",
};

/** Full, untruncated text for the `<title>` tooltip. */
export function nodeTitle(node: GraphNode): string {
	return node.fullLabel ?? node.label;
}

/**
 * What activating this node does, in words. Appended to the aria-label so a
 * screen-reader user is told the node is a drill-in BEFORE they press Enter.
 */
export function nodeAction(node: GraphNode): string {
	if (node.drillable !== true) return "Shows details.";
	if (node.kind === "subagent") return "Opens this sub-agent's graph.";
	return "Opens this turn's trace.";
}

/**
 * The accessible name of a node.
 *
 * The duration is omitted when unknown rather than read out as an em dash,
 * and the rewound-away state is spoken because it is otherwise conveyed by
 * colour alone.
 */
export function nodeAriaLabel(node: GraphNode): string {
	const parts = [`${KIND_LABEL[node.kind]}: ${nodeTitle(node)}`, STATUS_LABEL[node.status]];
	// Gate on the FORMATTED value, not on `durationMs !== undefined`: a corrupt
	// number (negative, NaN, Infinity) is present but unknown, and formatting it
	// yields the em dash — which must never be spoken, only drawn.
	const duration = formatNodeDuration(node.durationMs);
	if (duration !== DURATION_UNKNOWN) parts.push(duration);
	if (node.excluded === true) parts.push("rewound away");
	return `${parts.join(", ")}. ${nodeAction(node)}`;
}

/**
 * `stroke-dasharray` per edge kind: a `spawn` (parent turn → sub-agent) is
 * dashed because it leaves the conversation; `sequence` and `branch` are
 * both solid flow within it.
 */
export function edgeDashArray(kind: GraphEdgeKind): string {
	return kind === "spawn" ? "6 4" : "none";
}

// ── node text area ──────────────────────────────────────────────────────────

/**
 * Right-hand gutter inside a node box, px. The status dot lives there, so the
 * label and meta lines must stop short of it.
 */
export const LABEL_GUTTER = 22;

/**
 * Width of the soft fade at the right edge of the text area, px.
 *
 * Labels reach the renderer already truncated to `LABEL_MAX` (60 chars — see
 * `src/runtime/chat-graph/labels.ts`), but a 168px box shows roughly 23 of
 * them, so most real prompts DO overrun the edge. A hard clip slices the last
 * glyph down the middle and reads as a rendering bug; fading the final pixels
 * reads as "there is more", and the full text is one hover (or one click into
 * the detail pane) away.
 *
 * The budget is deliberately NOT lowered to fit instead: `truncateLabel` sets
 * `fullLabel` whenever it changes the string, so a tighter clamp would put a
 * second copy of nearly every label on the wire.
 */
export const LABEL_FADE_PX = 24;

/**
 * Gradient stop offset (0-1) where a node label starts fading out.
 *
 * A text area no wider than the fade itself fades from its very start rather
 * than yielding a negative stop, which is invalid SVG.
 */
export function labelFadeStart(textWidth: number): number {
	if (textWidth <= LABEL_FADE_PX) return 0;
	return (textWidth - LABEL_FADE_PX) / textWidth;
}

// ── keyboard navigation ─────────────────────────────────────────────────────

/**
 * The layout fields navigation needs. `LaidOutNode` satisfies it structurally,
 * so nav stays decoupled from the layout module.
 */
export interface NavNode {
	id: string;
	x: number;
	width: number;
	/** Row index, 0 = topmost. Ranks are contiguous (the layout compacts them). */
	rank: number;
}

/** Horizontal centre — the axis up/down navigation matches on. */
function centre(n: NavNode): number {
	return n.x + n.width / 2;
}

const HORIZONTAL: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
const VERTICAL: Record<string, number> = { ArrowUp: -1, ArrowDown: 1 };

/**
 * Next focused node id for a key press, or `null` when the key is not a
 * navigation key (so the component can leave the event alone).
 *
 * Rules:
 *   - `Home` / `End` jump to the first / last node in layout order.
 *   - Left / Right step within the current row, in x order.
 *   - Up / Down move to the adjacent row, landing on the node whose centre
 *     is nearest the current one (ties go to the leftmost).
 *   - Every move CLAMPS: at an edge the current node keeps focus rather than
 *     wrapping, so arrowing never silently teleports across the graph.
 *   - No current node (or an unknown one) focuses the first node.
 *
 * `nodes` is expected in layout order (rank, then within-rank order), which
 * is what `layoutGraph` returns.
 */
export function moveFocus(nodes: readonly NavNode[], currentId: string | null, key: string): string | null {
	if (nodes.length === 0) return null;
	if (key === "Home") return nodes[0]!.id;
	if (key === "End") return nodes[nodes.length - 1]!.id;

	const horizontal = HORIZONTAL[key];
	const vertical = VERTICAL[key];
	if (horizontal === undefined && vertical === undefined) return null;

	const current = nodes.find((n) => n.id === currentId);
	if (current === undefined) return nodes[0]!.id;

	if (horizontal !== undefined) return stepWithinRank(nodes, current, horizontal);
	return nearestInRank(nodes, current, vertical!);
}

/** Left/right: the neighbour in the same row, clamped at both ends. */
function stepWithinRank(nodes: readonly NavNode[], current: NavNode, step: number): string {
	const row = nodes.filter((n) => n.rank === current.rank).sort((a, b) => a.x - b.x);
	const target = row.findIndex((n) => n.id === current.id) + step;
	return row[target]?.id ?? current.id;
}

/** Up/down: the nearest node by centre in the adjacent row, clamped at both ends. */
function nearestInRank(nodes: readonly NavNode[], current: NavNode, step: number): string {
	const target = current.rank + step;
	const from = centre(current);
	let best: NavNode | null = null;
	for (const n of nodes) {
		if (n.rank !== target) continue;
		if (best === null || Math.abs(centre(n) - from) < Math.abs(centre(best) - from)) best = n;
	}
	return best?.id ?? current.id;
}

/** Keys that activate the focused node, matching native `<button>` behaviour. */
export function isActivationKey(key: string): boolean {
	return key === "Enter" || key === " ";
}

// ── zoom ────────────────────────────────────────────────────────────────────

/** Zoom bounds. Below the floor labels are unreadable; above the ceiling one node fills the panel. */
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 3;
/** Multiplier for one zoom-button press or one wheel notch. */
export const ZOOM_STEP = 1.2;

export function clampZoom(zoom: number): number {
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export function zoomBy(zoom: number, factor: number): number {
	return clampZoom(zoom * factor);
}

/** Wheel up (negative deltaY) zooms in, wheel down zooms out. */
export function wheelZoomFactor(deltaY: number): number {
	return deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
}
