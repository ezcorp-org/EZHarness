<script lang="ts">
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";

	let { defaultTier = $bindable() }: { defaultTier: string } = $props();

	const TIERS = ["fast", "balanced", "powerful"] as const;

	let savingTier = $state(false);

	async function saveTier() {
		savingTier = true;
		try { await upsertSetting("provider:defaultTier", defaultTier); }
		finally { savingTier = false; }
	}
</script>

<SettingsSection
	id="tier"
	title="Default Model Tier"
	tooltip="Controls which quality tier is used when a conversation doesn't specify a model. 'Fast' uses cheaper, lower-latency models. 'Balanced' is the default middle ground. 'Powerful' uses the most capable (and expensive) models. Overridden by any explicit model selection in a conversation."
	description="Choose the default tier when no model is explicitly selected."
>
	<div class="flex items-center gap-1">
		{#each TIERS as tier}
			<button
				onclick={() => { defaultTier = tier; }}
				class="rounded-md px-4 py-2 text-sm font-medium transition-colors
					{defaultTier === tier
						? 'bg-blue-600 text-white'
						: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]'}"
			>
				{tier.charAt(0).toUpperCase() + tier.slice(1)}
			</button>
		{/each}
	</div>
	<button
		onclick={saveTier}
		disabled={savingTier}
		class="mt-3 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
	>
		{savingTier ? "Saving..." : "Save Tier"}
	</button>
</SettingsSection>
