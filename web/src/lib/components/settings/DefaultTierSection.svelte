<script lang="ts">
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";

	let { defaultTier = $bindable() }: { defaultTier: string } = $props();

	const TIERS = ["fast", "balanced", "powerful"] as const;

	const flash = createSaveFlash();

	// Single-control setting — auto-saves on change with inline
	// confirmation (locked decision 5); the "Save Tier" button is gone.
	async function selectTier(tier: string) {
		if (defaultTier === tier) return;
		const previous = defaultTier;
		defaultTier = tier;
		const ok = await flash.run(() => upsertSetting("provider:defaultTier", tier));
		if (!ok) defaultTier = previous; // roll back the optimistic mutation
	}
</script>

<SettingsSection
	id="tier"
	title="Default Model Tier"
	tooltip="Controls which quality tier is used when a conversation doesn't specify a model. 'Fast' uses cheaper, lower-latency models. 'Balanced' is the default middle ground. 'Powerful' uses the most capable (and expensive) models. Overridden by any explicit model selection in a conversation."
	description="Choose the default tier when no model is explicitly selected. Changes save automatically."
>
	<div class="flex items-center gap-1">
		{#each TIERS as tier}
			<button
				onclick={() => selectTier(tier)}
				disabled={flash.saving}
				class="rounded-md px-4 py-2 text-sm font-medium transition-colors
					{defaultTier === tier
						? 'bg-blue-600 text-white'
						: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]'}"
			>
				{tier.charAt(0).toUpperCase() + tier.slice(1)}
			</button>
		{/each}
		<span class="ml-2"><SaveIndicator saving={flash.saving} saved={flash.saved} error={flash.error} /></span>
	</div>
</SettingsSection>
