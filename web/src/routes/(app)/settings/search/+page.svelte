<script lang="ts">
	import { fetchSettings } from "$lib/api.js";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import SearchBackendSection from "$lib/components/settings/SearchBackendSection.svelte";
	import SearchDefaultsSection from "$lib/components/settings/SearchDefaultsSection.svelte";
	import { scrollToLocationHash } from "$lib/scroll-to-hash.js";
	import { readSearchDefaults, type SearchDefaultsForm } from "$lib/settings-search-config.js";

	let pageLoading = $state(true);
	let defaults = $state<SearchDefaultsForm>(readSearchDefaults({}));

	$effect(() => {
		(async () => {
			try {
				const settings = await fetchSettings();
				defaults = readSearchDefaults(settings);
			} catch {
				/* silent — admin-gated GET 403s for members; the page is
				   admin-only via the nav, this keeps a clean fallback. */
			}
			pageLoading = false;
			scrollToLocationHash();
		})();
	});
</script>

{#if pageLoading}
	<SkeletonLoader type="form" />
{:else}
	<SearchBackendSection />
	<SearchDefaultsSection bind:defaults />
{/if}
