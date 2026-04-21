<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import {
		getMarketplaceListing,
		installMarketplaceAgent,
		rateMarketplaceListing,
		exportManifest,
		type MarketplaceListing,
		type MarketplaceVersion,
	} from "$lib/api.js";
	import MarketplaceDetail from "$lib/components/MarketplaceDetail.svelte";
	import PublishDialog from "$lib/components/PublishDialog.svelte";
	import FlagDialog from "$lib/components/FlagDialog.svelte";

	let listing = $state<MarketplaceListing | null>(null);
	let versions = $state<MarketplaceVersion[]>([]);
	let userRatingObj = $state<{ thumbsUp: boolean } | null>(null);
	let userRating = $derived(userRatingObj?.thumbsUp ?? null);
	let loading = $state(true);
	let notFound = $state(false);
	let installed = $state(false);
	let actionMessage = $state("");
	let actionError = $state("");
	let showPublishDialog = $state(false);
	let showFlagDialog = $state(false);
	let isAuthenticated = $state(false);

	// Simple author/admin detection - listing authorId matches current user
	// (auth context comes from the server response including userRating)
	let isAuthor = $state(false);
	let isAdmin = $state(false);

	async function loadListing() {
		loading = true;
		notFound = false;
		try {
			const data = await getMarketplaceListing(page.params.id!);
			listing = data.listing;
			versions = data.versions;
			userRatingObj = data.userRating;
			installed = data.installed ?? false;
		} catch {
			notFound = true;
		}
		loading = false;
	}

	async function handleInstall() {
		if (!listing) return;
		actionMessage = "";
		actionError = "";
		try {
			const result = await installMarketplaceAgent(listing.id);
			installed = true;
			actionMessage = `Installed "${result.agentConfig.name}" successfully!`;
			if (result.extensionsNeeded.length > 0) {
				actionMessage += ` Note: ${result.extensionsNeeded.length} extension(s) may be needed.`;
			}
		} catch (e) {
			actionError = e instanceof Error ? e.message : "Install failed";
		}
	}

	async function handleRate(thumbsUp: boolean) {
		if (!listing) return;
		const previousRating = userRatingObj;
		// Optimistic update
		userRatingObj = { thumbsUp };
		try {
			await rateMarketplaceListing(listing.id, thumbsUp);
			// Reload to get updated counts
			await loadListing();
		} catch {
			userRatingObj = previousRating;
		}
	}

	function handleFlag() {
		showFlagDialog = true;
	}

	async function handleExport() {
		if (!listing) return;
		try {
			await exportManifest(listing.id);
		} catch (e) {
			actionError = e instanceof Error ? e.message : "Export failed";
		}
	}

	function handleUpdate() {
		showPublishDialog = true;
	}

	async function handlePublished() {
		showPublishDialog = false;
		actionMessage = "New version published!";
		await loadListing();
	}

	onMount(() => {
		loadListing();

		// Check if user is author/admin via /api/auth/me
		fetch("/api/auth/me")
			.then((r) => r.json())
			.then((me) => {
				if (me.user) isAuthenticated = true;
				if (listing && me.user?.id === listing.authorId) {
					isAuthor = true;
				}
				if (me.user?.role === "admin") {
					isAdmin = true;
				}
			})
			.catch(() => {});
	});

	// Re-check author status when listing loads
	$effect(() => {
		if (listing) {
			fetch("/api/auth/me")
				.then((r) => r.json())
				.then((me) => {
					isAuthor = me.user?.id === listing!.authorId;
					isAdmin = me.user?.role === "admin";
				})
				.catch(() => {});
		}
	});
</script>

<div class="space-y-4">
	<a href="/marketplace" class="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]">
		&larr; Back to Marketplace
	</a>

	{#if loading}
		<div class="animate-pulse space-y-4">
			<div class="h-8 w-1/3 rounded bg-[var(--color-surface-tertiary)]"></div>
			<div class="h-4 w-2/3 rounded bg-[var(--color-surface-tertiary)]"></div>
			<div class="h-40 rounded bg-[var(--color-surface-tertiary)]"></div>
		</div>
	{:else if notFound}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center">
			<p class="text-lg text-[var(--color-text-secondary)]">Listing not found</p>
			<a href="/marketplace" class="mt-2 inline-block text-sm text-blue-400 hover:text-blue-300">
				Browse marketplace
			</a>
		</div>
	{:else if listing}
		{#if actionMessage}
			<div class="rounded-md bg-green-900/40 px-4 py-3 text-sm text-green-300">
				{actionMessage}
			</div>
		{/if}
		{#if actionError}
			<div class="rounded-md bg-red-900/40 px-4 py-3 text-sm text-red-300">
				{actionError}
			</div>
		{/if}

		<MarketplaceDetail
			{listing}
			{versions}
			{userRating}
			{isAuthor}
			{isAdmin}
			{installed}
			oninstall={handleInstall}
			onrate={handleRate}
			onflag={handleFlag}
			onexport={handleExport}
			onupdate={handleUpdate}
		/>

		{#if isAuthenticated && !isAdmin && !isAuthor}
			<FlagDialog
				listingId={listing.id}
				open={showFlagDialog}
				onclose={() => (showFlagDialog = false)}
			/>
		{/if}

		{#if listing.agentConfigId}
			<PublishDialog
				agentConfigId={listing.agentConfigId}
				existingVersion={listing.latestVersion}
				open={showPublishDialog}
				onclose={() => (showPublishDialog = false)}
				onpublish={handlePublished}
			/>
		{/if}
	{/if}
</div>
