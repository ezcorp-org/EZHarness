<script lang="ts">
	import { fetchSettings } from "$lib/api.js";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import ProvidersSection from "$lib/components/settings/ProvidersSection.svelte";
	import DefaultTierSection from "$lib/components/settings/DefaultTierSection.svelte";
	import PreferenceOrderSection from "$lib/components/settings/PreferenceOrderSection.svelte";
	import CustomModelsSection from "$lib/components/settings/CustomModelsSection.svelte";
	import { scrollToLocationHash } from "$lib/scroll-to-hash.js";

	type CustomModelEntry = { modelId: string; provider: string; tier: string; baseUrl?: string };

	let pageLoading = $state(true);
	let defaultTier = $state<string>("balanced");
	let preferenceOrder = $state<string[]>(["anthropic", "openai", "google"]);
	let customModels = $state<CustomModelEntry[]>([]);
	let ollamaUrl = $state("http://localhost:11434");

	$effect(() => {
		(async () => {
			try {
				const settings = await fetchSettings();
				defaultTier = (settings["provider:defaultTier"] as string) ?? "balanced";
				preferenceOrder = (settings["provider:preferenceOrder"] as string[]) ?? ["anthropic", "openai", "google"];
				customModels = (settings["provider:customModels"] as CustomModelEntry[]) ?? [];
				ollamaUrl = (settings["provider:ollamaUrl"] as string) ?? "http://localhost:11434";
			} catch { /* silent */ }
			pageLoading = false;
			scrollToLocationHash();
		})();
	});
</script>

{#if pageLoading}
	<SkeletonLoader type="form" />
{:else}
	<ProvidersSection bind:customModels bind:ollamaUrl />
	<DefaultTierSection bind:defaultTier />
	<PreferenceOrderSection bind:preferenceOrder />
	<CustomModelsSection bind:customModels />
{/if}
