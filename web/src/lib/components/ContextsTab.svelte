<script module lang="ts">
	export interface ContextType {
		id: string;
		label: string;
		description: string;
		sortOrder: number;
	}

	export interface SavedContext {
		id: string;
		topicLabel: string;
		typeId: string;
		title: string;
		content: string;
		conversationId: string | null;
		model: string;
		createdAt: string;
		updatedAt: string;
	}
</script>

<script lang="ts">
	/**
	 * Saved-contexts library tab — `/memories → Contexts`.
	 *
	 * Pattern-copied from MemoryList.svelte: a debounced search box, a row
	 * of type-filter chips (sourced live from GET /api/context-types so the
	 * DB enum is the single source of truth), and a refetch `$effect` keyed
	 * on the active filters. Rows expand to the full extracted markdown and
	 * offer Copy (clipboard) + Delete (optimistic, rollback on error).
	 *
	 * Project scoping mirrors MemoryList: the `projectId` param is only sent
	 * for a real project ("global" lists the user's rows across projects).
	 */
	import { browser } from "$app/environment";
	import { copyToClipboard } from "$lib/clipboard";
	import { buildContextsSearchParams } from "$lib/topic-contexts-logic";
	import MarkdownRenderer from "$lib/components/MarkdownRenderer.svelte";

	let { projectId }: { projectId: string } = $props();

	let contexts = $state<SavedContext[]>([]);
	let types = $state<ContextType[]>([]);
	let loading = $state(false);
	let total = $state(0);

	let searchQuery = $state("");
	let debouncedSearch = $state("");
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	let activeTypeId = $state("");
	let expandedId = $state<string | null>(null);
	let copiedId = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	// Click-to-confirm delete — mirrors LessonsTab / MemoryItem (3s window).
	let confirmingDelete = $state<string | null>(null);
	let deleteTimer: ReturnType<typeof setTimeout> | undefined;

	// Type id → label, for the row badge. Falls back to the raw id for a
	// type that was seeded after this page loaded its enum snapshot.
	let typeLabels = $derived(new Map(types.map((t) => [t.id, t.label])));

	function relativeTime(dateStr: string): string {
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return "just now";
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		if (days < 30) return `${days}d ago`;
		const months = Math.floor(days / 30);
		if (months < 12) return `${months}mo ago`;
		return `${Math.floor(months / 12)}y ago`;
	}

	function handleSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			debouncedSearch = searchQuery;
		}, 300);
	}

	async function fetchTypes() {
		try {
			const res = await fetch("/api/context-types");
			if (res.ok) {
				const data = (await res.json()) as { types: ContextType[] };
				types = data.types ?? [];
			}
		} catch {
			// silent — chips just won't render; list still works
		}
	}

	async function fetchContexts() {
		// Do NOT read `contexts` here — this runs inside a `$effect`, whose
		// prelude tracks every reactive read; touching the list would loop
		// (assign → dirty → re-run). Set loading up front instead.
		loading = true;
		try {
			// Shared query builder — skips the "global" sentinel + blank filters
			// (see buildContextsSearchParams in topic-contexts-logic.ts).
			const qs = buildContextsSearchParams({
				projectId,
				search: debouncedSearch,
				typeId: activeTypeId,
				limit: 50,
			});

			const res = await fetch(`/api/contexts?${qs}`);
			if (res.ok) {
				const data = (await res.json()) as { contexts: SavedContext[]; total: number };
				contexts = data.contexts ?? [];
				total = data.total ?? contexts.length;
			}
		} catch {
			// silent
		}
		loading = false;
	}

	$effect(() => {
		void debouncedSearch;
		void activeTypeId;
		void projectId;
		if (browser) fetchContexts();
	});

	$effect(() => {
		fetchTypes();
		return () => {
			clearTimeout(searchTimer);
			clearTimeout(copyTimer);
			clearTimeout(deleteTimer);
		};
	});

	function toggleExpand(id: string) {
		expandedId = expandedId === id ? null : id;
	}

	async function handleCopy(ctx: SavedContext) {
		const ok = await copyToClipboard(ctx.content);
		if (ok) {
			copiedId = ctx.id;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => {
				copiedId = null;
			}, 2000);
		}
	}

	function handleDeleteClick(id: string) {
		if (confirmingDelete === id) {
			clearTimeout(deleteTimer);
			confirmingDelete = null;
			void performDelete(id);
		} else {
			confirmingDelete = id;
			clearTimeout(deleteTimer);
			deleteTimer = setTimeout(() => {
				confirmingDelete = null;
			}, 3000);
		}
	}

	async function performDelete(id: string) {
		// Optimistic removal — snapshot the row + its position so a failed
		// DELETE can roll the list back to exactly where it was.
		const index = contexts.findIndex((c) => c.id === id);
		if (index === -1) return;
		const removed = contexts[index]!;
		contexts = contexts.filter((c) => c.id !== id);
		total = Math.max(0, total - 1);
		try {
			const res = await fetch(`/api/contexts/${id}`, { method: "DELETE" });
			if (!(res.ok || res.status === 204)) {
				// rollback
				contexts = [...contexts.slice(0, index), removed, ...contexts.slice(index)];
				total = total + 1;
			}
		} catch {
			contexts = [...contexts.slice(0, index), removed, ...contexts.slice(index)];
			total = total + 1;
		}
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
		placeholder="Search saved contexts..."
		data-testid="contexts-search"
		class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] py-2 pl-10 pr-4 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)]"
	/>
