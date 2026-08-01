<script lang="ts">
	/**
	 * Settings → Models: the tier ladder (`provider:tierModels`).
	 *
	 * Three ordered lists, one per routing tier. Each names the models an
	 * "Auto" turn classified into that tier should be served by, in preference
	 * order — the first entry whose model is currently available wins. A tier
	 * left empty falls through to the heuristic default shown beneath it, so
	 * this section is additive: configure only the tiers you care about.
	 *
	 * Auto-saves on every edit (locked decision 5) with an optimistic mutation
	 * rolled back on failure, exactly like the sibling tier/order sections. The
	 * whole ladder is written on every save because the setting is one row.
	 */
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";
	import { PROVIDER_META } from "$lib/provider-meta.js";
	import {
		addRung,
		formatEntry,
		heuristicTierDefaults,
		moveRung,
		removeRung,
		selectableModels,
		withTier,
		type TierLadderModelOption,
	} from "$lib/tier-ladder-view.js";
	import {
		TIER_LADDER_SETTING_KEY,
		type TierLadder,
		type TierLadderEntry,
	} from "$server/runtime/routing/tier-ladder";
	import { VALID_TIERS, type RoutingTier } from "$server/runtime/tier-classifier";

	let {
		tierLadder = $bindable(),
		preferenceOrder,
	}: { tierLadder: TierLadder; preferenceOrder: string[] } = $props();

	const flash = createSaveFlash();

	let models = $state<TierLadderModelOption[]>([]);
	/** Per-tier "add" selection, keyed by tier. */
	let picked = $state<Record<string, string>>({});

	$effect(() => {
		(async () => {
			try {
				const res = await fetch("/api/models");
				if (res.ok) models = await res.json();
			} catch {
				/* the editor still works from the stored ladder alone */
			}
		})();
	});

	const TIER_LABELS: Record<RoutingTier, string> = {
		fast: "Fast",
		balanced: "Balanced",
		powerful: "Powerful",
	};

	function providerName(provider: string): string {
		return PROVIDER_META[provider]?.name ?? provider;
	}

	/** `provider|model` — the option value the add-select round-trips. */
	function optionValue(m: TierLadderModelOption): string {
		return `${m.provider}|${m.model}`;
	}

	function parseOptionValue(value: string): TierLadderEntry | null {
		const split = value.indexOf("|");
		if (split <= 0) return null;
		return { provider: value.slice(0, split), model: value.slice(split + 1) };
	}

	async function commit(tier: RoutingTier, rungs: TierLadderEntry[]) {
		const previous = tierLadder;
		tierLadder = withTier(tierLadder, tier, rungs);
		const ok = await flash.run(() => upsertSetting(TIER_LADDER_SETTING_KEY, tierLadder));
		if (!ok) tierLadder = previous; // roll back the optimistic mutation
	}

	async function move(tier: RoutingTier, index: number, direction: -1 | 1) {
		const next = moveRung(tierLadder[tier], index, direction);
		if (next) await commit(tier, next);
	}

	async function remove(tier: RoutingTier, index: number) {
		const next = removeRung(tierLadder[tier], index);
		if (next) await commit(tier, next);
	}

	async function add(tier: RoutingTier) {
		const entry = parseOptionValue(picked[tier] ?? "");
		if (!entry) return;
		const next = addRung(tierLadder[tier], entry);
		picked = { ...picked, [tier]: "" };
		if (next) await commit(tier, next);
	}
</script>

<SettingsSection
	id="tier-ladder"
	title="Tier Model Ladder"
	tooltip="For each quality tier, the models an auto-routed turn may be served by, in preference order. The first entry whose model is available wins; entries naming a model your providers no longer offer are skipped. Leave a tier empty to keep the built-in default shown beneath it."
	description="Choose which models each tier routes to. Position 1 is tried first — use the arrows to reorder. Changes save automatically."
>
	<div class="space-y-6">
		{#each VALID_TIERS as tier (tier)}
			{@const rungs = tierLadder[tier]}
			{@const defaults = heuristicTierDefaults(models, tier, preferenceOrder)}
			<div data-testid="tier-ladder-{tier}">
				<h3 class="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
					{TIER_LABELS[tier]}
				</h3>

				{#if rungs.length > 0}
					<div class="space-y-2">
						{#each rungs as rung, i (`${rung.provider}|${rung.model}`)}
							<div
								data-testid="tier-ladder-rung"
								class="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2"
							>
								<span class="w-5 text-sm font-medium text-[var(--color-text-secondary)]">{i + 1}.</span>
								<span class="flex-1 text-sm text-[var(--color-text-primary)]">
									{rung.model}
									<span class="ml-2 text-xs text-[var(--color-text-secondary)]">{providerName(rung.provider)}</span>
								</span>
								<div class="flex gap-1">
									<button
										onclick={() => move(tier, i, -1)}
										disabled={i === 0}
										class="rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-30"
										title="Move up"
										aria-label="Move {rung.model} up"
									>
										<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
										</svg>
									</button>
									<button
										onclick={() => move(tier, i, 1)}
										disabled={i === rungs.length - 1}
										class="rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-30"
										title="Move down"
										aria-label="Move {rung.model} down"
									>
										<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
										</svg>
									</button>
									<button
										onclick={() => remove(tier, i)}
										class="rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:text-red-500"
										title="Remove"
										aria-label="Remove {rung.model}"
									>
										<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
										</svg>
									</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<p
					class="mt-2 text-xs text-[var(--color-text-secondary)]"
					data-testid="tier-ladder-default-{tier}"
				>
					{#if defaults.length > 0}
						{rungs.length > 0 ? "Falls back to" : "Default (no override)"}: {defaults
							.map(formatEntry)
							.join(", ")}
					{:else}
						{rungs.length > 0 ? "No fallback available" : "No default available — connect a provider"}
					{/if}
				</p>

				<div class="mt-2 flex items-center gap-2">
					<select
						bind:value={picked[tier]}
						data-testid="tier-ladder-pick-{tier}"
						aria-label="Add a {TIER_LABELS[tier]} model"
						class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-primary)]"
					>
						<option value="">
							{defaults[0] ? `Add a model (default: ${formatEntry(defaults[0])})` : "Add a model…"}
						</option>
						{#each selectableModels(models, tier) as m (optionValue(m))}
							<option value={optionValue(m)}>
								{m.displayName ?? m.model} — {providerName(m.provider)} ({m.tier})
							</option>
						{/each}
					</select>
					<button
						onclick={() => add(tier)}
						data-testid="tier-ladder-add-{tier}"
						disabled={!picked[tier] || flash.saving}
						class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
					>
						Add
					</button>
				</div>
			</div>
		{/each}
	</div>
	<div class="mt-2 min-h-4">
		<SaveIndicator saving={flash.saving} saved={flash.saved} error={flash.error} />
	</div>
</SettingsSection>
