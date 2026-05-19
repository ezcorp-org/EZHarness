<script lang="ts">
	import { page } from "$app/stores";
	import { goto } from "$app/navigation";
	import { searchConversations, type SearchResult } from "$lib/api.js";
	import MentionText from "./MentionText.svelte";
	import {
		type Command,
		buildCommands,
		resolveCommands,
		fuzzyMatch,
		addRecentCommand,
		getRecentCommands,
		tryParseEzPrefix,
	} from "$lib/command-registry.js";
	import { openEzPanel } from "$lib/ez/panel-store.svelte.js";
	import { createFocusTrap } from "$lib/focus-trap.js";

	let {
		open,
		onclose,
		activeProjectId,
	}: {
		open: boolean;
		onclose: () => void;
		activeProjectId: string;
	} = $props();

	let query = $state("");
	let highlightedIndex = $state(0);
	let activeChildren = $state<Command[] | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);

	// Conversation search sub-view state
	let searchMode = $state(false);
	let searchResults = $state<SearchResult[]>([]);
	let searchLoading = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	// Derive commands from current state
	let allCommands = $derived(buildCommands(activeProjectId));
	let contextCommands = $derived(resolveCommands(allCommands, $page.url.pathname));
	let recentIds = $derived(getRecentCommands());

	// Compute visible items (flat list for keyboard navigation)
	let visibleItems = $derived.by(() => {
		if (searchMode) return []; // search mode uses searchResults instead
		if (activeChildren) return activeChildren;

		const cmds = query
			? fuzzyMatch(query, contextCommands)
			: contextCommands;

		return cmds;
	});

	// Group commands by their group field for rendering
	let groupedItems = $derived.by(() => {
		if (searchMode || activeChildren) return null;

		const cmds = query
			? fuzzyMatch(query, contextCommands)
			: contextCommands;

		// Build recent section (only when no query)
		const recentSection: Command[] = [];
		if (!query && recentIds.length > 0) {
			for (const id of recentIds) {
				const cmd = cmds.find((c) => c.id === id);
				if (cmd) recentSection.push(cmd);
			}
		}

		// Group remaining commands
		const groups = new Map<string, Command[]>();
		for (const cmd of cmds) {
			if (!query && recentSection.some((r) => r.id === cmd.id)) continue; // skip dupes in recent
			const g = groups.get(cmd.group) ?? [];
			g.push(cmd);
			groups.set(cmd.group, g);
		}

		return { recent: recentSection, groups };
	});

	// Flat ordered list for keyboard navigation indexing
	let flatItems = $derived.by((): (Command | SearchResult)[] => {
		if (searchMode) return searchResults;
		if (activeChildren) return activeChildren;
		if (!groupedItems) return [];

		const flat: Command[] = [];
		if (groupedItems.recent.length > 0) {
			flat.push(...groupedItems.recent);
		}
		for (const [, cmds] of groupedItems.groups) {
			flat.push(...cmds);
		}
		return flat;
	});

	function resetState() {
		query = "";
		highlightedIndex = 0;
		activeChildren = null;
		searchMode = false;
		searchResults = [];
		searchLoading = false;
		clearTimeout(debounceTimer);
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			resetState();
			onclose();
		}
	}

	function executeCommand(cmd: Command) {
		if (cmd.children && cmd.children.length > 0) {
			activeChildren = cmd.children;
			highlightedIndex = 0;
			query = "";
			return;
		}
		if (cmd.id === "search-conversations") {
			searchMode = true;
			highlightedIndex = 0;
			query = "";
			return;
		}
		addRecentCommand(cmd.id);
		cmd.action();
		resetState();
		onclose();
	}

	function selectSearchResult(result: SearchResult) {
		goto(`/project/${activeProjectId}/chat/${result.id}`);
		resetState();
		onclose();
	}

	function goBack() {
		if (searchMode) {
			searchMode = false;
			searchResults = [];
			searchLoading = false;
		} else {
			activeChildren = null;
		}
		query = "";
		highlightedIndex = 0;
	}

	// Debounced conversation search
	function doConversationSearch() {
		clearTimeout(debounceTimer);
		if (query.length < 2 || !activeProjectId || activeProjectId === "global") {
			searchResults = [];
			searchLoading = false;
			return;
		}
		searchLoading = true;
		debounceTimer = setTimeout(async () => {
			try {
				searchResults = await searchConversations(activeProjectId, query);
			} catch {
				searchResults = [];
			}
			searchLoading = false;
			highlightedIndex = searchResults.length > 0 ? 0 : 0;
		}, 300);
	}

	function handleInput() {
		highlightedIndex = 0;
		if (searchMode) {
			doConversationSearch();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.stopPropagation();
			resetState();
			onclose();
			return;
		}

		if (e.key === "Backspace" && query === "" && (searchMode || activeChildren)) {
			e.stopPropagation();
			goBack();
			return;
		}

		const total = flatItems.length;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			if (total > 0) {
				highlightedIndex = (highlightedIndex + 1) % total;
			}
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			if (total > 0) {
				highlightedIndex = highlightedIndex <= 0 ? total - 1 : highlightedIndex - 1;
			}
			return;
		}
		if (e.key === "Enter") {
			// "ez: <prompt>" prefix shortcut — open the Ez panel with the
			// remainder pre-typed in the composer. Wins over any matched
			// command so users can't accidentally trigger a navigation.
			const prefill = tryParseEzPrefix(query);
			if (prefill !== null) {
				e.preventDefault();
				openEzPanel(prefill);
				resetState();
				onclose();
				return;
			}

			if (highlightedIndex >= 0 && highlightedIndex < total) {
				e.preventDefault();
				const item = flatItems[highlightedIndex];
				if (item) {
					if (searchMode) {
						selectSearchResult(item as SearchResult);
					} else {
						executeCommand(item as Command);
					}
				}
			}
		}
	}

	// Focus trap + auto-focus input when opened; reset when closed
	let cleanupTrap: (() => void) | null = null;
	let dialogEl = $state<HTMLElement | null>(null);

	$effect(() => {
		if (open && inputEl) {
			requestAnimationFrame(() => inputEl?.focus());
			// Set up focus trap after dialog renders
			if (dialogEl) {
				cleanupTrap = createFocusTrap(dialogEl);
			}
			// Document-level Escape listener. Using capture phase so we reliably
			// close the modal even if a nested handler (focus trap, input, etc.)
			// would otherwise swallow the event on bubble.
			const onDocKeydown = (e: KeyboardEvent) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					resetState();
					onclose();
				}
			};
			document.addEventListener("keydown", onDocKeydown, true);
			return () => document.removeEventListener("keydown", onDocKeydown, true);
		}
		if (!open) {
			cleanupTrap?.();
			cleanupTrap = null;
			resetState();
		}
	});

	// Helper: check if a command is in the flat list at a given index
	function flatIndex(cmd: Command): number {
		return (flatItems as Command[]).indexOf(cmd);
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[15vh]"
		onclick={handleBackdropClick}
		onkeydown={handleKeydown}
	>
		<div
			bind:this={dialogEl}
			class="mx-4 w-full max-w-lg overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-2xl"
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
		>
			<!-- Input bar -->
			<div class="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
				{#if searchMode || activeChildren}
					<button
						class="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
						onclick={goBack}
						aria-label="Back"
					>
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
						</svg>
					</button>
				{:else}
					<svg class="h-5 w-5 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
							d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
					</svg>
				{/if}
				<input
					bind:this={inputEl}
					bind:value={query}
					oninput={handleInput}
					type="text"
					placeholder={searchMode ? "Search conversations..." : "Type a command..."}
					aria-label={searchMode ? "Search conversations" : "Command palette input"}
					class="flex-1 bg-transparent text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none"
				/>
				<kbd class="hidden rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] sm:inline">ESC</kbd>
			</div>

			<!-- Results area -->
			<div class="max-h-[50vh] overflow-y-auto">
				{#if searchMode}
					<!-- Conversation search sub-view -->
					{#if searchLoading}
						<div class="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">Searching...</div>
					{:else if query.length >= 2 && searchResults.length === 0}
						<div class="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">No conversations found</div>
					{:else if query.length < 2}
						<div class="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">Type at least 2 characters to search</div>
					{:else}
						{#each searchResults as result, i (result.id)}
							<button
								class="flex w-full flex-col gap-1 px-4 py-2.5 text-left transition-colors {i === highlightedIndex ? 'bg-[var(--color-surface-tertiary)]' : 'hover:bg-[var(--color-surface-tertiary)]/50'}"
								onclick={() => selectSearchResult(result)}
							>
								<span class="truncate text-sm font-medium text-[var(--color-text-primary)]"><MentionText text={result.title} /></span>
								{#if result.snippet}
									<span class="line-clamp-1 text-xs text-[var(--color-text-muted)] [&_mark]:bg-yellow-500/30 [&_mark]:rounded-sm [&_mark]:px-0.5">
										{@html result.snippet}
									</span>
								{/if}
							</button>
						{/each}
					{/if}

				{:else if activeChildren}
					<!-- Nested sub-list -->
					{#each activeChildren as cmd, i (cmd.id)}
						<button
							class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors {i === highlightedIndex ? 'bg-[var(--color-surface-tertiary)]' : 'hover:bg-[var(--color-surface-tertiary)]/50'}"
							onclick={() => executeCommand(cmd)}
						>
							<span class="text-[var(--color-text-primary)]">{cmd.label}</span>
						</button>
					{/each}
					{#if activeChildren.length === 0}
						<div class="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">No items</div>
					{/if}

				{:else if groupedItems}
					<!-- Main command list -->
					{#if groupedItems.recent.length > 0}
						<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
							Recent
						</div>
						{#each groupedItems.recent as cmd (cmd.id)}
							{@const idx = flatIndex(cmd)}
							<button
								class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors {idx === highlightedIndex ? 'bg-[var(--color-surface-tertiary)]' : 'hover:bg-[var(--color-surface-tertiary)]/50'}"
								onclick={() => executeCommand(cmd)}
							>
								<span class="flex-1 text-[var(--color-text-primary)]">{cmd.label}</span>
								{#if cmd.shortcut}
									<kbd class="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">{cmd.shortcut}</kbd>
								{/if}
								{#if cmd.children}
									<svg class="h-3 w-3 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
									</svg>
								{/if}
							</button>
						{/each}
					{/if}

					{#each [...groupedItems.groups] as [groupName, cmds] (groupName)}
						<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
							{groupName}
						</div>
						{#each cmds as cmd (cmd.id)}
							{@const idx = flatIndex(cmd)}
							<button
								class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors {idx === highlightedIndex ? 'bg-[var(--color-surface-tertiary)]' : 'hover:bg-[var(--color-surface-tertiary)]/50'}"
								onclick={() => executeCommand(cmd)}
							>
								<span class="flex-1 text-[var(--color-text-primary)]">{cmd.label}</span>
								{#if cmd.shortcut}
									<kbd class="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">{cmd.shortcut}</kbd>
								{/if}
								{#if cmd.children}
									<svg class="h-3 w-3 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
									</svg>
								{/if}
							</button>
						{/each}
					{/each}

					{#if flatItems.length === 0}
						<div class="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">No matching commands</div>
					{/if}
				{/if}
			</div>

			<!-- Footer hint -->
			<div class="border-t border-[var(--color-border)] px-4 py-2 text-center text-[10px] text-[var(--color-text-muted)]">
				Type to filter &middot; Enter to select &middot; Esc to close
			</div>
		</div>
	</div>
{/if}
