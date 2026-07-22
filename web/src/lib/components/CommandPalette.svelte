<script lang="ts">
	import { page } from "$app/stores";
	import { goto } from "$app/navigation";
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
	import {
		searchMessages,
		type MessageSearchHit,
		type SearchMessagesResponse,
	} from "$lib/api.js";
	import { buildPaletteResults } from "$lib/search/palette-results.js";
	import { sanitizeSnippet } from "$lib/search/snippet-sanitize.js";
	import { openEzPanel } from "$lib/ez/panel-store.svelte.js";
	import { createFocusTrap } from "$lib/focus-trap.js";
	import BottomSheet from "./BottomSheet.svelte";
	import { useBreakpoint } from "$lib/use-breakpoint.svelte.js";
	import { store } from "$lib/stores.svelte.js";
	import { isIconUrl } from "$lib/project-icon.js";

	let {
		open,
		onclose,
		activeProjectId,
		// Which view the palette opens in. Wired by the layout (Plan 04) so
		// Cmd+K lands search-first and Cmd+Shift+P lands command-first. When
		// "commands" the input still opens focused, but no message search runs
		// until the user types ≥2 chars (commands-first browsing).
		initialView = "search",
		// The conversation the user is currently viewing (if any). Drives the
		// "In this conversation" grouping in buildPaletteResults.
		activeConversationId = null,
	}: {
		open: boolean;
		onclose: () => void;
		activeProjectId: string;
		initialView?: "search" | "commands";
		activeConversationId?: string | null;
	} = $props();

	let query = $state("");
	let highlightedIndex = $state(0);
	// Sub-menu navigation stack. Each entry is one drilled-in level (its `title`
	// drives the breadcrumb, its `children` are the rows shown). Empty = top
	// level. A stack (not a single `activeChildren`) so we can go 2+ levels deep:
	// Projects → a project → that project's actions.
	let navStack = $state<{ title: string; children: Command[] }[]>([]);
	let inputEl = $state<HTMLInputElement | null>(null);
	// The scrollable results container. Bound on the shared body snippet so the
	// SAME ref backs both the desktop modal and the mobile BottomSheet (the
	// snippet renders once per open). Drives keyboard-nav scroll-into-view.
	let resultsEl = $state<HTMLElement | null>(null);

	// At <lg the palette renders inside a BottomSheet (which owns its OWN
	// focus-trap + Escape); the desktop centered modal owns those itself. Gating
	// avoids a double focus-trap / double-Escape (67-RESEARCH Pitfall 3).
	const breakpoint = useBreakpoint("lg");
	let isMobile = $derived(breakpoint.below);

	// Cross-project message search state (driven purely by query length ≥2).
	let hits = $state<MessageSearchHit[]>([]);
	let searchLoading = $state(false);
	let degraded = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	// Token guards against an out-of-order debounced response clobbering a newer
	// one (last-write-wins on the latest query).
	let searchToken = 0;

	// The children of the deepest drilled-in level (null at the top level).
	let currentChildren = $derived(
		navStack.length > 0 ? navStack[navStack.length - 1].children : null,
	);

	// `ez:` prefix wins — it must NEVER trigger a message search.
	let ezPrefill = $derived(tryParseEzPrefix(query));
	// We're "searching" once the query is ≥2 chars and not an `ez:` command —
	// but ONLY at the top level. Inside a sub-menu, typing filters the current
	// list instead of falling through to global message search.
	let isSearching = $derived(
		navStack.length === 0 && ezPrefill === null && query.trim().length >= 2,
	);

	// Sub-menu rows, filtered by the query (reuses the command fuzzy matcher).
	// null when not in a sub-menu.
	let submenuItems = $derived.by((): Command[] | null => {
		if (!currentChildren) return null;
		return query ? fuzzyMatch(query, currentChildren) : currentChildren;
	});

	// Derive commands from current state. Projects come from the shared store
	// (already populated by the sidebar) so the palette can offer a per-project
	// drill-down without threading a prop through the layout.
	let allCommands = $derived(buildCommands(activeProjectId, store.projects));
	let contextCommands = $derived(resolveCommands(allCommands, $page.url.pathname));
	let recentIds = $derived(getRecentCommands());

	// Commands matching the current query (used both for the empty-query grouped
	// list and as the "Commands" section of the unified search results).
	let matchingCommands = $derived(
		query ? fuzzyMatch(query, contextCommands) : contextCommands,
	);

	// Group commands by their group field for the empty-query / non-searching view.
	let groupedItems = $derived.by(() => {
		if (isSearching || currentChildren) return null;

		const cmds = matchingCommands;

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

	// Unified search results: matching commands + cross-project message hits in
	// ONE keyboard-navigable list (Plan 05 helper). Only computed while searching.
	let paletteResults = $derived(
		isSearching
			? buildPaletteResults(matchingCommands, hits, activeConversationId)
			: null,
	);

	// Flat ordered list for keyboard navigation indexing. Heterogeneous while
	// searching (commands + hits, headers excluded); commands-only otherwise.
	let flatItems = $derived.by((): (Command | MessageSearchHit)[] => {
		if (submenuItems) return submenuItems;
		if (paletteResults) return paletteResults.flatItems;
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

	// Discriminant: message hits carry a `messageId`, commands do not.
	function isHit(item: Command | MessageSearchHit): item is MessageSearchHit {
		return "messageId" in item;
	}

	// Match-type glyph — Phase 66 parity (ConversationList.svelte matchTypeGlyph).
	function matchTypeGlyph(t: MessageSearchHit["matchType"]): string {
		if (t === "semantic") return "≈"; // approximate / vector match
		if (t === "both") return "⊕"; // lexical + semantic
		return "“"; // lexical / keyword match
	}

	// Deterministic fallback avatar color from a project name — ProjectRail
	// parity, so a logo-less project shows the SAME colored letter as the
	// sidebar.
	const BG_COLORS = [
		"bg-blue-600",
		"bg-green-600",
		"bg-purple-600",
		"bg-orange-600",
		"bg-pink-600",
		"bg-teal-600",
		"bg-indigo-600",
		"bg-red-600",
	];
	function hashColor(name: string): string {
		let hash = 0;
		for (let i = 0; i < name.length; i++) {
			hash = (hash * 31 + name.charCodeAt(i)) | 0;
		}
		return BG_COLORS[Math.abs(hash) % BG_COLORS.length]!;
	}

	// Project icon image source for a hit's owning project, looked up from the
	// shared store (already populated by the sidebar — same source `buildCommands`
	// uses). A project `icon` is an image URL / data-URI (ProjectRail renders it
	// via <img>), NOT an emoji. null when the project has no icon set, carries a
	// non-URL token (e.g. a Lucide name that would 404 as an <img src>), OR isn't
	// in the store — so the badge falls back to the colored-initial avatar. Cheap
	// linear scan — the project list is small.
	function projectIconSrc(projectId: string | undefined): string | null {
		if (!projectId) return null;
		const icon = store.projects.find((p) => p.id === projectId)?.icon ?? null;
		return isIconUrl(icon) ? icon : null;
	}

	// Relative-time formatter — Phase 66 parity (ConversationList.svelte).
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

	function resetState() {
		query = "";
		highlightedIndex = 0;
		navStack = [];
		hits = [];
		searchLoading = false;
		degraded = false;
		searchToken++; // invalidate any in-flight debounced search
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
			// Drill into this command's sub-menu (push a level onto the stack).
			navStack.push({ title: cmd.label, children: cmd.children });
			highlightedIndex = 0;
			query = "";
			return;
		}
		addRecentCommand(cmd.id);
		cmd.action();
		resetState();
		onclose();
	}

	// Cross-project message-hit deep-link. Mirrors the chat page's `?m=` consume
	// shape so ChatThread pulses + strips the param on arrival.
	function selectHit(hit: MessageSearchHit) {
		goto(
			`/project/${hit.projectId}/chat/${hit.conversationId}?m=${encodeURIComponent(hit.messageId)}`,
		);
		resetState();
		onclose();
	}

	function goBack() {
		// Pop one level (back up the sub-menu stack).
		navStack.pop();
		query = "";
		highlightedIndex = 0;
	}

	// Debounced cross-project search. Fires only for ≥2-char, non-`ez:` queries.
	function runSearch() {
		clearTimeout(debounceTimer);
		if (!isSearching) {
			hits = [];
			degraded = false;
			searchLoading = false;
			return;
		}
		searchLoading = true;
		const token = ++searchToken;
		const q = query;
		debounceTimer = setTimeout(async () => {
			let resp: SearchMessagesResponse | null = null;
			try {
				resp = await searchMessages(activeProjectId, q, { scope: "all" });
			} catch {
				resp = null;
			}
			// Drop stale responses (a newer keystroke superseded this one).
			if (token !== searchToken) return;
			if (resp) {
				hits = resp.hits;
				// NEVER persist mode on a degraded response (Phase 66 Pitfall 4) —
				// we only surface a non-blocking notice; the stored preference is
				// owned by the sidebar and untouched here.
				degraded = resp.degraded === true;
			} else {
				hits = [];
				degraded = false;
			}
			searchLoading = false;
			highlightedIndex = 0;
		}, 300);
	}

	function handleInput() {
		highlightedIndex = 0;
		runSearch();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.stopPropagation();
			resetState();
			onclose();
			return;
		}

		if (e.key === "Backspace" && query === "" && navStack.length > 0) {
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
					// Row-type-aware: command → action; hit → cross-project deep-link.
					if (isHit(item)) {
						selectHit(item);
					} else {
						executeCommand(item);
					}
				}
			}
		}
	}

	// Focus trap + Escape — DESKTOP ONLY. On mobile, BottomSheet owns both
	// (Pitfall 3 — never double-trap / double-Escape).
	let cleanupTrap: (() => void) | null = null;
	let dialogEl = $state<HTMLElement | null>(null);

	$effect(() => {
		if (open && !isMobile && dialogEl) {
			cleanupTrap = createFocusTrap(dialogEl);
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
			return () => {
				cleanupTrap?.();
				cleanupTrap = null;
				document.removeEventListener("keydown", onDocKeydown, true);
			};
		}
	});

	// Reset palette state when it closes (both desktop + mobile).
	$effect(() => {
		if (!open) resetState();
	});

	// Auto-focus the search input whenever the palette opens — in BOTH the
	// desktop modal and the mobile sheet (per CONTEXT). For initialView
	// "commands" the input is still focused (typing flows straight in), it just
	// begins on the command list since no query has been typed yet.
	$effect(() => {
		if (open && inputEl) {
			requestAnimationFrame(() => inputEl?.focus());
		}
	});

	// Keep the keyboard-active row in view. ONE effect (DRY — not per-layout):
	// the results container is the shared body snippet, so this reacts to the
	// active index across BOTH the desktop modal and the mobile BottomSheet. A
	// long result set can push the active row below the fold (or above the top)
	// as Arrow ↑/↓ moves the index; `block: "nearest"` only scrolls when the row
	// is actually out of view, avoiding jarring re-centering on every keystroke.
	// `flatItems.length` is read so the effect re-runs when the list changes
	// (e.g. search results arrive) and re-aligns the active row.
	$effect(() => {
		// Track the active index + list size so Svelte re-runs on either change.
		const idx = highlightedIndex;
		void flatItems.length;
		if (!open || !resultsEl) return;
		const activeRow = resultsEl.querySelector<HTMLElement>('[data-active="true"]');
		// Defer to the next frame so the row's `data-active` has been applied to
		// the DOM before we measure + scroll (the attribute and this effect both
		// react to the same `highlightedIndex` change). Guard `scrollIntoView` —
		// jsdom (and other no-layout environments) don't implement it.
		if (activeRow && typeof activeRow.scrollIntoView === "function") {
			requestAnimationFrame(() => {
				if (idx === highlightedIndex) activeRow.scrollIntoView({ block: "nearest" });
			});
		}
	});

	// Helper: index of a row (command OR hit) in the flat nav list. Identity
	// match — buildPaletteResults emits the SAME object references it renders, so
	// indexOf maps a rendered row to its keyboard-nav position (headers excluded).
	function flatIndex(item: Command | MessageSearchHit): number {
		return flatItems.indexOf(item);
	}
