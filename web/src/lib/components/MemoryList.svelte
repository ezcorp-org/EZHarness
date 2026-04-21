<script lang="ts">
	import MemoryItem, { type Memory } from "./MemoryItem.svelte";
	import ProjectPicker from "./ProjectPicker.svelte";
	import EmptyState from "./EmptyState.svelte";
	import { browser } from "$app/environment";
	import { store } from "$lib/stores.svelte.js";

	let { projectId, focusMemoryId }: { projectId?: string; focusMemoryId?: string } = $props();

	const categories = [
		{ value: "", label: "All" },
		{ value: "preferences", label: "Preferences" },
		{ value: "technical", label: "Technical" },
		{ value: "biographical", label: "Biographical" },
		{ value: "decisions_goals", label: "Decisions & Goals" },
	] as const;

	const statuses = [
		{ value: "", label: "All" },
		{ value: "active", label: "Active" },
		{ value: "stale", label: "Stale" },
		{ value: "archived", label: "Archived" },
	] as const;

	const scopes = [
		{ value: "all", label: "All" },
		{ value: "project", label: "This Project" },
		{ value: "global", label: "Org-wide" },
	] as const;

	let memories = $state<Memory[]>([]);
	let loading = $state(false);
	let searchQuery = $state("");
	let activeCategory = $state("");
	let activeStatus = $state("");
	let activeScope = $state<"all" | "project" | "global">("all");
	let showArchived = $state(false);

	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let debouncedSearch = $state("");

	// Add memory form state
	let showAddForm = $state(false);
	let newContent = $state("");
	let newCategory = $state("preferences");
	let newConfidence = $state("medium");
	let defaultProjectIds = $derived(projectId && projectId !== "global" ? [projectId] : []);
	let newProjectIds = $state<string[]>([]);
	let projectIdsInitialized = $state(false);

	$effect(() => {
		if (!projectIdsInitialized) {
			newProjectIds = defaultProjectIds;
			projectIdsInitialized = true;
		}
	});
	let adding = $state(false);

	// Debounce search input
	function handleSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			debouncedSearch = searchQuery;
		}, 300);
	}

	// Filtered memories: when status is "All" and showArchived is false, hide archived.
	// If we're focusing a specific memory via ?focus=, always include it so the link works
	// even when the memory is archived / filtered out.
	let displayMemories = $derived(
		activeStatus === "" && !showArchived
			? memories.filter((m) => m.status !== "archived" || m.id === focusMemoryId)
			: memories,
	);

	async function fetchMemories() {
		loading = true;
		try {
			const params = new URLSearchParams();
			if (projectId && projectId !== "global") params.set("projectId", projectId);
			if (activeScope) params.set("scope", activeScope);
			if (debouncedSearch) params.set("search", debouncedSearch);
			if (activeStatus) params.set("status", activeStatus);
			if (activeCategory) params.set("category", activeCategory);
			params.set("limit", "50");

			const res = await fetch(`/api/memories?${params}`);
			if (res.ok) {
				memories = await res.json();
			}
		} catch {
			// silent
		}
		loading = false;
	}

	// Refetch when filters change
	$effect(() => {
		// Read reactive deps
		void debouncedSearch;
		void activeCategory;
		void activeStatus;
		void activeScope;
		void projectId;
		if (browser) fetchMemories();
	});

	function handleMemoryUpdated(updated: Memory) {
		memories = memories.map((m) => (m.id === updated.id ? updated : m));
	}

	function handleMemoryDeleted(id: string) {
		memories = memories.filter((m) => m.id !== id);
	}

	async function addMemory() {
		if (!newContent.trim()) return;
		adding = true;
		try {
			const res = await fetch("/api/memories", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: newContent,
					category: newCategory,
					confidence: newConfidence,
					...(newProjectIds.length > 0 ? { projectIds: newProjectIds } : {}),
				}),
			});
			if (res.status === 201) {
				const created = await res.json();
				memories = [created, ...memories];
				newContent = "";
				newCategory = "preferences";
				newProjectIds = defaultProjectIds;
				newConfidence = "medium";
				showAddForm = false;
			}
		} catch {
			// silent
		}
		adding = false;
	}

	function cancelAdd() {
		newContent = "";
		newCategory = "preferences";
		newConfidence = "medium";
		newProjectIds = defaultProjectIds;
		showAddForm = false;
	}
</script>

<!-- Search bar -->
<div class="relative mb-4">
	<svg
		class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]"
		fill="none"
		stroke="currentColor"
		viewBox="0 0 24 24"
	>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			stroke-width="2"
			d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
		/>
	</svg>
	<input
		bind:value={searchQuery}
		oninput={handleSearchInput}
		type="text"
		placeholder="Search memories..."
		class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] py-2 pl-10 pr-4 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
	/>
</div>

