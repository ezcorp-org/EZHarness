<script lang="ts">
	import {
		fetchConversations,
		deleteConversation,
		updateConversation,
		searchConversations,
		type Conversation,
		type SearchResult,
	} from "$lib/api.js";
	import {
		groupConversations,
		unreadForkCount,
	} from "$lib/conversation-grouping.js";
	import { unreadStore } from "$lib/unread.js";
	import DeleteConfirmDialog from "./DeleteConfirmDialog.svelte";
	import MentionText from "./MentionText.svelte";
	import SkeletonLoader from "./SkeletonLoader.svelte";

	let {
		projectId,
		activeConversationId,
		oncreate,
		onselect,
	}: {
		projectId: string;
		activeConversationId?: string;
		oncreate: () => void;
		onselect: (id: string) => void;
	} = $props();

	const PAGE_SIZE = 30;

	let conversations = $state<Conversation[]>([]);
	let conversationsLoading = $state(true);
	let loadingMore = $state(false);
	let hasMore = $state(true);
	let renamingId = $state<string | null>(null);
	let renameValue = $state("");
	let deleteTarget = $state<Conversation | null>(null);
	let sentinelEl = $state<HTMLDivElement | null>(null);

	// Reactive unread tracking — bump revision on store changes
	let unreadRev = $state(0);
	unreadStore.subscribe(() => { unreadRev++; });

	// Search state
	let searchOpen = $state(false);
	let searchQuery = $state("");
	let searchResults = $state<SearchResult[]>([]);
	let searchLoading = $state(false);
	let searchInputEl = $state<HTMLInputElement | null>(null);

	// Debounce for API search
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	function openSearch() {
		searchOpen = true;
		requestAnimationFrame(() => searchInputEl?.focus());
	}

	function closeSearch() {
		searchOpen = false;
		searchQuery = "";
		searchResults = [];
		searchLoading = false;
		clearTimeout(searchTimer);
	}

	function handleSearchInput() {
		clearTimeout(searchTimer);
		if (searchQuery.length < 2) {
			searchResults = [];
			searchLoading = false;
			return;
		}
		searchLoading = true;
		searchTimer = setTimeout(async () => {
			try {
				searchResults = await searchConversations(projectId, searchQuery);
			} catch {
				searchResults = [];
			}
			searchLoading = false;
		}, 300);
	}

	function handleSearchKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") closeSearch();
	}

	// Client-side title filter (instant, no debounce)
	type SearchableConversation = Conversation & { snippet?: string };

	let filteredConversations = $derived((): SearchableConversation[] => {
		if (!searchOpen || searchQuery.length === 0) return [];
		const q = searchQuery.toLowerCase();
		// Title matches from local list
		const titleMatches = conversations.filter((c) =>
			c.title.toLowerCase().includes(q),
		);
		// Merge with API results (content matches that aren't already title-matched)
		const titleIds = new Set(titleMatches.map((c) => c.id));
		const contentMatches: SearchableConversation[] = searchResults
			.filter((r) => !titleIds.has(r.id))
			.map((r) => {
				// Find the conversation object if we have it, otherwise create a minimal one
				const conv = conversations.find((c) => c.id === r.id);
				return {
					id: r.id,
					projectId,
					title: r.title,
					model: conv?.model ?? null,
					provider: conv?.provider ?? null,
					systemPrompt: conv?.systemPrompt ?? null,
					agentConfigId: conv?.agentConfigId ?? null,
					modeId: conv?.modeId ?? null,
					test: conv?.test ?? null,
					createdAt: conv?.createdAt ?? r.updatedAt,
					updatedAt: r.updatedAt,
					snippet: r.snippet,
				};
			});
		return [...titleMatches, ...contentMatches];
	});

	let isSearchActive = $derived(searchOpen && searchQuery.length > 0);

	export function refresh() {
		loadConversations();
	}

	async function loadConversations() {
		conversationsLoading = true;
		hasMore = true;
		try {
			const page = await fetchConversations(projectId, { limit: PAGE_SIZE, offset: 0 });
			conversations = page;
			hasMore = page.length === PAGE_SIZE;
		} catch {
			// silent
		} finally {
			conversationsLoading = false;
		}
	}

	async function loadMore() {
		if (loadingMore || !hasMore || conversationsLoading || isSearchActive) return;
		loadingMore = true;
		try {
			const page = await fetchConversations(projectId, {
				limit: PAGE_SIZE,
				offset: conversations.length,
			});
			// De-dupe in case items shifted between pages (e.g., updatedAt changed)
			const seen = new Set(conversations.map((c) => c.id));
			const fresh = page.filter((c) => !seen.has(c.id));
			conversations = [...conversations, ...fresh];
			hasMore = page.length === PAGE_SIZE;
		} catch {
			// silent
		} finally {
			loadingMore = false;
		}
	}

	$effect(() => {
		if (projectId) loadConversations();
	});

	// Infinite scroll: observe sentinel at list bottom
	$effect(() => {
		if (!sentinelEl) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) loadMore();
				}
			},
			{ rootMargin: "200px" },
		);
		observer.observe(sentinelEl);
		return () => observer.disconnect();
	});

	// Group conversations into families (parent + forks) bucketed by recency.
	// See $lib/conversation-grouping.ts for algorithm + tests.
	let grouped = $derived(() =>
		groupConversations(conversations, { now: Date.now() }),
	);

	// Collapse state for fork families. Persisted to localStorage so users
	// don't have to re-collapse on every reload. Keyed by root conversation id.
	const COLLAPSE_LS_KEY = "chatList.collapsedFamilies";

	function loadCollapsed(): Set<string> {
		if (typeof localStorage === "undefined") return new Set();
		try {
			const raw = localStorage.getItem(COLLAPSE_LS_KEY);
			if (!raw) return new Set();
			const arr = JSON.parse(raw) as unknown;
			return new Set(Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : []);
		} catch {
			return new Set();
		}
	}

	function persistCollapsed(s: Set<string>) {
		if (typeof localStorage === "undefined") return;
		try {
			localStorage.setItem(COLLAPSE_LS_KEY, JSON.stringify([...s]));
		} catch {
			// ignore quota / privacy-mode failures
		}
	}

	let collapsedRoots = $state<Set<string>>(loadCollapsed());

	function toggleCollapse(id: string) {
		const next = new Set(collapsedRoots);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		collapsedRoots = next;
		persistCollapsed(next);
	}

	function relativeTime(dateStr: string): string {
		const diff = Date.now() - new Date(dateStr).getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return "just now";
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		const days = Math.floor(hrs / 24);
		return `${days}d ago`;
	}

	function handleDelete(conv: Conversation) {
		deleteTarget = conv;
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		const id = deleteTarget.id;
		const wasActive = activeConversationId === id;
		deleteTarget = null;
		try {
			await deleteConversation(id);
			conversations = conversations.filter((c) => c.id !== id);
			if (wasActive && conversations.length > 0) {
				onselect(conversations[0]!.id);
			}
		} catch {
			// silent
		}
	}

	function startRename(conv: Conversation) {
		renamingId = conv.id;
		renameValue = conv.title;
	}

	async function finishRename() {
		if (!renamingId || !renameValue.trim()) {
			renamingId = null;
			return;
		}
		try {
			const updated = await updateConversation(renamingId, { title: renameValue.trim() });
			conversations = conversations.map((c) => (c.id === updated.id ? updated : c));
		} catch {
			// silent
		}
		renamingId = null;
	}
