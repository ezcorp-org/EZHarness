<script lang="ts">
	import { page } from "$app/state";
	import { store } from "$lib/stores.svelte.js";
	import MemoryList from "$lib/components/MemoryList.svelte";
	import KnowledgeBaseTab from "$lib/components/KnowledgeBaseTab.svelte";
	import LessonsTab from "$lib/components/LessonsTab.svelte";
	import ContextsTab from "$lib/components/ContextsTab.svelte";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";

	type Tab = "memories" | "knowledge-base" | "lessons" | "contexts";

	const tabs: { id: Tab; label: string }[] = [
		{ id: "memories", label: "Memories" },
		{ id: "knowledge-base", label: "Knowledge Base" },
		{ id: "lessons", label: "Lessons" },
		{ id: "contexts", label: "Contexts" },
	];

	// Deep-link support: chat's "Saved to Library →" link points at
	// `/memories?tab=contexts`. Honour `?tab=` when it names a real tab,
	// otherwise fall back to the default Memories tab.
	const initialTab = tabs.find((t) => t.id === page.url.searchParams.get("tab"))?.id ?? "memories";
	let activeTab = $state<Tab>(initialTab);

	let projectId = $derived(store.activeProjectId);
	// `?focus=<memoryId>` is set by links from chat (MemoriesCard) to auto-expand a specific memory.
	let focusMemoryId = $derived(page.url.searchParams.get("focus") ?? undefined);
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
	{:else if activeTab === "knowledge-base"}
		{#if projectId}
			<KnowledgeBaseTab {projectId} />
		{:else}
			<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center text-[var(--color-text-secondary)]">
				Select a project to manage knowledge base files.
			</div>
		{/if}
	{:else if activeTab === "lessons"}
		{#if projectId}
			<LessonsTab {projectId} />
		{:else}
			<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center text-[var(--color-text-secondary)]">
				Select a project to view lessons.
			</div>
		{/if}
	{:else if activeTab === "contexts"}
		{#if projectId}
			<ContextsTab {projectId} />
		{:else}
			<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center text-[var(--color-text-secondary)]">
				Select a project to view saved contexts.
			</div>
		{/if}
	{/if}
</div>
