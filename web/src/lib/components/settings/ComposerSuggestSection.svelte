<script lang="ts">
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";

	let {
		suggestEnabled = $bindable(),
		projectId = null,
	}: {
		suggestEnabled: boolean;
		/** null = the GLOBAL override toggle (`suggest:enabled`); a project id
		 *  = that project's own toggle (`project:<id>:suggest:enabled`).
		 *  Layering: global off ⇒ off everywhere; global on ⇒ each project's
		 *  toggle governs (default on). */
		projectId?: string | null;
	} = $props();

	const flash = createSaveFlash();
	let settingKey = $derived(projectId ? `project:${projectId}:suggest:enabled` : "suggest:enabled");

	async function toggleSuggestions() {
		const previous = suggestEnabled;
		suggestEnabled = !previous;
		const ok = await flash.run(() => upsertSetting(settingKey, !previous));
		if (!ok) suggestEnabled = previous; // roll back the optimistic mutation
	}
</script>

<SettingsSection
	id="composer-suggestions"
	title="Composer suggestions"
	tooltip="As you pause while typing in chat, the composer suggests relevant tools from your selected mode's toolset (ranked locally with embeddings) and — when the local model sidecar is running — a prompt improvement. Suggestions never change your draft on their own: nothing is inserted or rewritten unless you click a suggestion, and Apply is always undoable."
	description="Tool + prompt suggestions while typing. Toggles save automatically."
>
	<div class="mb-2 flex min-h-4 justify-end">
		<SaveIndicator saving={flash.saving} saved={flash.saved} error={flash.error} />
	</div>
	<div class="flex items-center justify-between">
		<div>
			<p class="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
				Suggest tools &amp; prompt improvements while typing
				<InfoTooltip
					text="Privacy: drafts are analyzed in memory on this server and never stored. Suggestion telemetry records only which suggestions were shown, accepted, or dismissed — never what you typed. Nothing is used for model training unless you explicitly run the offline export."
				/>
			</p>
			<p class="text-xs text-[var(--color-text-secondary)]">
				{#if projectId}
					Applies to this project only. The global toggle (Settings → Personalization) overrides it when off.
				{:else}
					Global override: when off, suggestions are off in every project; when on, each project's own toggle governs.
				{/if}
			</p>
		</div>
		<button
			onclick={toggleSuggestions}
			disabled={flash.saving}
			class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none {suggestEnabled ? 'bg-blue-600' : 'bg-gray-600'}"
			role="switch"
			aria-checked={suggestEnabled}
			aria-label="Toggle composer suggestions"
			data-testid="toggle-composer-suggestions"
		>
			<span
				class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 {suggestEnabled ? 'translate-x-5' : 'translate-x-0'}"
			></span>
		</button>
	</div>
</SettingsSection>
