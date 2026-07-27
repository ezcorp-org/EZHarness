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
 * Binding contract (`src/runtime/chat-graph/types.d.ts`): an absent duration
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
 *
 * UNKNOWN, all rendered as the em dash: absent, zero, negative, non-finite.
 * Zero is in that list on purpose. Built-in tools persist
 * `tool_calls.duration_ms = 0` unconditionally, so a 0 is indistinguishable
 * from a genuinely instant call and printing "0ms" would fabricate a
 * measurement. This is the same rule as `resolveDurationMs`
 * (`$lib/timeline-normalize`), which the level-2 builder applies before the
 * value is ever serialised — deliberately duplicated as a floor here so the
 * renderer honours the contract on its own rather than trusting its input.
 */
export function formatNodeDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return DURATION_UNKNOWN;
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

/**
 * How a node activation was triggered.
 *
 * Load-bearing, not telemetry: a keyboard drill-in destroys the node the user
 * was standing on (the panel swaps to its loading state, which unmounts the
 * canvas), so the browser drops focus to `<body>` and the next canvas has to
 * take it back. A pointer activation must NOT do that — the mouse user never
 * lost anything, and moving focus for them is a yank.
 *
 * DOM focus cannot tell the two apart: clicking an SVG node focuses it too.
 * Only the handler that fired knows, so it says.
 */
export type ActivationSource = "pointer" | "keyboard";

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

// ── legend ──────────────────────────────────────────────────────────────────

/**
 * Human name for each edge kind. The graph draws three link styles and none
 * of them is self-evident, so the legend needs words for them.
 */
export const EDGE_LABEL: Record<GraphEdgeKind, string> = {
	sequence: "Next step",
	spawn: "Spawns",
	branch: "Fork",
};

/** One swatch row. `id` drives the CSS that colours/styles the sample. */
export interface LegendItem {
	/** Stable key: a `GraphNodeKind`, `GraphNodeStatus`, `GraphEdgeKind`, or `"excluded"`. */
	id: string;
	label: string;
}

/** A titled group of swatches. `sample` picks which sample shape to draw. */
export interface LegendSection {
	title: string;
	/** `bar` = the node's left accent, `dot` = the status dot, `line` = an edge. */
	sample: "bar" | "dot" | "line";
	items: LegendItem[];
}

/**
 * The legend model, derived from the SAME maps the canvas renders from
 * (`KIND_LABEL`, `STATUS_LABEL`, `EDGE_LABEL`) so a new node kind or status
 * can never show up in the graph without also showing up here.
 *
 * Pure and ordered — the component just renders it.
 */
export function legendSections(): LegendSection[] {
	return [
		{
			title: "Node",
			sample: "bar",
			items: (Object.keys(KIND_LABEL) as GraphNodeKind[]).map((k) => ({
				id: k,
				label: KIND_LABEL[k],
			})),
		},
		{
			title: "Status",
			sample: "dot",
			items: (Object.keys(STATUS_LABEL) as GraphNodeStatus[]).map((s) => ({
				id: s,
				label: STATUS_LABEL[s],
			})),
		},
		{
			title: "Link",
			sample: "line",
			items: [
				...(Object.keys(EDGE_LABEL) as GraphEdgeKind[]).map((e) => ({
					id: e,
					label: EDGE_LABEL[e],
				})),
				// Not an edge kind — a node STATE, but it reads as a line style
				// (dashed outline + dimmed), so it belongs with the other
				// stroke-based samples rather than in its own one-row section.
				{ id: "excluded", label: "Rewound away" },
			],
		},
	];
}

// ── hover detail card ───────────────────────────────────────────────────────

/** One `term: value` line in the detail card. */
export interface NodeDetailRow {
	term: string;
	value: string;
}

/**
 * The hover/focus card for a node.
 *
 * The glance line is split into `kindLabel` + `meta` rather than one string so
 * the component can colour the kind with that kind's own hue — the same colour
 * as the node's accent bar — which is what makes the card readable at a
 * glance. `body` is the node's full untruncated text (the prompt, the reply,
 * the thinking blob, the error message); absent for kinds whose label IS the
 * whole story (a tool's name, a sub-agent's name), where repeating it under
 * the title is noise.
 */
