/**
 * Pure shell logic for `ChatGraphPanel.svelte` — navigation frames, the
 * endpoint URL, and the quiet-notice text.
 *
 * The panel is a drill-down stack, not a single view: level 1 is the
 * conversation map, clicking a `prompt` node pushes level 2 (that turn's
 * internals), and clicking a `subagent` node pushes a WHOLE OTHER
 * conversation's level 1. All three are the same `GraphFrame` shape, so the
 * breadcrumb is just the stack rendered left-to-right.
 *
 * Everything here is pure — no fetch, no DOM, no clock — so the component
 * keeps only the `$state` wiring and stays line-coverable.
 */
import type { ChatGraph, GraphNode } from "$server/runtime/chat-graph/types";

/**
 * One entry in the drill-down stack.
 *
 * `turnId` is the level discriminator, because that is exactly what the
 * endpoint keys on: absent ⇒ level 1 (`/graph`), present ⇒ level 2
 * (`/graph?turn=…`). Storing a separate `level` field would let the two
 * disagree.
 */
export interface GraphFrame {
	/** Which conversation this frame maps. Changes when drilling into a sub-agent. */
	conversationId: string;
	/** The user message whose internals this frame shows. Absent ⇒ level 1. */
	turnId?: string;
	/** Breadcrumb crumb text. */
	label: string;
}

/** Crumb text for the level-1 frame of the conversation the panel was opened on. */
export const ROOT_FRAME_LABEL = "Conversation";

/** The bottom of the stack: level 1 of the conversation the panel is bound to. */
export function rootFrame(conversationId: string): GraphFrame {
	return { conversationId, label: ROOT_FRAME_LABEL };
}

/**
 * `GET /api/conversations/:id/graph[?turn=…]` for a frame.
 *
 * Both ids are user-controlled strings that land in a path segment / query
 * value, so both are encoded.
 */
export function graphUrl(frame: GraphFrame): string {
	const base = `/api/conversations/${encodeURIComponent(frame.conversationId)}/graph`;
	return frame.turnId === undefined ? base : `${base}?turn=${encodeURIComponent(frame.turnId)}`;
}

/** Panel heading for a frame — the level, in words. */
export function frameTitle(frame: GraphFrame | null): string {
	if (frame === null) return "Conversation graph";
	return frame.turnId === undefined ? "Conversation map" : "Turn trace";
}

/**
 * The frame a node drills into, or `null` when the node is a leaf.
 *
 * `drillable` is the contract's gate and is checked first, but the node kind
 * still decides WHERE it goes:
 *   - `prompt`   → level 2 of the SAME conversation, keyed by the message id.
 *   - `subagent` → level 1 of the CHILD conversation.
 * A `subagent` node without `subConversationId` cannot be resolved, so it is
 * treated as a leaf rather than navigating somewhere wrong.
 */
export function drillFrame(node: GraphNode, current: GraphFrame): GraphFrame | null {
	if (node.drillable !== true) return null;
	if (node.kind === "subagent") {
		if (node.subConversationId === undefined) return null;
		return { conversationId: node.subConversationId, label: node.label };
	}
	if (node.kind === "prompt") {
		return { conversationId: current.conversationId, turnId: node.id, label: node.label };
	}
	return null;
}

/** Pop the stack back to (and including) `index`. Out-of-range leaves it alone. */
export function popTo(stack: readonly GraphFrame[], index: number): GraphFrame[] {
	if (index < 0 || index >= stack.length - 1) return [...stack];
	return stack.slice(0, index + 1);
}

/**
 * Quiet notices — conditions the user should see but which are NOT errors.
 * The payload rendered fine; something about the underlying data is odd.
 */
export function graphNotices(graph: ChatGraph | null, hasCycle: boolean): string[] {
	const out: string[] = [];
	if (graph?.degraded === true) {
		out.push("Branch history is unavailable, so this map is shown as a single chain.");
	}
	if (hasCycle) {
		out.push("These messages link in a loop. The map was straightened out to draw it.");
	}
	return out;
}

/** True once a graph has loaded and it genuinely has nothing to draw. */
export function isEmptyGraph(graph: ChatGraph | null): boolean {
	return graph !== null && graph.nodes.length === 0;
}
