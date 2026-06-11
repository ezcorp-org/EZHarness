<script lang="ts">
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import { PROVIDER_META } from "$lib/provider-meta.js";

	let { preferenceOrder = $bindable() }: { preferenceOrder: string[] } = $props();

	let savingOrder = $state(false);

	async function saveOrder() {
		savingOrder = true;
		try { await upsertSetting("provider:preferenceOrder", preferenceOrder); }
		finally { savingOrder = false; }
	}

	function moveProvider(index: number, direction: -1 | 1) {
		const newIndex = index + direction;
		if (newIndex < 0 || newIndex >= preferenceOrder.length) return;
		const copy = [...preferenceOrder];
		[copy[index], copy[newIndex]] = [copy[newIndex]!, copy[index]!];
		preferenceOrder = copy;
	}
</script>

<SettingsSection
	id="order"
	title="Provider Preference Order"
	tooltip="When multiple providers have keys configured, this determines which provider is tried first for a given tier. If the first provider fails or is unavailable, the next in order is used as a fallback. Reorder to match your preference for cost, speed, or quality."
	description="Set the order in which providers are tried during routing. Drag or use arrows to reorder."
>
	<div class="space-y-2">
		{#each preferenceOrder as provider, i}
			<div class="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
				<span class="text-sm font-medium text-[var(--color-text-secondary)] w-5">{i + 1}.</span>
				<span class="flex-1 text-sm text-[var(--color-text-primary)]">{PROVIDER_META[provider]?.name ?? provider}</span>
				<div class="flex gap-1">
					<button
						onclick={() => moveProvider(i, -1)}
						disabled={i === 0}
						class="rounded p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-30 transition-colors"
						title="Move up"
					>
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
						</svg>
					</button>
					<button
						onclick={() => moveProvider(i, 1)}
						disabled={i === preferenceOrder.length - 1}
						class="rounded p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-30 transition-colors"
						title="Move down"
					>
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
						</svg>
					</button>
				</div>
			</div>
		{/each}
	</div>
	<button
		onclick={saveOrder}
		disabled={savingOrder}
		class="mt-3 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
	>
		{savingOrder ? "Saving..." : "Save Order"}
	</button>
</SettingsSection>
