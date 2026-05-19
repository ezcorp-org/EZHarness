/**
 * Inline tool handlers — extracted from
 * `routes/(app)/project/[id]/chat/[convId]/+page.svelte` (W3 of the chat-page
 * split).
 *
 * The five handlers below back the inline tool card UI:
 *   - handleToolInvoke        — top-level "Run tool" entry point (used by
 *                               the Tools popover via `ontoolinvoke`).
 *   - handleInlineRetry       — "Retry" button on a card; replays the same
 *                               input.
 *   - handleInlineEditRetry   — "Edit & Retry" button; loads the tool
 *                               definition and parks the call in an
 *                               edit-retry slot for the form to consume.
 *   - handleEditRetryConfirm  — InlineToolForm's submit; fires a fresh
 *                               invocation with the user-edited input and
 *                               clears the slot.
 *   - handleInlineCancel      — "Cancel" button; flips the call to
 *                               `error: 'Cancelled by user'` in the store.
 *
 * The factory takes a `host` so the handlers stay pure functions while the
 * page owns the reactive state. `convId` and `activeLeafId` MUST be
 * getters — the page reads `activeLeafId` from a `$state` slot that
 * changes per turn, and `convId` from a `$derived` that updates on
 * SvelteKit `params` change. Capturing either at factory time would make
 * the handlers stale.
 *
 * `inlineToolStore` is mutated through the singleton import — same as
 * the original page — so reactivity propagates to every consumer that
 * already reads `inlineToolStore.calls`.
 */

import { inlineToolStore, type InlineToolCall } from "$lib/inline-tool-store.svelte.js";
import { invokeInlineTool } from "$lib/invoke-inline-tool.js";
import { userFetch } from "$lib/utils/fetch-policy.js";
import type { ToolDefinition } from "../../../../../src/extensions/types";

export interface EditRetrySlot {
	call: InlineToolCall | null;
	tool: ToolDefinition | null;
}

export interface InlineToolHandlerHost {
	/** Active conversation id — read fresh on every invocation. */
	convId(): string;
	/**
	 * Current leaf message id (or null). Streaming placeholder ids start
	 * with `streaming-` and are filtered out — they're not real messages
	 * and shouldn't anchor an inline tool card.
	 */
	activeLeafId(): string | null;
	/**
	 * Park (or clear) the call+tool pair the InlineToolForm reads from.
	 * Pass `(null, null)` to clear after confirm.
	 */
	setEditRetry(call: InlineToolCall | null, tool: ToolDefinition | null): void;
	/** Read the current edit-retry slot. */
	getEditRetry(): EditRetrySlot;
}

export interface InlineToolHandlers {
	handleToolInvoke(
		calls: { extensionName: string; toolName: string; input: Record<string, unknown> }[],
	): void;
	handleInlineRetry(call: InlineToolCall): void;
	handleInlineEditRetry(call: InlineToolCall): Promise<void>;
	handleEditRetryConfirm(input: Record<string, unknown>): void;
	handleInlineCancel(call: InlineToolCall): void;
}

function generateId(): string {
	return globalThis.crypto?.randomUUID?.()
		?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function makeInlineToolHandlers(host: InlineToolHandlerHost): InlineToolHandlers {
	function handleToolInvoke(
		calls: { extensionName: string; toolName: string; input: Record<string, unknown> }[],
	): void {
		// Anchor to current leaf message (skip streaming placeholders — they're not real messages)
		const leaf = host.activeLeafId();
		const leafId = leaf?.startsWith("streaming-") ? undefined : leaf;
		const conversationId = host.convId();
		for (const call of calls) {
			invokeInlineTool({
				conversationId,
				extensionName: call.extensionName,
				toolName: call.toolName,
				input: call.input,
				messageId: leafId ?? undefined,
			});
		}
	}

	function handleInlineRetry(call: InlineToolCall): void {
		invokeInlineTool({
			conversationId: call.conversationId,
			extensionName: call.extensionName,
			toolName: call.toolName,
			input: call.input,
			messageId: call.messageId,
		});
	}

	async function handleInlineEditRetry(call: InlineToolCall): Promise<void> {
		try {
			const res = await userFetch(`/api/extensions/${encodeURIComponent(call.extensionName)}/tools`);
			if (!res.ok) return;
			const { tools }: { tools: ToolDefinition[] } = await res.json();
			const tool = tools.find(t => t.name === call.toolName);
			if (tool) {
				host.setEditRetry(call, tool);
			}
		} catch {
			// silent — same as original page
		}
	}

	function handleEditRetryConfirm(input: Record<string, unknown>): void {
		const { call: editRetryCall } = host.getEditRetry();
		if (!editRetryCall) return;
		const invocationId = generateId();
		inlineToolStore.add({
			id: invocationId,
			extensionName: editRetryCall.extensionName,
			toolName: editRetryCall.toolName,
			input,
			conversationId: editRetryCall.conversationId,
			messageId: editRetryCall.messageId,
		});
		userFetch("/api/tool-invoke", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				extensionName: editRetryCall.extensionName,
				toolName: editRetryCall.toolName,
				input,
				conversationId: editRetryCall.conversationId,
				invocationId,
			}),
		}).catch(err => console.error("Edit retry failed:", err));
		host.setEditRetry(null, null);
	}

	function handleInlineCancel(call: InlineToolCall): void {
		// Mark as error in store (cancellation)
		inlineToolStore.updateFromEvent(call.id, "tool:error", {
			error: "Cancelled by user",
			duration: call.startedAt ? Date.now() - call.startedAt : 0,
		});
	}

	return {
		handleToolInvoke,
		handleInlineRetry,
		handleInlineEditRetry,
		handleEditRetryConfirm,
		handleInlineCancel,
	};
}
