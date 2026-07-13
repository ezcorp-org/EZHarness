<script lang="ts">
	/**
	 * Topic-contexts model picker (settings/personalization). Chooses the
	 * LLM that detects a conversation's topics and extracts each topic's
	 * context. Instance-wide setting `contexts:model` stored as
	 * `"provider/modelId"` (the `compaction:summarizeModel` convention),
	 * default unset = the local suggestions sidecar.
	 *
	 * Save UX mirrors ComposerSuggestSection: optimistic mutation flashed
	 * via `createSaveFlash`, rolled back on failure. The model picker is the
	 * app-standard `ModelSearchPicker` (same as AgentConfigForm /
	 * BriefingSettings) — its "Current Chat Model" sentinel has no meaning
	 * for a background extraction, so selecting it clears back to the local
	 * default, matching BriefingSettings' sentinel handling.
	 */
	import { onMount } from "svelte";
	import { fetchSettings, upsertSetting, CURRENT_MODEL_SENTINEL } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import ModelSearchPicker from "$lib/components/ModelSearchPicker.svelte";
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
			// Shared parser returns `{ provider, modelId }`; the picker's
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
		if (provider === CURRENT_MODEL_SENTINEL) {
			// "Current Chat Model" → reset to the local default.
			void saveModel(null);
		} else {
			void saveModel({ provider, model });
		}
	}

	function handleClear() {
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
	<div class="flex max-w-md flex-col gap-1" data-testid="contexts-model-picker">
		<ModelSearchPicker
			selected={selectedModel}
			placeholder="Search models... (default: local suggestions model)"
			onselect={handleSelect}
			onclear={handleClear}
		/>
		<p class="text-xs text-[var(--color-text-secondary)]">
			Default is the local suggestions sidecar (<code>qwen3:1.7b</code>). When the
			sidecar is down, extraction falls back to the chat's current model.
		</p>
	</div>
</SettingsSection>