</div>

<!-- Type filter chips (live from the DB enum) -->
<div class="mb-3 flex flex-wrap gap-2" data-testid="contexts-type-chips">
	<button
		onclick={() => (activeTypeId = "")}
		data-testid="context-type-chip-all"
		class="rounded-full px-3 py-1 text-xs font-medium transition-colors
			{activeTypeId === ''
			? 'bg-blue-600 text-white'
			: 'bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]'}"
	>
		All
	</button>
	{#each types as t (t.id)}
		<button
			onclick={() => (activeTypeId = t.id)}
			data-testid="context-type-chip-{t.id}"
			title={t.description}
			class="rounded-full px-3 py-1 text-xs font-medium transition-colors
				{activeTypeId === t.id
				? 'bg-blue-600 text-white'
				: 'bg-[var(--color-surface-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]'}"
		>
			{t.label}
		</button>
	{/each}
</div>

<!-- Results count -->
<div class="mb-3 text-xs text-[var(--color-text-muted)]">
	{#if loading}
		Loading...
	{:else}
		{total} {total === 1 ? "context" : "contexts"}
	{/if}
</div>

<!-- Context list -->
{#if !loading && contexts.length === 0}
	<div
		class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center text-[var(--color-text-secondary)]"
		data-testid="contexts-empty"
	>
		{#if debouncedSearch || activeTypeId}
			No saved contexts match your filters.
		{:else}
			No saved contexts yet. Open a conversation, click the Topics button, and
			extract a topic to save its context here.
		{/if}
	</div>
{:else}
	<div class="flex flex-col gap-2">
		{#each contexts as ctx (ctx.id)}
			<div
				class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)]"
				data-testid="context-row"
				data-context-id={ctx.id}
			>
				<!-- Collapsed row -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="flex cursor-pointer items-center gap-3 px-4 py-3"
					onclick={() => toggleExpand(ctx.id)}
				>
					<span class="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text-primary)]">
						{ctx.title}
					</span>

					<!-- Type badge -->
					<span
						class="shrink-0 rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-medium text-indigo-300"
						data-testid="context-type-badge"
					>
						{typeLabels.get(ctx.typeId) ?? ctx.typeId}
					</span>

					<!-- Age -->
					<span class="shrink-0 text-[10px] text-[var(--color-text-muted)]">
						{relativeTime(ctx.updatedAt)}
					</span>

					<!-- Expand indicator -->
					<svg
						class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform {expandedId === ctx.id ? 'rotate-180' : ''}"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
					</svg>
				</div>

				<!-- Expanded content -->
				{#if expandedId === ctx.id}
					<div class="border-t border-[var(--color-border)] px-4 py-3">
						<div
							class="text-sm leading-relaxed text-[var(--color-text-primary)]"
							data-testid="context-content"
						><MarkdownRenderer content={ctx.content} /></div>

						<!-- Meta line -->
						<div
							class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border)] pt-3 text-[11px] text-[var(--color-text-muted)]"
						>
							<span>topic: {ctx.topicLabel}</span>
							<span>model: {ctx.model}</span>
							<span>created: {relativeTime(ctx.createdAt)}</span>
							{#if ctx.conversationId && projectId && projectId !== "global"}
								<a
									href={`/project/${projectId}/chat/${ctx.conversationId}`}
									class="text-[var(--color-accent)] hover:underline"
									data-testid="context-conversation-link"
								>
									View conversation →
								</a>
							{/if}
						</div>

						<!-- Actions -->
						<div class="mt-3 flex gap-2">
							<button
								onclick={() => handleCopy(ctx)}
								data-testid="context-copy"
								class="rounded bg-[var(--color-surface-tertiary)] px-3 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
							>
								{copiedId === ctx.id ? "Copied ✓" : "Copy"}
							</button>
							<button
								onclick={() => handleDeleteClick(ctx.id)}
								data-testid="context-delete"
								class="rounded px-3 py-1 text-xs font-medium transition-colors
									{confirmingDelete === ctx.id
									? 'bg-red-600 text-white hover:bg-red-500'
									: 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-red-400'}"
							>
								{confirmingDelete === ctx.id ? "Confirm Delete?" : "Delete"}
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}
