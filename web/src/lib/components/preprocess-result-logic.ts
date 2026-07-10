/**
 * Pure logic for the `preprocess-result` message-row render branch in
 * ChatMessage.svelte (deterministic extension pre-processing).
 *
 * The host persists one synthetic row per preprocessor invocation with
 * `content` = JSON `{ extensionName, toolName, cardType?, ok, output }`
 * (src/runtime/stream-chat/preprocess.ts). This module parses that
 * payload and synthesizes the `ToolCallState` the tool-card router
 * renders:
 *
 *   - ok:true  → status "complete" + the declared cardType, so
 *     `getCardComponentName` routes to the specialized card
 *     (grade-delta-chart → GradeDeltaCard) or DefaultCard when the
 *     tool declared none.
 *   - ok:false → status "error" with NO cardType — DefaultCard's error
 *     state is the honest rendering for a failed preprocess (the
 *     output carries the error text).
 *
 * Malformed rows return null so the component renders a minimal
 * "unreadable" notice instead of a blank turn (same defensive shape as
 * `parseEzActionResult`).
 */

import type { ToolCallState } from "$lib/stores.svelte.js";

export interface PreprocessResultRow {
	extensionName: string;
	toolName: string;
	cardType?: string;
	ok: boolean;
	output: string;
}

/** Parse a preprocess-result row's JSON content. Null on malformed input. */
export function parsePreprocessResult(raw: string): PreprocessResultRow | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const p = parsed as Record<string, unknown>;
	if (typeof p.extensionName !== "string" || p.extensionName.length === 0) return null;
	if (typeof p.toolName !== "string" || p.toolName.length === 0) return null;
	if (typeof p.ok !== "boolean") return null;
	if (typeof p.output !== "string") return null;
	if (p.cardType !== undefined && typeof p.cardType !== "string") return null;
	return {
		extensionName: p.extensionName,
		toolName: p.toolName,
		...(typeof p.cardType === "string" ? { cardType: p.cardType } : {}),
		ok: p.ok,
		output: p.output,
	};
}

/**
 * Synthesize the ToolCallState the tool-card router consumes. NO `id`
 * on purpose: the full output lives in the message row itself, and an
 * id would make DefaultCard's expand handler fire a pointless
 * `/api/tool-calls/<id>/output` fetch for a row that has no tool_calls
 * anchor.
 */
export function toToolCallState(row: PreprocessResultRow): ToolCallState {
	if (row.ok) {
		return {
			toolName: `${row.extensionName}__${row.toolName}`,
			status: "complete",
			output: row.output,
			startedAt: 0,
			...(row.cardType !== undefined ? { cardType: row.cardType } : {}),
		};
	}
	return {
		toolName: `${row.extensionName}__${row.toolName}`,
		status: "error",
		error: row.output,
		output: row.output,
		startedAt: 0,
	};
}

/**
 * One-step helper for the template: parse the row content and build the
 * router-ready state, or null when unreadable.
 */
export function parsePreprocessToolCall(content: string): ToolCallState | null {
	const row = parsePreprocessResult(content);
	return row === null ? null : toToolCallState(row);
}
