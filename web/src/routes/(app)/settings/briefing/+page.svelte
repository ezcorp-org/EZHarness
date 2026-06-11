<script lang="ts">
	import BriefingSettings from "$lib/components/settings/BriefingSettings.svelte";
	import { store } from "$lib/stores.svelte.js";
</script>

<svelte:head>
	<title>Daily Briefing - Settings - EZCorp</title>
</svelte:head>

<div class="mx-auto flex max-w-3xl flex-col gap-6">
	<div>
		<a
			href="/settings/personalization"
			class="mb-2 inline-flex items-center gap-1 text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
		>
			<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
			</svg>
			Settings
		</a>
		<h1 class="text-2xl font-bold text-[var(--color-text-primary)]">Daily Briefing</h1>
	</div>

	<BriefingSettings projects={store.projects} />
</div>
