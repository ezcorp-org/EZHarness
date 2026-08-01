<script lang="ts">
	/**
	 * Settings → Models: the two routing EXPERIMENTS an operator can run
	 * against live traffic — bounded exploration (`provider:explorationRate`)
	 * and shadow mode (`provider:routingShadow`).
	 *
	 * They share a section because they share a purpose: both exist to learn
	 * whether the router is picking well. They are presented very differently
	 * on purpose, because their costs are nothing alike —
	 *
	 *  - **Exploration spends answer quality.** On an explored turn a real user
	 *    is deliberately served a weaker model than the classifier asked for.
	 *    So the cost is stated before the control, the impact of the typed rate
	 *    is spelled out in turns rather than probabilities, and turning it UP
	 *    requires ticking an acknowledgement. Turning it down or off never
	 *    does.
	 *  - **Shadow mode spends nothing.** The candidate is scored and recorded,
	 *    never served, so it is an ordinary form — its only trap is an inverted
	 *    threshold pair, which the form rejects inline (with the server's own
	 *    sentence) rather than letting the operator find it via a 400.
	 *
	 * Both settings are validated at the write route; this component never
	 * restates those rules. Pre-flight checks and the percent↔probability
	 * conversion live in `$lib/routing-experiments-view`, which imports the
	 * backend validators, so the form and the row can never disagree.
	 *
	 * Save/flash behaviour matches the sibling sections (optimistic mutation,
	 * rolled back on failure) with one addition: a rejected save shows the
	 * route's message verbatim, since for these two keys that message is the
	 * only place the operator is told WHY.
	 */
	import { deleteSetting, upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";
	import {
		explorationImpact,
		needsAcknowledgement,
		percentFromRate,
		rateFromPercent,
		readShadowForm,
		saveErrorMessage,
		shadowFormFrom,
		shadowUnchanged,
		type ExplorationLevel,
	} from "$lib/routing-experiments-view.js";
	import { EXPLORATION_RATE_SETTING_KEY } from "$server/runtime/routing/exploration";
	import { ROUTING_SHADOW_SETTING_KEY } from "$server/runtime/routing/shadow";
	import type { TierThresholds } from "$server/runtime/tier-classifier";

	let {
		explorationRate = $bindable(),
		shadowThresholds = $bindable(),
	}: { explorationRate: number; shadowThresholds: TierThresholds | undefined } = $props();

	const flash = createSaveFlash();
	let saveError = $state<string | null>(null);

	let ratePercent = $state<number | null>(percentFromRate(explorationRate));
	let acknowledged = $state(false);
	let shadowForm = $state(shadowFormFrom(shadowThresholds));

	const parsedRate = $derived(rateFromPercent(ratePercent));
	/** The impact line describes what the box would do if saved — falling back
	 *  to the live rate while the box holds something unusable. */
	const impact = $derived(explorationImpact(parsedRate.ok ? parsedRate.rate : explorationRate));
	const mustAcknowledge = $derived(
		parsedRate.ok && needsAcknowledgement(explorationRate, parsedRate.rate),
	);
	const canSaveRate = $derived(
		parsedRate.ok && parsedRate.rate !== explorationRate && (acknowledged || !mustAcknowledge),
	);

	const shadowState = $derived(readShadowForm(shadowForm));
	const canSaveShadow = $derived(
		shadowState.kind === "valid" && !shadowUnchanged(shadowForm, shadowThresholds),
	);

	/** Run a save, surfacing the write route's own rejection message. */
	async function save(fn: () => Promise<unknown>): Promise<boolean> {
		saveError = null;
		return flash.run(async () => {
			try {
				await fn();
			} catch (err) {
				saveError = saveErrorMessage(err);
				throw err;
			}
		});
	}

	async function saveRate(next: number) {
		const previous = explorationRate;
		explorationRate = next; // optimistic
		const ok = await save(() => upsertSetting(EXPLORATION_RATE_SETTING_KEY, next));
		if (!ok) explorationRate = previous; // roll back the optimistic mutation
		ratePercent = percentFromRate(explorationRate);
		acknowledged = false; // the next increase asks again
	}

	async function commitRate() {
		if (parsedRate.ok) await saveRate(parsedRate.rate);
	}

	async function saveShadow() {
		if (shadowState.kind !== "valid") return;
		const previous = shadowThresholds;
		const next = shadowState.thresholds;
		shadowThresholds = next;
		const ok = await save(() => upsertSetting(ROUTING_SHADOW_SETTING_KEY, next));
		if (!ok) shadowThresholds = previous;
		shadowForm = shadowFormFrom(shadowThresholds);
	}

	/** Shadow mode is off when the key is ABSENT, so clearing it is a DELETE —
	 *  there is no "off" value the write route would accept. */
	async function clearShadow() {
		const previous = shadowThresholds;
		shadowThresholds = undefined;
		const ok = await save(() => deleteSetting(ROUTING_SHADOW_SETTING_KEY));
		if (!ok) shadowThresholds = previous;
		shadowForm = shadowFormFrom(shadowThresholds);
	}

	/**
	 * The impact line carries its weight through a tint, not through coloured
	 * text: amber body text is illegible on the light theme's surface, and the
	 * semantic text token is the only colour that reads on both.
	 */
	const IMPACT_CLASS: Record<ExplorationLevel, string> = {
		off: "text-[var(--color-text-secondary)]",
		on: "rounded-md border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-[var(--color-text-primary)]",
		high: "rounded-md border-l-2 border-amber-500 bg-amber-500/20 px-3 py-2 font-semibold text-[var(--color-text-primary)]",
	};

	/** Rejections are tinted the same way, and for the same reason: red body
	 *  text that clears contrast on one theme fails on the other. */
	const ERROR_CLASS =
		"rounded-md border-l-2 border-red-500 bg-red-500/10 px-3 py-2 text-[var(--color-text-primary)]";

	const inputClass =
		"w-28 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none";
	const primaryButtonClass =
		"rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40";
	const secondaryButtonClass =
		"rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-40";
</script>

<SettingsSection
	id="routing-experiments"
	title="Routing Experiments"
	tooltip="Two ways to check whether Auto routing is picking well. Exploration serves a fraction of turns one tier down to gather unbiased data — it costs answer quality. Shadow mode scores a candidate threshold pair against live traffic and never serves a turn — it costs nothing. Both are off by default."
	description="Measure the router against live traffic. Each experiment saves on its own; both are off until you turn them on."
>
	<div class="space-y-8">
		<!-- ── Bounded exploration ──────────────────────────────────────── -->
		<div data-testid="exploration-editor">
			<h3 class="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
				Bounded exploration
			</h3>

			<!-- The cost comes BEFORE the control, deliberately. This knob buys
			     training data with somebody's answer quality, and an operator
			     should not be able to reach the number without reading that. -->
			<div class="mb-3 rounded-lg border border-amber-700 bg-amber-950 p-4">
				<p class="text-sm font-medium text-amber-300">This trades answer quality for data.</p>
				<p class="mt-1 text-xs text-amber-200/90">
					Explored turns are served one tier BELOW what the classifier asked for, so the router can
					be measured against what a cheaper model would have done. Real users get those weaker
					answers, and some of them will be worse. Everything the router learns from ordinary
					traffic is biased without this — but that is the trade, and it is yours to make.
				</p>
			</div>

			<p class="mb-2 text-xs text-[var(--color-text-secondary)]" data-testid="exploration-current">
				{#if explorationRate > 0}
					Live now: exploring {percentFromRate(explorationRate)}% of routed turns.
				{:else}
					Live now: exploration is off — no turn is downgraded.
				{/if}
			</p>

			<div class="flex items-center gap-2">
				<label for="exploration-rate" class="text-sm text-[var(--color-text-primary)]">
					Explore on
				</label>
				<input
					id="exploration-rate"
					type="number"
					min="0"
					max="100"
					step="0.5"
					placeholder="0"
					data-testid="exploration-rate-input"
					bind:value={ratePercent}
					disabled={flash.saving}
					class={inputClass}
				/>
				<span class="text-sm text-[var(--color-text-primary)]">% of routed turns</span>
			</div>
			<p class="mt-1 text-xs text-[var(--color-text-secondary)]">
				A percentage, not a probability — <code>5</code> means five turns in every hundred. Leave it
				empty (or 0) for off.
			</p>

			<p class="mt-2 text-xs {IMPACT_CLASS[impact.level]}" data-testid="exploration-impact">
				{impact.text}
			</p>

			{#if !parsedRate.ok}
				<p class="mt-2 text-xs {ERROR_CLASS}" role="alert" data-testid="exploration-error">
					{parsedRate.error}
				</p>
			{/if}

			{#if mustAcknowledge}
				<label
					class="mt-3 flex items-start gap-2 text-xs text-[var(--color-text-primary)]"
					data-testid="exploration-ack-label"
				>
					<input
						type="checkbox"
						bind:checked={acknowledged}
						data-testid="exploration-ack"
						class="mt-0.5"
					/>
					<span>
						I understand this deliberately serves some users a weaker model than the router picked,
						and that some of those answers will be worse.
					</span>
				</label>
			{/if}

			<div class="mt-3 flex items-center gap-2">
				<button
					onclick={commitRate}
					disabled={!canSaveRate || flash.saving}
					data-testid="exploration-save"
					class={primaryButtonClass}
				>
					Save exploration rate
				</button>
				{#if explorationRate > 0}
					<button
						onclick={() => saveRate(0)}
						disabled={flash.saving}
						data-testid="exploration-off"
						class={secondaryButtonClass}
					>
						Turn off
					</button>
				{/if}
			</div>
		</div>

		<!-- ── Shadow mode ──────────────────────────────────────────────── -->
		<div
			class="border-t border-[var(--color-border)] pt-6"
			data-testid="shadow-editor"
		>
			<h3 class="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">
				Shadow mode — candidate thresholds
			</h3>
			<p class="mb-2 text-xs text-[var(--color-text-secondary)]">
				A candidate policy is classified alongside the real one on every routed turn it could have
				moved, and the disagreement is recorded. <strong>It never serves a turn</strong> — no user is
				affected and no extra model call is made.
			</p>
			<ol
				class="mb-3 list-decimal space-y-1 pl-5 text-xs text-[var(--color-text-secondary)]"
				data-testid="shadow-workflow"
			>
				<li>Propose thresholds offline: <code>bun run scripts/routing-sweep.ts</code></li>
				<li>Paste the recommended pair below and save.</li>
				<li>
					Watch <strong>Shadow Agreement</strong> in the
					<!-- Always underlined, not just on hover: this link sits INSIDE a
					     text block, where colour alone is not a sufficient distinction
					     (WCAG 1.4.1 / axe link-in-text-block). -->
					<a href="/admin/dashboard" class="text-[var(--color-accent)] underline">
						admin Routing panel
					</a> as real traffic arrives.
				</li>
				<li>Promote the pair, or turn shadow mode off — clearing both boxes does the same.</li>
			</ol>

			<p class="mb-2 text-xs text-[var(--color-text-secondary)]" data-testid="shadow-current">
				{#if shadowThresholds}
					Live now: shadowing {shadowThresholds.fastMaxTokens} / {shadowThresholds.powerfulMinTokens}
					tokens.
				{:else}
					Live now: no candidate policy — shadow mode is off.
				{/if}
			</p>

			<div class="space-y-2">
				<div class="flex items-center gap-2">
					<!-- Fixed-width labels so both boxes line up under each other. -->
					<label for="shadow-fast-max" class="w-40 text-sm text-[var(--color-text-primary)]">
						Fast max tokens
					</label>
					<input
						id="shadow-fast-max"
						type="number"
						min="1"
						step="1"
						placeholder="250"
						data-testid="shadow-fast-input"
						bind:value={shadowForm.fastMaxTokens}
						disabled={flash.saving}
						class={inputClass}
					/>
				</div>
				<div class="flex items-center gap-2">
					<label for="shadow-powerful-min" class="w-40 text-sm text-[var(--color-text-primary)]">
						Powerful min tokens
					</label>
					<input
						id="shadow-powerful-min"
						type="number"
						min="1"
						step="1"
						placeholder="4000"
						data-testid="shadow-powerful-input"
						bind:value={shadowForm.powerfulMinTokens}
						disabled={flash.saving}
						class={inputClass}
					/>
				</div>
			</div>
			<p class="mt-1 text-xs text-[var(--color-text-secondary)]">
				Fast max must be BELOW powerful min — the gap between them is the balanced band.
			</p>

			{#if shadowState.kind === "invalid"}
				<p class="mt-2 text-xs {ERROR_CLASS}" role="alert" data-testid="shadow-error">
					{shadowState.error}
				</p>
			{/if}

			<div class="mt-3 flex items-center gap-2">
				<button
					onclick={saveShadow}
					disabled={!canSaveShadow || flash.saving}
					data-testid="shadow-save"
					class={primaryButtonClass}
				>
					Save candidate
				</button>
				{#if shadowThresholds}
					<button
						onclick={clearShadow}
						disabled={flash.saving}
						data-testid="shadow-off"
						class={secondaryButtonClass}
					>
						Turn off
					</button>
				{/if}
			</div>
		</div>
	</div>

	<div class="mt-4 min-h-4">
		{#if saveError}
			<p class="text-xs {ERROR_CLASS}" role="alert" data-testid="routing-experiments-save-error">
				{saveError}
			</p>
		{:else}
			<SaveIndicator saving={flash.saving} saved={flash.saved} error={flash.error} />
		{/if}
	</div>
</SettingsSection>
