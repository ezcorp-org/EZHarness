<script lang="ts">
	import type { MarketplaceListing } from "$lib/api.js";

	let {
		listing,
		showFlagBadge = false,
	}: {
		listing: MarketplaceListing;
		showFlagBadge?: boolean;
	} = $props();

	let ratingDisplay = $derived(
		listing.ratingTotal > 0 ? `${listing.ratingPercent}%` : "New",
	);
	let displayTags = $derived((listing.tags ?? []).slice(0, 3));
</script>

<a
	href="/marketplace/{listing.id}"
	class="group block rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4 transition-colors hover:border-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)]"
>
	<div class="mb-2 flex items-start justify-between gap-2">
		<h3 class="truncate text-base font-semibold text-[var(--color-text-primary)] group-hover:text-blue-300">
			{listing.name}
		</h3>
		<div class="flex shrink-0 items-center gap-2">
			{#if showFlagBadge && listing.status === "flagged"}
				<span class="rounded bg-red-600/80 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
					Flagged
				</span>
			{/if}
			<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-xs text-[var(--color-text-secondary)]">
				v{listing.latestVersion}
			</span>
		</div>
	</div>

	<p class="mb-3 line-clamp-2 text-sm text-[var(--color-text-secondary)]">
		{listing.description}
	</p>

	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
			<span class="rounded bg-blue-900/40 px-1.5 py-0.5 text-blue-300">
				{listing.category}
			</span>
			<span class="flex items-center gap-1" title="Rating">
				<svg class="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
					<path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" />
				</svg>
				{ratingDisplay}
			</span>
			<span title="Installs">{listing.installCount} installs</span>
		</div>
		{#if listing.authorName}
			<span class="truncate text-xs text-[var(--color-text-muted)]">{listing.authorName}</span>
		{/if}
	</div>

	{#if displayTags.length > 0}
		<div class="mt-2 flex flex-wrap gap-1">
			{#each displayTags as tag}
				<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">{tag}</span>
			{/each}
		</div>
	{/if}
</a>