</script>

<div class="flex h-full w-full md:w-[280px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
	<div class="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-3">
		<span class="text-sm font-medium text-[var(--color-text-secondary)]">Conversations</span>
		<div class="flex items-center gap-1.5">
			<button
				onclick={openSearch}
				class="rounded-md p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-secondary)]"
				title="Search conversations"
			>
				<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
						d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
				</svg>
			</button>
			<button
				onclick={oncreate}
				class="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
			>
				New Chat
			</button>
		</div>
	</div>

	{#if searchOpen}
		<div class="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
			<svg class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
					d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
			</svg>
			<input
				bind:this={searchInputEl}
				bind:value={searchQuery}
				oninput={handleSearchInput}
				onkeydown={handleSearchKeydown}
				type="text"
				placeholder="Search..."
				class="flex-1 bg-transparent text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none"
			/>
			{#if searchLoading}
				<span class="text-[10px] text-[var(--color-text-muted)]">...</span>
			{/if}
			<button
				onclick={closeSearch}
				class="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
				title="Close search"
			>
				<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>
	{/if}

	<div class="flex-1 overflow-y-auto">
		{#if conversationsLoading}
			<div class="p-3">
				<SkeletonLoader type="list" rows={8} />
			</div>
		{:else if isSearchActive}
			<!-- Search results view -->
			{#if filteredConversations().length === 0 && !searchLoading}
				<p class="p-4 text-xs text-[var(--color-text-muted)]">No matching conversations</p>
			{:else}
				{#each filteredConversations() as conv (conv.id)}
					{@const isActive = activeConversationId === conv.id}
					<button
						onclick={() => onselect(conv.id)}
						class="flex w-full flex-col px-3 py-2 text-left transition-colors
							{isActive ? 'bg-[var(--color-surface-tertiary)]' : 'hover:bg-[var(--color-surface-tertiary)]/70'}"
					>
						<span class="truncate text-sm {isActive ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}">
							<MentionText text={conv.title} />
						</span>
						{#if conv.snippet}
							<span class="line-clamp-1 text-[10px] text-[var(--color-text-muted)] [&_mark]:bg-yellow-500/30 [&_mark]:text-yellow-200 [&_mark]:rounded-sm">
								{@html conv.snippet}
							</span>
						{:else}
							<span class="text-[10px] text-[var(--color-text-muted)]">{relativeTime(conv.updatedAt)}</span>
						{/if}
					</button>
				{/each}
			{/if}
		{:else if grouped().length === 0}
			<p class="p-4 text-xs text-[var(--color-text-muted)]">No conversations yet</p>
		{:else}
			{#snippet conversationRow(
				conv: Conversation,
				rowOpts: {
					indent: boolean;
					chevron: "open" | "closed" | null;
					unreadBadgeCount: number;
					forkCount: number;
					onChevronClick?: () => void;
				},
			)}
				{@const isActive = activeConversationId === conv.id}
				<div class="group relative">
					{#if renamingId === conv.id}
						<div class="pl-7 pr-3 py-1.5 {rowOpts.indent ? 'pl-10' : ''}">
							<input
								type="text"
								bind:value={renameValue}
								onkeydown={(e) => {
									if (e.key === "Enter") finishRename();
									if (e.key === "Escape") (renamingId = null);
								}}
								onblur={finishRename}
								class="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] px-2 py-1 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
							/>
						</div>
					{:else}
						<!-- Left padding `pl-7` reserves a 28px gutter for the chevron, so
						     titles line up across all root rows whether or not a chevron
						     is present. Fork rows step in another notch (`pl-10`) so the
						     ↳ connector glyph reads as a child of the title above. -->
						<button
							onclick={() => onselect(conv.id)}
							class="flex w-full flex-col pl-7 pr-3 py-2 text-left transition-colors {rowOpts.indent ? 'pl-10' : ''}
								{isActive ? 'bg-[var(--color-surface-tertiary)]' : 'hover:bg-[var(--color-surface-tertiary)]/70'}"
						>
							<span class="flex items-center gap-1.5 truncate text-sm {isActive ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}">
								{#if rowOpts.indent}
									<span class="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true">↳</span>
								{/if}
								{#if conv.test}
									<span class="shrink-0 rounded bg-amber-600/80 px-1 py-0.5 text-[9px] font-bold uppercase leading-none text-white">TEST</span>
								{/if}
								<span class="truncate"><MentionText text={conv.title} /></span>
								{#if rowOpts.forkCount > 0}
									<span
										class="ml-auto flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[9px] font-medium leading-none text-[var(--color-text-muted)]"
										title="{rowOpts.forkCount} fork{rowOpts.forkCount === 1 ? '' : 's'}"
										aria-label="{rowOpts.forkCount} fork{rowOpts.forkCount === 1 ? '' : 's'}"
										data-testid="fork-count-badge"
									>
										<svg class="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
												d="M6 3v12m0 0a3 3 0 103 3m-3-3a3 3 0 113-3m12-6a3 3 0 11-3-3 3 3 0 013 3zM18 9a9 9 0 01-9 9" />
										</svg>
										{rowOpts.forkCount}
									</span>
								{/if}
								{#if rowOpts.unreadBadgeCount > 0}
									<span
										class="{rowOpts.forkCount > 0 ? '' : 'ml-auto'} shrink-0 rounded-full bg-green-500/20 px-1.5 py-0.5 text-[9px] font-medium leading-none text-green-300"
										title="{rowOpts.unreadBadgeCount} unread fork{rowOpts.unreadBadgeCount === 1 ? '' : 's'}"
									>
										{rowOpts.unreadBadgeCount}
									</span>
								{/if}
							</span>
							{#if conv.agentConfigId}
								<span class="block truncate text-xs text-blue-400">Agent conversation</span>
							{/if}
							<span class="text-[10px] text-[var(--color-text-muted)]">{relativeTime(conv.updatedAt)}</span>
						</button>
						{#if rowOpts.chevron !== null}
							<button
								onclick={rowOpts.onChevronClick}
								class="absolute left-1 top-2.5 flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-secondary)]"
								title={rowOpts.chevron === "open" ? "Collapse forks" : "Expand forks"}
								aria-label={rowOpts.chevron === "open" ? "Collapse forks" : "Expand forks"}
							>
								<svg class="h-3 w-3 transition-transform {rowOpts.chevron === 'open' ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
								</svg>
							</button>
						{/if}
						{#if !isActive && unreadRev >= 0 && unreadStore.isUnread(conv.id)}
							<span class="absolute top-1.5 right-1.5 h-2.5 w-2.5 rounded-full bg-green-500" title="New activity"></span>
						{/if}
						<!-- Quick actions on hover -->
						<div class="absolute right-2 top-1/2 -translate-y-1/2 hidden gap-1 group-hover:flex">
							<button
								onclick={() => startRename(conv)}
								class="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-secondary)]"
								title="Rename"
							>
								<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
										d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
								</svg>
							</button>
							<button
								onclick={() => handleDelete(conv)}
								class="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-red-400"
								title="Delete"
							>
								<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
										d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
								</svg>
							</button>
						</div>
					{/if}
				</div>
			{/snippet}

			{#each grouped() as group}
				<div class="px-3 pt-3 pb-1">
					<span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
						{group.label}
					</span>
				</div>
				{#each group.families as fam (fam.root.id)}
					{@const hasForks = fam.forks.length > 0}
					{@const isCollapsed = collapsedRoots.has(fam.root.id)}
					{@const unreadInForks = unreadRev >= 0 ? unreadForkCount(fam, (id) => unreadStore.isUnread(id)) : 0}
					{@render conversationRow(fam.root, {
						indent: false,
						chevron: hasForks ? (isCollapsed ? "closed" : "open") : null,
						unreadBadgeCount: hasForks && isCollapsed ? unreadInForks : 0,
						forkCount: fam.forks.length,
						onChevronClick: () => toggleCollapse(fam.root.id),
					})}
					{#if hasForks && !isCollapsed}
						{#each fam.forks as fork (fork.id)}
							{@render conversationRow(fork, {
								indent: true,
								chevron: null,
								unreadBadgeCount: 0,
								forkCount: 0,
							})}
						{/each}
					{/if}
				{/each}
			{/each}
			{#if hasMore}
				<div bind:this={sentinelEl} class="h-8"></div>
			{/if}
			{#if loadingMore}
				<div class="px-3 py-2 text-center text-[10px] text-[var(--color-text-muted)]">Loading more...</div>
			{/if}
		{/if}
	</div>

	<DeleteConfirmDialog
		open={deleteTarget !== null}
		conversationTitle={deleteTarget?.title ?? ""}
		onconfirm={confirmDelete}
		oncancel={() => (deleteTarget = null)}
	/>
</div>
