<script lang="ts">
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";
	import { PROVIDER_META } from "$lib/provider-meta.js";

	let { preferenceOrder = $bindable() }: { preferenceOrder: string[] } = $props();

	const flash = createSaveFlash();

	// Single-control setting — each reorder auto-saves with inline
	// confirmation (locked decision 5); the "Save Order" button is gone.
	async function moveProvider(index: number, direction: -1 | 1) {
		const newIndex = index + direction;
		if (newIndex < 0 || newIndex >= preferenceOrder.length) return;
		const previous = preferenceOrder;
		const copy = [...preferenceOrder];
		[copy[index], copy[newIndex]] = [copy[newIndex]!, copy[index]!];
		preferenceOrder = copy;
		const ok = await flash.run(() => upsertSetting("provider:preferenceOrder", copy));
		if (!ok) preferenceOrder = previous; // roll back the optimistic mutation
	}
</script>

<SettingsSection
	id="order"
	title="Provider Preference Order"
	tooltip="When multiple providers have keys configured, this determines which provider is tried first for a given tier. If the first provider fails or is unavailable, the next in order is used as a fallback. Reorder to match your preference for cost, speed, or quality."
	description="Set the order in which providers are tried during routing. Use the arrows to reorder — changes save automatically."
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
	<div class="mt-2 min-h-4">
		<SaveIndicator saving={flash.saving} saved={flash.saved} error={flash.error} />
	</div>
</SettingsSection>
