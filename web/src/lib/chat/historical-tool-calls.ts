import type { ToolCallState } from "$lib/stores.svelte.js";
import { inlineToolStore } from "$lib/inline-tool-store.svelte.js";

/**
 * Map hydrated `InlineToolCall`s for a given message into the
 * `ToolCallState[]` shape `<ChatMessage>` accepts. Extracted from
 * `routes/(app)/project/[id]/chat/[convId]/+page.svelte` so the floating
 * Ez panel can render historical tool cards on the same DB-backed data.
 *
 * Keep this thin — the calling component owns the trigger (initial load,
 * post-`run:complete` reconcile) and the actual fetch; this only converts
 * the store's persisted shape into the prop shape.
 */
export function getHistoricalToolCalls(messageId: string): ToolCallState[] {
	const calls = inlineToolStore.getByMessage(messageId);
	if (calls.length === 0) return [];
	return calls.map((c, i) => ({
		id: c.id,
		toolName: c.toolName,
		status:
			c.status === "complete"
				? ("complete" as const)
				: c.status === "error"
					? ("error" as const)
					: ("running" as const),
		input: c.input,
		output: c.output,
		error: c.error,
		startedAt: c.startedAt ?? i,
		duration: c.duration,
		extensionId: c.extensionName,
		cardType: c.cardType,
		// Preserve cardLayout so ToolCallCard's `routeToDock` derived can fire
		// for persisted dock-routed cards (canvas-dock-sdk.md §5).
		cardLayout: c.cardLayout,
	}));
}
