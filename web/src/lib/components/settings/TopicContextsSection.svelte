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
	import { parseModelSetting } from "$lib/topic-contexts-logic";

	const SETTING_KEY = "contexts:model";
	const flash = createSaveFlash();

	// null = default (local suggestions sidecar → chat-model fallback).
	let selectedModel = $state<{ provider: string; model: string } | null>(null);

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
	</div>
</SettingsSection>