</script>

<!-- Per-group leading icon for command rows. Gives commands a visual anchor
     so they read as "actions you run" — distinct from message-search hits,
     which carry a role badge + match glyph instead and get NO leading icon.
     Keyed off the command's `group`; the bolt is the Actions / fallback. -->
{#snippet groupIcon(cmd: Command)}
	{#if cmd.group === "Navigate"}
		<!-- diagonal arrow — "go to" -->
		<svg class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 17L17 7M9 7h8v8" />
		</svg>
	{:else if cmd.group === "Search"}
		<!-- magnifier -->
		<svg class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
		</svg>
	{:else if cmd.group === "Ez"}
		<!-- sparkle — Ez / AI -->
		<svg class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3l1.8 5.4a2 2 0 001.8 1.3L21 11l-5.4.3a2 2 0 00-1.8 1.3L12 18l-1.8-5.4a2 2 0 00-1.8-1.3L3 11l5.4-.3a2 2 0 001.8-1.3L12 3z" />
		</svg>
	{:else if cmd.group === "Project"}
		<!-- folder — projects (matches the sidebar's ProjectPicker fallback) -->
		<svg class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
		</svg>
	{:else}
		<!-- lightning bolt — Actions (and any future group) -->
		<svg class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
		</svg>
	{/if}
{/snippet}

<!-- Project badge for a search-result conversation header — the project's logo
     image when set, else a colored-initial avatar (ProjectRail / command-row
     parity), trailed by the project name. Right-aligned via `ml-auto` so each
     chat group carries a clear project identifier in its top-right corner. -->
{#snippet projectBadge(projectId: string | undefined, projectName: string)}
	{@const iconSrc = projectIconSrc(projectId)}
	<span
		class="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-text-muted)]"
		data-testid="palette-project-badge"
		title={projectName}
	>
		<span
			class="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded {iconSrc ? '' : hashColor(projectName)}"
			data-testid="palette-project-avatar"
			aria-hidden="true"
		>
			{#if iconSrc}
				<img src={iconSrc} alt={projectName} class="h-full w-full object-cover" />
			{:else}
				<span class="text-[8px] font-semibold leading-none text-white">{projectName.charAt(0).toUpperCase()}</span>
			{/if}
		</span>
		<span class="truncate">{projectName}</span>
	</span>
{/snippet}

<!-- Single command-row renderer — shared by EVERY command surface (unified
     search section, recent, grouped list, nested children). One source of
     truth for the leading icon + label + shortcut + sub-menu chevron, so the
     four lists never drift (DRY). `idx` resolves via flatIndex so keyboard
     highlight + scroll-into-view stay correct in all contexts. -->
{#snippet commandRow(cmd: Command)}
	{@const idx = flatIndex(cmd)}
	<button
		data-row-kind="command"
		data-active={idx === highlightedIndex}
		class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors {idx === highlightedIndex ? 'bg-[var(--color-surface-tertiary)]' : 'hover:bg-[var(--color-surface-tertiary)]/50'}"
		onclick={() => executeCommand(cmd)}
	>
		{#if cmd.avatar}
			<!-- Project logo (sidebar parity): the icon image when set, else a
			     colored avatar with the project's first letter. aria-hidden so the
			     button's accessible name stays just the project label. -->
			<span
				class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md {cmd.avatar.src ? '' : hashColor(cmd.avatar.name)}"
				data-testid="cmd-avatar"
				aria-hidden="true"
			>
				{#if cmd.avatar.src}
					<img src={cmd.avatar.src} alt={cmd.avatar.name} class="h-full w-full object-cover" />
				{:else}
					<span class="text-[10px] font-semibold text-white">{cmd.avatar.name.charAt(0).toUpperCase()}</span>
				{/if}
			</span>
		{:else if cmd.icon}
			<!-- Custom glyph rendered in the icon slot in place of the group SVG. -->
			<span class="flex h-4 w-4 shrink-0 items-center justify-center text-sm leading-none" aria-hidden="true">{cmd.icon}</span>
		{:else}
			{@render groupIcon(cmd)}
		{/if}
		<span class="flex-1 text-[var(--color-text-primary)]">{cmd.label}</span>
		{#if cmd.shortcut}
			<kbd class="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">{cmd.shortcut}</kbd>
		{/if}
		{#if cmd.children}
			<svg class="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
			</svg>
		{/if}
	</button>
{/snippet}

<!-- Palette body — rendered IDENTICALLY inside the desktop modal AND the
     mobile BottomSheet so the section nesting (commands + project/conversation
     groups) is never flattened on mobile (Pitfall 4). -->
{#snippet body()}
			<!-- Input bar -->
			<div class="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
				{#if navStack.length > 0}
					<button
						class="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
						onclick={goBack}
						aria-label="Back"
					>
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
						</svg>
					</button>
					<!-- Breadcrumb: which sub-menu level you're in (e.g. a project name). -->
					<span
						class="shrink-0 max-w-[45%] truncate text-xs font-medium text-[var(--color-text-secondary)]"
						data-testid="palette-breadcrumb"
					>
						{navStack[navStack.length - 1].title}
					</span>
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
					placeholder={navStack.length > 0 ? "Filter…" : "Search messages or type a command..."}
					aria-label="Command palette input"
					class="flex-1 bg-transparent text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] outline-none"
				/>
				<kbd class="hidden rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] sm:inline">ESC</kbd>
			</div>

			<!-- Results area -->
			<div bind:this={resultsEl} class="max-h-[50vh] overflow-y-auto">
				{#if paletteResults}
					<!-- Unified search: matching commands + cross-project message
					     hits in ONE keyboard-navigable list. Project / conversation
					     headers are render-only (never enter flatItems / nav). -->
					{#if degraded}
						<div
							class="border-b border-[var(--color-border)] bg-[var(--color-surface-tertiary)]/40 px-4 py-2 text-xs text-[var(--color-text-muted)]"
							role="status"
						>
							Semantic search unavailable — showing keyword (degraded) results.
						</div>
					{/if}

					{@const hasCommands = paletteResults.sections.some((s) => s.id === "commands")}
					{@const hasHits = hits.length > 0}
					<!-- Commands header is always present while searching so the
					     palette stays "commands + hits together" even when the
					     query matches no command (test contract / must-have).
					     Suppressed only in the truly-empty state (no commands AND
					     no hits) so a single "No matching messages." shows. -->
					{#if !hasCommands && hasHits}
						<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]" data-row-kind="header">
							Commands
						</div>
						<div class="px-4 py-1.5 text-xs text-[var(--color-text-muted)]">No matching commands</div>
					{/if}

					{#each paletteResults.sections as section (section.id)}
						<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]" data-row-kind="header">
							{section.label}
						</div>
						{#each section.groups as group, gi (group.conversationId ?? `cmd-${gi}`)}
							{#if group.conversationTitle}
								<div class="flex items-center gap-1.5 px-4 pt-1.5 pb-0.5" data-row-kind="header">
									<span class="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--color-text-secondary)]">
										<MentionText text={group.conversationTitle} />
									</span>
									{#if group.projectName}
										{@render projectBadge(group.projectId, group.projectName)}
									{/if}
								</div>
							{/if}
							{#each group.rows as row (row.kind === "command" ? row.command.id : row.hit.messageId)}
								{#if row.kind === "command"}
									{@render commandRow(row.command)}
								{:else}
									{@const idx = flatIndex(row.hit)}
									<button
										data-row-kind="hit"
										data-active={idx === highlightedIndex}
										class="flex w-full flex-col gap-0.5 px-4 py-1.5 text-left transition-colors {idx === highlightedIndex ? 'bg-[var(--color-surface-tertiary)]' : 'hover:bg-[var(--color-surface-tertiary)]/50'}"
										onclick={() => selectHit(row.hit)}
									>
										<span class="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
											<span class="shrink-0 rounded bg-[var(--color-surface-tertiary)] px-1 py-0.5 text-[9px] font-medium uppercase leading-none">{row.hit.role}</span>
											<span class="shrink-0" title="{row.hit.matchType} match" aria-hidden="true">{matchTypeGlyph(row.hit.matchType)}</span>
											<span class="ml-auto shrink-0">{relativeTime(row.hit.createdAt)}</span>
										</span>
										<span class="line-clamp-2 text-[11px] text-[var(--color-text-secondary)] [&_mark]:bg-yellow-500/30 [&_mark]:text-yellow-200 [&_mark]:rounded-sm">
											{@html sanitizeSnippet(row.hit.snippet)}
										</span>
									</button>
								{/if}
							{/each}
						{/each}
					{/each}

					{#if paletteResults.sections.length === 0 && !searchLoading}
						<div class="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">No matching messages.</div>
					{/if}

				{:else if submenuItems}
					<!-- Nested sub-list — same renderer as every other command
					     surface so children get the leading icon too (DRY).
					     `submenuItems` is the current level filtered by the query. -->
					{#each submenuItems as cmd (cmd.id)}
						{@render commandRow(cmd)}
					{/each}
					{#if submenuItems.length === 0}
						<div class="px-4 py-6 text-center text-sm text-[var(--color-text-muted)]">
							{query ? "No matching items" : "No items"}
						</div>
					{/if}

				{:else if groupedItems}
					<!-- Main command list -->
					{#if groupedItems.recent.length > 0}
						<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
							Recent
						</div>
						{#each groupedItems.recent as cmd (cmd.id)}
							{@render commandRow(cmd)}
						{/each}
					{/if}

					{#each [...groupedItems.groups] as [groupName, cmds] (groupName)}
						<div class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
							{groupName}
						</div>
						{#each cmds as cmd (cmd.id)}
							{@render commandRow(cmd)}
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
{/snippet}

{#if open}
	{#if isMobile}
		<!-- Mobile: BottomSheet owns backdrop + focus-trap + Escape. Keydown
		     (arrows / Enter / ez:) still flows through the palette handler. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div onkeydown={handleKeydown}>
			<BottomSheet open {onclose} ariaLabel="Search">
				{@render body()}
			</BottomSheet>
		</div>
	{:else}
		<!-- Desktop: centered modal with its own a11y + focus-restore-on-close. -->
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
				{@render body()}
			</div>
		</div>
	{/if}
{/if}
