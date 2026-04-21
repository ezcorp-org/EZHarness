<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { browseMarketplace, importManifest, type MarketplaceListing } from "$lib/api.js";
	import MarketplaceCard from "$lib/components/MarketplaceCard.svelte";
	import CategoryGrid from "$lib/components/CategoryGrid.svelte";
	import EmptyState from "$lib/components/EmptyState.svelte";

	let query = $state("");
	let category = $state<string | null>(null);
	let sort = $state<string>("popular");
	let listings = $state<MarketplaceListing[]>([]);
	let featured = $state<MarketplaceListing[]>([]);
	let loading = $state(true);
	let offset = $state(0);
	let hasMore = $state(false);
	let importError = $state("");
	let loadError = $state("");

	const LIMIT = 20;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	async function loadListings(reset = true) {
		loading = true;
		loadError = "";
		if (reset) offset = 0;
		try {
			const result = await browseMarketplace({
				q: query || undefined,
				category: category ?? undefined,
				sort,
				limit: LIMIT,
				offset,
			});
			if (reset) {
				listings = result.listings;
			} else {
				listings = [...listings, ...result.listings];
			}
			if (result.featured && offset === 0 && !query && !category) {
				featured = result.featured;
			}
			hasMore = result.listings.length === LIMIT;
		} catch (e) {
			loadError = e instanceof Error ? e.message : "Failed to load listings";
			if (reset) listings = [];
		}
		loading = false;
	}

	function onSearchInput() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => loadListings(), 300);
	}

	function onCategorySelect(cat: string | null) {
		category = cat;
		loadListings();
	}

	function onSortChange() {
		loadListings();
	}

	function loadMore() {
		offset += LIMIT;
		loadListings(false);
	}

	async function handleImport() {
		importError = "";
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const manifest = JSON.parse(text);
				const result = await importManifest(manifest);
				goto(`/agents/${encodeURIComponent(result.agentConfig.name)}`);
			} catch (e) {
				importError = e instanceof Error ? e.message : "Import failed";
			}
		};
		input.click();
	}

	let showFeatured = $derived(!query && !category && featured.length > 0);

	onMount(() => {
		loadListings();
	});
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between gap-4">
		<h1 class="text-2xl font-bold text-[var(--color-text-primary)]">Marketplace</h1>
		<button
			onclick={handleImport}
			class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-2 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border)]" style="min-height: 44px;"
		>
			Import Agent
		</button>
	</div>

	{#if importError}
		<p class="text-sm text-red-400">{importError}</p>
	{/if}
	{#if loadError}
		<p class="text-sm text-red-400">{loadError}</p>
	{/if}

	<!-- Search and Sort -->
	<div class="flex items-center gap-3">
		<div class="relative flex-1">
			<svg
				class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]"
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
				/>
			</svg>
			<input
				type="text"
				bind:value={query}
				oninput={onSearchInput}
				placeholder="Search agents..."
				class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] py-2 pl-10 pr-4 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
			/>
		</div>
		<select
			bind:value={sort}
			onchange={onSortChange}
			class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-2 text-sm text-[var(--color-text-secondary)] focus:border-[var(--color-accent)] focus:outline-none"
		>
			<option value="popular">Most Popular</option>
			<option value="rating">Highest Rated</option>
			<option value="newest">Newest</option>
		</select>
	</div>

	<!-- Featured Section -->
	{#if showFeatured}
		<section>
			<h2 class="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">Featured</h2>
			<div class="flex gap-4 overflow-x-auto pb-2">
				{#each featured as item (item.id)}
					<div class="w-72 shrink-0">
						<MarketplaceCard listing={item} />
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Category Filter -->
	<section>
		<h2 class="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">Categories</h2>
		<CategoryGrid selected={category} onselect={onCategorySelect} />
	</section>

	<!-- Results -->
	<section>
		{#if loading && listings.length === 0}
			<div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
				{#each Array(6) as _}
					<div class="animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
						<div class="mb-2 h-5 w-3/4 rounded bg-[var(--color-surface-tertiary)]"></div>
						<div class="mb-1 h-4 w-full rounded bg-[var(--color-surface-tertiary)]"></div>
						<div class="mb-3 h-4 w-2/3 rounded bg-[var(--color-surface-tertiary)]"></div>
						<div class="h-3 w-1/2 rounded bg-[var(--color-surface-tertiary)]"></div>
					</div>
				{/each}
			</div>
		{:else if listings.length === 0}
			{#if query || category}
				<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center">
					<p class="text-[var(--color-text-secondary)]">No agents found</p>
					<p class="mt-1 text-sm text-[var(--color-text-muted)]">Try adjusting your search or filters</p>
				</div>
			{:else}
				<EmptyState
					title="No listings found"
					description="The marketplace is empty. Check back later or create your own extension."
					ctaLabel="Create Extension"
					ctaHref="/extensions"
				>
					{#snippet icon()}
						<svg class="h-12 w-12 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" />
						</svg>
					{/snippet}
				</EmptyState>
			{/if}
		{:else}
			<div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
				{#each listings as item (item.id)}
					<MarketplaceCard listing={item} />
				{/each}
			</div>
			{#if hasMore}
				<div class="mt-4 text-center">
					<button
						onclick={loadMore}
						disabled={loading}
						class="rounded-md bg-[var(--color-surface-tertiary)] px-6 py-2 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border)] disabled:opacity-50"
					>
						{loading ? "Loading..." : "Load More"}
					</button>
				</div>
			{/if}
		{/if}
	</section>
</div>
