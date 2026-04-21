<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { sendToolPermissionResponse } from "$lib/stores.svelte.js";
	import { getSecurityNote, extractInputSummary } from "./utils.js";

	let { toolCall }: { toolCall: ToolCallState } = $props();
	let loading = $state(false);

	let securityNote = $derived(getSecurityNote(toolCall.category));

	let inputSummary = $derived(extractInputSummary(toolCall.input) ?? '');

	async function handleAllow() {
		if (!toolCall.id) return;
		loading = true;
		await sendToolPermissionResponse(toolCall.id, true);
	}

	async function handleDeny() {
		if (!toolCall.id) return;
		await sendToolPermissionResponse(toolCall.id, false);
	}
</script>

<div class="rounded-md border border-amber-500/40 bg-amber-900/10 overflow-hidden">
	<div class="px-3 py-2">
		<div class="flex items-center gap-2 mb-2">
			<svg class="h-4 w-4 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
			</svg>
			<span class="text-sm font-medium text-[var(--color-text-primary)]">{toolCall.toolName}</span>
			{#if toolCall.category}
				<span class="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300">{toolCall.category}</span>
			{/if}
		</div>

		{#if inputSummary}
			<pre class="mb-2 rounded bg-[var(--color-surface-secondary)] p-2 text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap break-all max-h-32 overflow-y-auto">{inputSummary}</pre>
		{/if}

		{#if securityNote}
			<p class="mb-3 text-xs text-amber-300/80">{securityNote}</p>
		{/if}

		<div class="flex gap-2">
			<button
				onclick={handleAllow}
				disabled={loading}
				class="rounded px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-500 text-white transition-colors disabled:opacity-50"
			>
				{loading ? 'Allowing...' : 'Allow'}
			</button>
			<button
				onclick={handleDeny}
				disabled={loading}
				class="rounded px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-50"
			>
				Deny
			</button>
		</div>
	</div>
</div>
