import { inlineToolStore } from "./inline-tool-store.svelte.js";

/**
 * Invoke an extension tool inline (from a card action button).
 * Mirrors the logic in +page.svelte's handleToolInvoke but can be called
 * from any component that has a conversationId.
 */
export function invokeInlineTool(params: {
	conversationId: string;
	extensionName: string;
	toolName: string;
	input: Record<string, unknown>;
	messageId?: string;
}): void {
	const invocationId = globalThis.crypto?.randomUUID?.()
		?? Math.random().toString(36).slice(2) + Date.now().toString(36);

	inlineToolStore.add({
		id: invocationId,
		extensionName: params.extensionName,
		toolName: params.toolName,
		input: params.input,
		conversationId: params.conversationId,
		messageId: params.messageId,
	});

	fetch('/api/tool-invoke', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			extensionName: params.extensionName,
			toolName: params.toolName,
			input: params.input,
			conversationId: params.conversationId,
			invocationId,
			messageId: params.messageId,
		}),
	}).then(async (res) => {
		if (!res.ok) {
			const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
			inlineToolStore.updateFromEvent(invocationId, 'tool:error', {
				error: data.error ?? `Request failed (${res.status})`,
				duration: 0,
			});
		}
	}).catch(err => {
		inlineToolStore.updateFromEvent(invocationId, 'tool:error', {
			error: err instanceof Error ? err.message : String(err),
			duration: 0,
		});
	});
}
