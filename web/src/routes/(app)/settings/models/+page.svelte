<script lang="ts">
	import { goto } from "$app/navigation";
	import { fetchSettings } from "$lib/api.js";
	import { requireAdmin } from "$lib/admin-guard.js";
	import { settingsDefaultRoute } from "$lib/settings-nav.js";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import ProvidersSection from "$lib/components/settings/ProvidersSection.svelte";
	import DefaultTierSection from "$lib/components/settings/DefaultTierSection.svelte";
	import PreferenceOrderSection from "$lib/components/settings/PreferenceOrderSection.svelte";
	import TierLadderSection from "$lib/components/settings/TierLadderSection.svelte";
	import RoutingExperimentsSection from "$lib/components/settings/RoutingExperimentsSection.svelte";
	import DefaultSelectionSection from "$lib/components/settings/DefaultSelectionSection.svelte";
	import ToolResultCapSection from "$lib/components/settings/ToolResultCapSection.svelte";
	import CustomModelsSection from "$lib/components/settings/CustomModelsSection.svelte";
	import { scrollToLocationHash } from "$lib/scroll-to-hash.js";
	import { DEFAULT_PREFERENCE_ORDER, mergePreferenceOrder, type CustomModelEntry } from "$lib/settings-models.js";
	import {
		emptyTierLadder,
		parseTierLadder,
		TIER_LADDER_SETTING_KEY,
		type TierLadder,
	} from "$server/runtime/routing/tier-ladder";
	import {
		DEFAULT_EXPLORATION_RATE,
		EXPLORATION_RATE_SETTING_KEY,
		parseExplorationRate,
	} from "$server/runtime/routing/exploration";
	import {
		parseShadowThresholds,
		ROUTING_SHADOW_SETTING_KEY,
	} from "$server/runtime/routing/shadow";
	import type { TierThresholds } from "$server/runtime/tier-classifier";
	import {
		DEFAULT_SELECTION_FALLBACK,
		DEFAULT_SELECTION_SETTING_KEY,
		parseDefaultSelection,
		type DefaultSelectionMode,
	} from "$server/runtime/routing/default-selection";
	import {
		DEFAULT_TOOL_RESULT_CAP,
		TOOL_RESULT_CAP_SETTING_KEY,
		parseToolResultCap,
	} from "$server/runtime/stream-chat/tool-result-cap";

	let pageLoading = $state(true);
	/** Set when the settings read fails for an ADMIN. Rendering the editors
	 *  anyway would show every control at its DEFAULT — "exploration off,
	 *  ladder unconfigured" — which is indistinguishable from those being the
	 *  real stored values, so an operator could believe exploration is off
	 *  while it is live. Fail visibly instead. */
	let loadError = $state<string | null>(null);
	let defaultTier = $state<string>("balanced");
	let defaultSelection = $state<DefaultSelectionMode>(DEFAULT_SELECTION_FALLBACK);
	let toolResultCap = $state<number>(DEFAULT_TOOL_RESULT_CAP);
	let preferenceOrder = $state<string[]>([...DEFAULT_PREFERENCE_ORDER]);
	let tierLadder = $state<TierLadder>(emptyTierLadder());
	let explorationRate = $state<number>(DEFAULT_EXPLORATION_RATE);
	let shadowThresholds = $state<TierThresholds | undefined>(undefined);
	let customModels = $state<CustomModelEntry[]>([]);
	let ollamaUrl = $state("http://localhost:11434");

	$effect(() => {
		(async () => {
			// Every control here reads and writes admin-only endpoints, so a
			// member reaching this URL directly is bounced to the first page they
			// can actually open rather than shown a page of defaults they cannot
			// save. The nav hides the entry too; this covers the direct hit.
			if (!(await requireAdmin())) {
				goto(settingsDefaultRoute(false), { replaceState: true });
				return;
			}
			try {
				const settings = await fetchSettings();
				defaultTier = (settings["provider:defaultTier"] as string) ?? "balanced";
				const storedOrder = settings["provider:preferenceOrder"] as string[] | undefined;
				preferenceOrder =
					storedOrder && storedOrder.length > 0
						? mergePreferenceOrder(storedOrder)
						: [...DEFAULT_PREFERENCE_ORDER];
				// A malformed stored ladder degrades to the empty (unconfigured)
				// editor rather than throwing the page — same posture as routing.
				tierLadder = parseTierLadder(settings[TIER_LADDER_SETTING_KEY]) ?? emptyTierLadder();
				// Same tolerant posture for the two experiment keys: a malformed
				// row reads as OFF here exactly as it does at the routing seam.
				explorationRate = parseExplorationRate(settings[EXPLORATION_RATE_SETTING_KEY]);
				shadowThresholds = parseShadowThresholds(settings[ROUTING_SHADOW_SETTING_KEY]);
				// Both editors show the value the RUNTIME would read, so they use the
				// runtime's own tolerant parsers: an unset or malformed row renders as
				// the effective default rather than as a blank control.
				defaultSelection = parseDefaultSelection(settings[DEFAULT_SELECTION_SETTING_KEY]);
				toolResultCap = parseToolResultCap(settings[TOOL_RESULT_CAP_SETTING_KEY]);
				customModels = (settings["provider:customModels"] as CustomModelEntry[]) ?? [];
				ollamaUrl = (settings["provider:ollamaUrl"] as string) ?? "http://localhost:11434";
			} catch (e) {
				loadError = e instanceof Error ? e.message : "Could not load settings.";
			}
			pageLoading = false;
			scrollToLocationHash();
		})();
	});
</script>

{#if pageLoading}
	<SkeletonLoader type="form" />
{:else if loadError}
	<!-- Deliberately renders INSTEAD of the editors. Showing them on a failed
	     read would display defaults that look like real stored values. -->
	<!-- Same tinted treatment RoutingExperimentsSection uses (ERROR_CLASS):
	     plain red body text clears contrast on one theme and fails on the other. -->
	<div
		role="alert"
		data-testid="models-settings-load-error"
		class="rounded-md border-l-2 border-red-500 bg-red-500/10 px-3 py-2 text-[var(--color-text-primary)]"
	>
		<p class="text-sm font-semibold text-[var(--color-text-primary)]">
			Could not load these settings.
		</p>
		<p class="mt-1 text-sm text-[var(--color-text-secondary)]">
			The editors are hidden because they would show default values, not what is
			actually saved. {loadError}
		</p>
		<button
			type="button"
			class="mt-3 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-tertiary)]"
			onclick={() => location.reload()}
		>
			Retry
		</button>
	</div>
{:else}
	<ProvidersSection bind:customModels bind:ollamaUrl />
	<DefaultSelectionSection bind:defaultSelection />
	<DefaultTierSection bind:defaultTier />
	<PreferenceOrderSection bind:preferenceOrder />
	<TierLadderSection bind:tierLadder {preferenceOrder} />
	<RoutingExperimentsSection bind:explorationRate bind:shadowThresholds />
	<ToolResultCapSection bind:toolResultCap />
	<CustomModelsSection bind:customModels />
{/if}
