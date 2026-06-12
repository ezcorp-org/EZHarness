<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import EmptyState from "$lib/components/EmptyState.svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import type { HubPageListing } from "$lib/hub";

	// `/hub` is a redirect shell: load the tab list and land on the
	// first tab. With zero pages (no core providers registered, no
	// extension pages) we show an explainer instead.
	let loading = $state(true);
	let error = $state("");

	onMount(async () => {
		try {
			const res = await fetch("/api/hub/pages");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { pages: HubPageListing[] };
			const first = data.pages[0];
			if (first) {
				await goto(`/hub/${encodeURIComponent(first.id)}`, { replaceState: true });
				return;
			}
			loading = false;
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to load Hub";
			loading = false;
		}
	});
</script>

<svelte:head>
	<title>Hub - EZCorp</title>
</svelte:head>

{#if loading}
	<SkeletonLoader type="lines" lines={4} />
{:else if error}
	<EmptyState title="Hub failed to load" description={error} />
{:else}
	<EmptyState
		title="No Hub pages yet"
		description="Extensions that declare pages — and core features like the Daily Briefing — show up here as tabs."
		ctaLabel="Browse extensions"
		ctaHref="/extensions"
	/>
{/if}
