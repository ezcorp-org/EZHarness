<script lang="ts">
	import type { SearchResult } from "$lib/api.js";
	import MentionText from "./MentionText.svelte";

	let {
		results,
		loading,
		query,
		onselect,
		highlightedIndex,
	}: {
		results: SearchResult[];
		loading: boolean;
		query: string;
		onselect: (result: SearchResult) => void;
		highlightedIndex: number;
	} = $props();

	function relativeTime(dateStr: string): string {
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return "just now";
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		return `${days}d ago`;
	}
</script>

<div class="max-h-80 overflow-y-auto">
	{#if loading}
		<div class="px-4 py-6 text-center text-sm text-[var(--color-text-secondary)]">Searching...</div>
	{:else if query.length >= 2 && results.length === 0}
		<div class="px-4 py-6 text-center text-sm text-[var(--color-text-secondary)]">No results found</div>
	{:else}
		{#each results as result, i (result.id + (result.matchingMessageId ?? ""))}
			<button
				class="flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors
					{i === highlightedIndex ? 'bg-[var(--color-surface-tertiary)]' : 'hover:bg-[var(--color-surface-secondary)]'}"
				onclick={() => onselect(result)}
				data-index={i}
			>
				<div class="flex items-center justify-between gap-2">
					<span class="truncate text-sm font-medium text-[var(--color-text-primary)]"><MentionText text={result.title} /></span>
					<span class="shrink-0 text-[10px] text-[var(--color-text-muted)]">{relativeTime(result.updatedAt)}</span>
				</div>
				{#if result.snippet}
					<span class="line-clamp-2 text-xs text-[var(--color-text-secondary)] [&_mark]:bg-yellow-500/30 [&_mark]:text-yellow-200 [&_mark]:rounded-sm [&_mark]:px-0.5">
						{@html result.snippet}
					</span>
				{/if}
			</button>
		{/each}
	{/if}
</div>