<!-- Add Memory button + form -->
<div class="mb-3">
	<button
		data-testid="add-memory-toggle"
		onclick={() => (showAddForm = !showAddForm)}
		class="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
	>
		{showAddForm ? "Cancel" : "+ Add Memory"}
	</button>

	{#if showAddForm}
		<div data-testid="add-memory-form" class="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-3">
			<textarea
				data-testid="add-memory-content"
				bind:value={newContent}
				class="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
				rows="3"
				placeholder="Enter memory content..."
			></textarea>
			<div class="mt-2 flex gap-4">
				<label class="flex flex-col gap-1 text-xs text-[var(--color-text-secondary)]">
					Category
					<select
						data-testid="add-memory-category"
						bind:value={newCategory}
						class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
					>
						<option value="preferences">Preferences</option>
						<option value="biographical">Biographical</option>
						<option value="technical">Technical</option>
						<option value="decisions_goals">Decisions & Goals</option>
					</select>
				</label>
				<label class="flex flex-col gap-1 text-xs text-[var(--color-text-secondary)]">
					Confidence
					<select
						data-testid="add-memory-confidence"
						bind:value={newConfidence}
						class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
					>
						<option value="high">High</option>
						<option value="medium">Medium</option>
						<option value="low">Low</option>
					</select>
				</label>
				<div class="flex flex-col gap-1 text-xs text-[var(--color-text-secondary)]">
					Scope
					<ProjectPicker
						selectedIds={newProjectIds}
						onchange={(ids) => { newProjectIds = ids; }}
					/>
				</div>
			</div>
			<div class="mt-3 flex gap-2">
				<button
					data-testid="add-memory-save"
					onclick={addMemory}
					disabled={adding || !newContent.trim()}
					class="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{adding ? "Saving..." : "Save"}
				</button>
				<button
					data-testid="add-memory-cancel"
					onclick={cancelAdd}
					class="rounded bg-[var(--color-surface-tertiary)] px-3 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]"
				>
					Cancel
				</button>
			</div>
		</div>
	{/if}
</div>

<!-- Category filter chips -->
<div class="mb-3 flex flex-wrap gap-2">
	{#each categories as cat}
		<button
			onclick={() => (activeCategory = cat.value)}
			class="rounded-full px-3 py-1 text-xs font-medium transition-colors
				{activeCategory === cat.value
				? 'bg-blue-600 text-white'
				: 'bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]'}"
		>
			{cat.label}
		</button>
	{/each}
</div>

<!-- Scope filter -->
<div class="mb-3 flex items-center gap-2">
	<span class="text-xs text-[var(--color-text-muted)]">Scope:</span>
	{#each scopes as sc}
		<button
			onclick={() => (activeScope = sc.value)}
			class="rounded-md px-3 py-1 text-xs font-medium transition-colors
				{activeScope === sc.value
				? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]'
				: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
		>
			{sc.label}
		</button>
	{/each}
</div>

<!-- Status filter tabs -->
<div class="mb-4 flex items-center gap-4">
	<div class="flex gap-1">
		{#each statuses as st}
			<button
				onclick={() => (activeStatus = st.value)}
				class="rounded-md px-3 py-1 text-xs font-medium transition-colors
					{activeStatus === st.value
					? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]'
					: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
			>
				{st.label}
			</button>
		{/each}
	</div>

	{#if activeStatus === ""}
		<label class="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
			<input
				type="checkbox"
				bind:checked={showArchived}
				class="rounded border-[var(--color-border)] bg-[var(--color-surface-secondary)]"
			/>
			Show archived
		</label>
	{/if}
</div>

<!-- Results count -->
<div class="mb-3 text-xs text-[var(--color-text-muted)]">
	{#if loading}
		Loading...
	{:else}
		{displayMemories.length} {displayMemories.length === 1 ? "memory" : "memories"}
	{/if}
</div>

<!-- Memory list -->
{#if !loading && displayMemories.length === 0}
	{#if debouncedSearch || activeCategory || activeStatus}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center text-[var(--color-text-secondary)]">
			No memories match your filters.
		</div>
	{:else}
		<EmptyState
			title="No memories yet"
			description="Memories are created automatically as you chat. Start a conversation to build your memory."
			ctaLabel="Start Chatting"
			ctaHref={store.activeProjectId !== "global" ? `/project/${store.activeProjectId}/chat` : "/"}
		>
			{#snippet icon()}
				<svg class="h-12 w-12 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
				</svg>
			{/snippet}
		</EmptyState>
	{/if}
{:else}
	<div class="flex flex-col gap-2">
		{#each displayMemories as memory (memory.id)}
			<MemoryItem
				{memory}
				{focusMemoryId}
				onupdated={handleMemoryUpdated}
				ondeleted={handleMemoryDeleted}
			/>
		{/each}
	</div>
{/if}
