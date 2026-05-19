<script lang="ts">
	import { slide } from "svelte/transition";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";

	let { content, streaming = false }: { content: string; streaming?: boolean } = $props();

	let expanded = $state(false);

	// Auto-expand while streaming, allow manual toggle for historical
	let isOpen = $derived(streaming || expanded);

	let contentPreview = $derived.by((): string => {
		const first = content.slice(0, 80).replace(/\n/g, " ").trim();
		return first.length < content.length ? first + "..." : first;
	});
</script>

<div class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden">
	<!-- Collapsed header -->
	<button
		type="button"
		onclick={() => expanded = !expanded}
		class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-secondary)]/50 transition-colors"
		aria-expanded={isOpen}
	>
		<!-- Brain icon -->
		{#if streaming}
			<svg class="h-4 w-4 shrink-0 text-[var(--color-accent)] animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
			</svg>
		{:else}
			<svg class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
			</svg>
		{/if}

		<!-- Label + preview -->
		<span class="shrink-0 text-[var(--color-text-secondary)] font-medium">Thinking</span>
		{#if !isOpen}
			<span class="truncate text-[var(--color-text-muted)] text-xs font-normal">{contentPreview}</span>
		{/if}

		<!-- Expand indicator -->
		<svg
			class="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform {isOpen ? 'rotate-180' : ''}"
			fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
		</svg>
	</button>

	<!-- Expanded content -->
	{#if isOpen}
		<div transition:slide={{ duration: 150 }} class="border-t border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] max-h-96 overflow-y-auto">
			<MarkdownRenderer content={content} {streaming} />
		</div>
	{/if}
</div>
