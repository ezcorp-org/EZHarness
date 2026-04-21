<script lang="ts">
	import { page } from "$app/state";
	import { store } from "$lib/stores.svelte.js";
	import MemoryList from "$lib/components/MemoryList.svelte";
	import KnowledgeBaseTab from "$lib/components/KnowledgeBaseTab.svelte";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";

	type Tab = "memories" | "knowledge-base";
	let activeTab = $state<Tab>("memories");

	let projectId = $derived(store.activeProjectId);
	// `?focus=<memoryId>` is set by links from chat (MemoriesCard) to auto-expand a specific memory.
	let focusMemoryId = $derived(page.url.searchParams.get("focus") ?? undefined);

	const tabs: { id: Tab; label: string }[] = [
		{ id: "memories", label: "Memories" },
		{ id: "knowledge-base", label: "Knowledge Base" },
	];
</script>

<div class="mx-auto max-w-5xl">
	<h1 class="mb-4 flex items-center gap-2 text-2xl font-bold text-[var(--color-text-primary)]">Memories <InfoTooltip key={activeTab === 'knowledge-base' ? 'knowledge.overview' : 'memory.overview'} /></h1>

	<!-- Tab navigation -->
	<div class="mb-6 flex border-b border-[var(--color-border)]">
		{#each tabs as tab}
			<button
				onclick={() => (activeTab = tab.id)}
				class="px-4 py-2 text-sm font-medium transition-colors
					{activeTab === tab.id
					? 'border-b-2 border-blue-500 text-[var(--color-text-primary)]'
					: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
			>
				{tab.label}
			</button>
		{/each}
	</div>

	<!-- Tab content -->
	{#if activeTab === "memories"}
		<MemoryList {projectId} {focusMemoryId} />
	{:else if projectId}
		<KnowledgeBaseTab {projectId} />
	{:else}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center text-[var(--color-text-secondary)]">
			Select a project to manage knowledge base files.
		</div>
	{/if}
</div>
