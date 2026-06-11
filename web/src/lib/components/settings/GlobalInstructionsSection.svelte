<script lang="ts">
	import { onMount } from "svelte";
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";

	let { globalPrompt = $bindable() }: { globalPrompt: string } = $props();

	// Multi-field form (locked decision 5): explicit Save, disabled
	// until dirty against the last-persisted baseline.
	let baseline = $state("");
	onMount(() => {
		baseline = globalPrompt;
	});
	const dirty = $derived(globalPrompt !== baseline);

	const flash = createSaveFlash();

	async function saveGlobalPrompt() {
		const value = globalPrompt;
		await flash.run(() => upsertSetting("global:systemPrompt", value));
		baseline = value;
	}
</script>

<SettingsSection
	id="instructions"
	title="Global Custom Instructions"
	tooltip="A system prompt prepended to every conversation across all projects. This is the lowest priority instruction level. Overridden by project-level instructions, which are in turn overridden by conversation-level instructions."
	description="Default system prompt for all conversations across all projects. Lowest priority."
>
	<textarea
		bind:value={globalPrompt}
		rows={4}
		aria-label="Global custom instructions"
		class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none resize-y"
		placeholder="e.g. You are a helpful AI assistant..."
	></textarea>
	<div class="mt-2 flex items-center gap-3">
		<button
			onclick={saveGlobalPrompt}
			disabled={!dirty || flash.saving}
			class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
		>
			{flash.saving ? "Saving..." : "Save Global Instructions"}
		</button>
		<SaveIndicator saved={flash.saved} />
	</div>
</SettingsSection>
