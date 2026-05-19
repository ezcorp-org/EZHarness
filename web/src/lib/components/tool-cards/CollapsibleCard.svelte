<script lang="ts">
	import type { Snippet } from "svelte";
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { slide } from "svelte/transition";
	import { extractCommandText } from "./utils.js";

	let { toolCall, children }: { toolCall: ToolCallState; children: Snippet } = $props();

	// Dev-command cards (terminal / diff / search-results) are noisy. They
	// always render collapsed in the chat thread — even while running — so the
	// stream stays scannable. A spinner in the header signals in-flight work.
	let expanded = $state(false);

	let durationText = $derived(
		toolCall.duration != null ? `${(toolCall.duration / 1000).toFixed(1)}s` : undefined,
	);

	// The EXACT, full command — shown verbatim in a code block that is
	// always visible (collapsed AND expanded), never truncated, so it
	// always matches the command the tool was invoked with.
	let commandText = $derived(extractCommandText(toolCall.input));
</script>

<div
	data-testid="collapsible-card"
	class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden"
>
	<button
		data-testid="collapsible-card-toggle"
		onclick={() => (expanded = !expanded)}
		class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-secondary)]/50 transition-colors"
		aria-expanded={expanded}
		aria-busy={toolCall.status === "running"}
	>
		<!-- Status icon -->
		{#if toolCall.status === "running"}
			<svg class="h-4 w-4 shrink-0 text-[var(--color-accent)] animate-spin" fill="none" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
			</svg>
		{:else if toolCall.status === "complete"}
			<svg class="h-4 w-4 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
			</svg>
		{:else}
			<svg class="h-4 w-4 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
			</svg>
		{/if}

		<!-- Tool name -->
		<span class="shrink-0 text-[var(--color-text-secondary)] font-medium">{toolCall.toolName}</span>

		<div class="ml-auto flex items-center gap-1">
			{#if toolCall.status === "running"}
				<span class="shrink-0 text-xs text-[var(--color-text-muted)] italic">Running…</span>
			{:else if durationText}
				<span class="shrink-0 text-xs text-[var(--color-text-muted)]">{durationText}</span>
			{/if}
			<svg
				class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform {expanded ? 'rotate-180' : ''}"
				fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
			>
				<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
			</svg>
		</div>
	</button>

	<!-- Full command, verbatim. Always visible (collapsed AND expanded),
	     wraps instead of truncating so it always matches the command used. -->
	{#if commandText}
		<div class="px-3 pb-2">
			<code
				data-testid="collapsible-card-command"
				class="block w-full overflow-x-auto rounded bg-[var(--color-surface-secondary)] px-2 py-1.5 font-mono text-xs leading-relaxed text-[var(--color-text-secondary)] whitespace-pre-wrap break-all"
			>{commandText}</code>
		</div>
	{/if}

	{#if expanded}
		<div transition:slide={{ duration: 150 }} class="border-t border-[var(--color-border)] p-2">
			{@render children()}
		</div>
	{/if}
</div>
