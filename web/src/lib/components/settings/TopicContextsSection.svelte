<script lang="ts">
	/**
	 * Topic-contexts model picker (settings/personalization). Chooses the LLM
	 * that detects a conversation's topics and extracts each topic's context.
	 * Instance-wide setting `contexts:model` stored as `"provider/modelId"` (the
	 * `compaction:summarizeModel` convention); unset = the local suggestions
	 * sidecar.
	 *
	 * Uses the app-wide chat `ModelSelector` (DRY — the same picker the composer
	 * uses; the older `ModelSearchPicker` had a blur-timer glitch). `allowAuto`
	 * stays OFF: the "Auto (smart routing)" sentinel is NOT our default-local
	 * semantic. `ModelSelector` has no clear affordance, so a "Use local default"
	 * reset (shown only when a model is pinned) saves `""`. Save UX mirrors
	 * ComposerSuggestSection: optimistic mutation flashed via `createSaveFlash`,
	 * rolled back on failure.
	 */
	import { onMount } from "svelte";
	import { fetchSettings, upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import ModelSelector from "$lib/components/ModelSelector.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";
	import {
		parseModelSetting,
		MODEL_SUPPORT_REASON_LABELS,
		type ModelSupportReason,
	} from "$lib/topic-contexts-logic";

	const SETTING_KEY = "contexts:model";
	const flash = createSaveFlash();

	// null = default (local suggestions sidecar → chat-model fallback).
	let selectedModel = $state<{ provider: string; model: string } | null>(null);

	// Resource-aware support status of the default-local model (the sidecar the
	// feature falls back to). Peeked on mount; the Re-check button forces a probe.
	interface SupportStatus {
		localModel: string;
		configured: boolean;
		probed: boolean;
		supported: boolean;
		reason: ModelSupportReason | null;
	}
	let support = $state<SupportStatus | null>(null);
	let checking = $state(false);

	async function loadSupport(recheck = false) {
		checking = true;
		try {
			const res = await fetch(`/api/contexts/model-support${recheck ? "?recheck=1" : ""}`);
			support = res.ok ? ((await res.json()) as SupportStatus) : null;
		} catch {
			support = null;
		} finally {
			checking = false;
		}
	}

	let supportReason = $derived(
		support?.reason ? MODEL_SUPPORT_REASON_LABELS[support.reason] : null,
	);

	onMount(async () => {
		try {
			const settings = await fetchSettings();
			const raw = settings[SETTING_KEY];
			// Shared parser returns `{ provider, modelId }`; ModelSelector's
			// `selected` prop wants `{ provider, model }`. Malformed / empty →
			// null (default-local).
			const parsed = typeof raw === "string" ? parseModelSetting(raw) : null;
			selectedModel = parsed ? { provider: parsed.provider, model: parsed.modelId } : null;
		} catch {
			// silent — the picker just starts on the default
		}
		await loadSupport(false);
	});

	async function saveModel(next: { provider: string; model: string } | null) {
		const previous = selectedModel;
		selectedModel = next; // optimistic
		const value = next ? `${next.provider}/${next.model}` : "";
		const ok = await flash.run(() => upsertSetting(SETTING_KEY, value));
		if (!ok) selectedModel = previous; // roll back the optimistic mutation
	}

	function handleSelect(provider: string, model: string) {
		void saveModel({ provider, model });
	}

	function useLocalDefault() {
		void saveModel(null);
	}
</script>

<SettingsSection
	id="topic-contexts-model"
	title="Topic contexts model"
	tooltip="The model that detects a conversation's topics and extracts each topic's context when you use the chat Topics button. Grammar-constrained classification keeps to the built-in type list. Accuracy improves with a larger local tag or a cloud model."
	description="Model for topic detection + context extraction. Saves automatically."
>
	<div class="mb-2 flex min-h-4 justify-end">
		<SaveIndicator saving={flash.saving} saved={flash.saved} error={flash.error} />
	</div>
	<div class="flex max-w-md flex-col items-start gap-2" data-testid="contexts-model-picker">
		<div class="flex items-center gap-2">
			<ModelSelector selected={selectedModel} onselect={handleSelect} />
			{#if selectedModel}
				<button
					type="button"
					data-testid="contexts-model-reset"
					onclick={useLocalDefault}
					class="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
				>
					Use local default
				</button>
			{/if}
		</div>
		<p class="text-xs text-[var(--color-text-secondary)]">
			Default is the local suggestions sidecar (<code>qwen3.5:4b</code>). When the
			sidecar is down or your machine can't run the model, extraction falls back
			to the chat's current model.
		</p>

		<!-- Resource-aware support status of the default-local model. -->
		<div class="mt-1 flex items-center gap-2" data-testid="contexts-support-status">
			{#if support === null}
				<span class="text-xs text-[var(--color-text-muted)]">Local model status unavailable.</span>
			{:else if !support.configured}
				<span class="text-xs text-[var(--color-text-muted)]">No local model endpoint configured.</span>
			{:else if !support.probed}
				<span class="text-xs text-[var(--color-text-muted)]">
					<code>{support.localModel}</code> — not checked yet.
				</span>
			{:else if support.supported}
				<span class="text-xs text-emerald-400" data-testid="contexts-support-ok">
					✓ <code>{support.localModel}</code> is supported on this machine.
				</span>
			{:else}
				<span class="text-xs text-amber-400" data-testid="contexts-support-bad">
					✗ <code>{support.localModel}</code> can't run here{supportReason ? ` — ${supportReason}` : ""}.
				</span>
			{/if}
			<button
				type="button"
				data-testid="contexts-recheck-btn"
				onclick={() => loadSupport(true)}
				disabled={checking}
				class="rounded-md border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-60"
			>
				{checking ? "Checking…" : "Re-check"}
			</button>
		</div>
	</div>
</SettingsSection>
