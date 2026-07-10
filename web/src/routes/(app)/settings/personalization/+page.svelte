<script lang="ts">
	import { fetchSettings } from "$lib/api.js";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import GlobalInstructionsSection from "$lib/components/settings/GlobalInstructionsSection.svelte";
	import BriefingCardSection from "$lib/components/settings/BriefingCardSection.svelte";
	import ModesSection from "$lib/components/settings/ModesSection.svelte";
	import AuditVisibilitySection from "$lib/components/settings/AuditVisibilitySection.svelte";
	import AdvancedSection from "$lib/components/settings/AdvancedSection.svelte";
	import ComposerSuggestSection from "$lib/components/settings/ComposerSuggestSection.svelte";
	import { scrollToLocationHash } from "$lib/scroll-to-hash.js";

	let pageLoading = $state(true);
	let globalPrompt = $state("");
	let showObservability = $state(false);
	let agentAutonomyEnabled = $state(true);
	let showBuiltinPills = $state(true);
	let showInstalledPills = $state(false);
	let eventAuditSampleN = $state(100);
	let suggestEnabled = $state(true);

	$effect(() => {
		(async () => {
			try {
				const settings = await fetchSettings();
				globalPrompt = (settings["global:systemPrompt"] as string) ?? "";
				showObservability = (settings["global:showObservability"] as boolean) ?? false;
				agentAutonomyEnabled = settings["global:agentAutonomyEnabled"] !== false;
				// Audit & visibility defaults match the Phase 52.5 spec:
				// built-in pills ON, installed pills OFF, sample 1-in-100.
				showBuiltinPills = settings["global:showBuiltinCapabilityEvents"] !== false;
				showInstalledPills = settings["global:showInstalledCapabilityEvents"] === true;
				const sampleN = settings["global:eventSubscriptionAuditSampleN"];
				eventAuditSampleN = typeof sampleN === "number" && sampleN >= 1 && sampleN <= 10000
					? Math.floor(sampleN)
					: 100;
				// Composer suggestions default ON — only an explicit true disables
				// the disable (i.e. anything but `false` keeps the feature on),
				// mirroring getSuggestConfig's server-side read.
				suggestEnabled = settings["suggest:enabled"] !== false;
			} catch { /* silent */ }
			pageLoading = false;
			scrollToLocationHash();
		})();
	});
</script>

{#if pageLoading}
	<SkeletonLoader type="form" />
{:else}
	<GlobalInstructionsSection bind:globalPrompt />
	<ModesSection />
	<ComposerSuggestSection bind:suggestEnabled />
	<BriefingCardSection />
	<AuditVisibilitySection bind:showBuiltinPills bind:showInstalledPills bind:eventAuditSampleN />
	<AdvancedSection bind:showObservability bind:agentAutonomyEnabled />
{/if}
