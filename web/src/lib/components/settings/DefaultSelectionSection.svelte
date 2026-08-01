<script lang="ts">
	/**
	 * Settings → Models: what a user with NO saved model pick starts on
	 * (`provider:defaultSelection`).
	 *
	 * This is the REVERT knob for the riskiest behaviour change in routing:
	 * unset users now default to Auto, so their first turn is routed instead of
	 * pinned to `models[0]`. An operator who dislikes that must be able to put it
	 * back without a deploy — which is only true if the editor says what each
	 * choice DOES, so the two options are rendered as described radio cards
	 * rather than a toggle labelled with a settings key.
	 *
	 * Auto-saves on change (locked decision 5) with an optimistic mutation rolled
	 * back on failure, exactly like the sibling tier/order/ladder sections.
	 */
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";
	import {
		DEFAULT_SELECTION_MODES,
		DEFAULT_SELECTION_SETTING_KEY,
		type DefaultSelectionMode,
	} from "$lib/model-selector-logic.js";

	let { defaultSelection = $bindable() }: { defaultSelection: DefaultSelectionMode } = $props();

	const flash = createSaveFlash();

	const COPY: Record<DefaultSelectionMode, { label: string; detail: string }> = {
		auto: {
			label: "Auto (smart routing)",
			detail:
				"A fresh chat starts on Auto: EZCorp picks the tier for the first turn, then pins " +
				"that model for the rest of the thread. Routing only ever sees traffic this way.",
		},
		first: {
			label: "First available model",
			detail:
				"The behaviour from before routing existed: pin the top model in the picker. " +
				"Nothing is routed unless the user chooses Auto themselves.",
		},
	};

	async function select(mode: DefaultSelectionMode) {
		if (defaultSelection === mode) return;
		const previous = defaultSelection;
		defaultSelection = mode;
		const ok = await flash.run(() => upsertSetting(DEFAULT_SELECTION_SETTING_KEY, mode));
		if (!ok) defaultSelection = previous; // roll back the optimistic mutation
	}
</script>

<SettingsSection
	id="default-selection"
	title="New Chat Model Default"
	tooltip="Applies only to users who have never picked a model. An explicit pick — including a deliberate Auto — always wins, and a conversation that already has a model keeps it. Every member reads this value, so switching to 'First available model' reverts routed-by-default traffic instance-wide without a deploy."
	description="What the composer starts on when a user has no saved model. Changes save automatically and apply to their next new chat."
>
	<div class="space-y-2" role="radiogroup" aria-label="New chat model default">
		{#each DEFAULT_SELECTION_MODES as mode (mode)}
			{@const active = defaultSelection === mode}
			<button
				type="button"
				role="radio"
				aria-checked={active}
				data-testid="default-selection-{mode}"
				onclick={() => select(mode)}
				disabled={flash.saving}
				class="flex w-full items-start gap-3 rounded-md border px-4 py-3 text-left transition-colors disabled:opacity-60
					{active
						? 'border-blue-600 bg-blue-600/10'
						: 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-text-muted)]'}"
			>
				<span
					class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border
						{active ? 'border-blue-600' : 'border-[var(--color-text-muted)]'}"
					aria-hidden="true"
				>
					{#if active}<span class="h-2 w-2 rounded-full bg-blue-600"></span>{/if}
				</span>
				<span>
					<span class="block text-sm font-medium text-[var(--color-text-primary)]">
						{COPY[mode].label}
					</span>
					<span class="mt-0.5 block text-xs text-[var(--color-text-secondary)]">
						{COPY[mode].detail}
					</span>
				</span>
			</button>
		{/each}
	</div>
	<div class="mt-2 min-h-4">
		<SaveIndicator saving={flash.saving} saved={flash.saved} error={flash.error} />
	</div>
</SettingsSection>