export interface NodeDetailCard {
	/** Drives the kind-coloured heading. */
	kind: GraphNodeKind;
	/** "Sub-agent". Rendered in the kind's colour. */
	kindLabel: string;
	/** "succeeded · 840ms" — the rest of the glance line, in muted text. */
	meta: string;
	title: string;
	body?: string;
	rows: NodeDetailRow[];
	/** Call-to-action for drillable nodes; absent otherwise. */
	hint?: string;
}

/** Owner of a tool call. The builders write the sentinel `"builtin"` for host tools. */
function toolOwner(extensionId: string): string {
	return extensionId === "builtin" ? "Built-in" : extensionId;
}

/**
 * Build the detail card for a node. Pure — the component only positions and
 * renders it.
 *
 * Every value comes from a field the builders actually populate; there is no
 * `meta` on chat-graph nodes today, so nothing here invents data. The `time`
 * row carries the RAW ISO string: formatting it is locale- and
 * timezone-dependent, so the component does that with `toLocaleTimeString`
 * rather than baking a fixed format into a unit-tested pure function.
 */
export function nodeDetailCard(node: GraphNode): NodeDetailCard {
	const rows: NodeDetailRow[] = [];
	const duration = formatNodeDuration(node.durationMs);

	// Glance line, minus the kind: how it went, and how long it took. An
	// unknown duration is omitted rather than shown as a dash — the Duration
	// row below already states it, and a dash in the heading reads as noise.
	const meta =
		duration === DURATION_UNKNOWN
			? STATUS_LABEL[node.status]
			: `${STATUS_LABEL[node.status]} · ${duration}`;

	if (node.kind === "tool" && node.extensionId !== undefined) {
		rows.push({ term: "Provided by", value: toolOwner(node.extensionId) });
	}
	if (node.kind === "subagent" && node.subConversationId !== undefined) {
		rows.push({ term: "Sub-chat", value: node.subConversationId });
	}
	rows.push({ term: node.stats === undefined ? "Duration" : "Took", value: duration });
	rows.push({ term: "Started", value: node.createdAt });

	// Turn roll-up (level-1 prompts). Zero counts are DROPPED rather than shown
	// as "0": a turn with no sub-agents should read as a shorter card, not as a
	// list of absences. `replies` is always shown — every turn has at least one,
	// and a 0 there is genuinely informative (the turn never produced output).
	if (node.stats !== undefined) {
		const s = node.stats;
		rows.push({ term: "Replies", value: String(s.replies) });
		if (s.toolCalls > 0) rows.push({ term: "Tool calls", value: String(s.toolCalls) });
		if (s.subAgents > 0) rows.push({ term: "Sub-agents", value: String(s.subAgents) });
		if (s.thinking > 0) rows.push({ term: "Thinking steps", value: String(s.thinking) });
	}
	if (node.excluded === true) {
		rows.push({ term: "Branch", value: "Rewound away — not sent to the model" });
	}

	// Body only where it says something the title does not:
	//   - name-like kinds (a tool's name, a sub-agent's name) ARE the title, so
	//     a body would repeat it;
	//   - prose that was never truncated is likewise already fully shown as the
	//     title — rendering it twice reads as a duplication bug.
	// So: prose kinds only, and only when the full text differs from the label.
	const proseKinds: GraphNodeKind[] = ["prompt", "assistant", "thinking", "error"];
	const full = nodeTitle(node);
	const body =
		proseKinds.includes(node.kind) && full.length > 0 && full !== node.label ? full : undefined;

	return {
		kind: node.kind,
		kindLabel: KIND_LABEL[node.kind],
		meta,
		title: node.label,
		...(body !== undefined ? { body } : {}),
		rows,
		...(node.drillable === true ? { hint: nodeAction(node) } : {}),
	};
}
