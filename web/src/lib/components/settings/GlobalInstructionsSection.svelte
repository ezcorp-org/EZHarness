<script lang="ts">
	import { upsertSetting } from "$lib/api.js";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";

	let { globalPrompt = $bindable() }: { globalPrompt: string } = $props();

	let savingPrompt = $state(false);

	async function saveGlobalPrompt() {
		savingPrompt = true;
		try { await upsertSetting("global:systemPrompt", globalPrompt); }
		finally { savingPrompt = false; }
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
		class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none resize-y"
		placeholder="e.g. You are a helpful AI assistant..."
	></textarea>
	<button
		onclick={saveGlobalPrompt}
		disabled={savingPrompt}
		class="mt-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
	>
		{savingPrompt ? "Saving..." : "Save Global Instructions"}
	</button>
</SettingsSection>
