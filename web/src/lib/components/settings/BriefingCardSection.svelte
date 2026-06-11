<script lang="ts">
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
</script>

<SettingsSection
	id="briefing"
	title="Daily Briefing"
	description="A scheduled morning conversation that mines your recent chats, memories, and tasks — set the time, focus, and delivery project."
>
	{#snippet actions()}
		<a
			href="/settings/briefing"
			data-testid="briefing-settings-link"
			class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
		>
			Configure
		</a>
	{/snippet}
</SettingsSection>
