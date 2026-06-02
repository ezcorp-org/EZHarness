<script lang="ts">
	import type { Message } from "$lib/api.js";
	import type { InlineToolCall } from "$lib/inline-tool-store.svelte.js";
	import SwipeDrawer from "./SwipeDrawer.svelte";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";
	import { extractDiffBlocks, aggregateToolCallDiffs } from "$lib/diff-aggregator.js";
	import * as Diff2Html from "diff2html";
	// diff2html-patched.css + hljs-theme.css are loaded globally via app.css
	// (Svelte-scoped imports confuse @tailwindcss/vite — issue #16233).
	import { highlightDiff } from "$lib/highlight-diff.js";
	import { loadDiffViewMode, persistDiffViewMode, type DiffViewMode } from "$lib/diff-view-mode.js";

	let {
		messages = [],
		toolCalls = [],
		open = false,
		onclose,
		streaming = false,
	}: {
		messages: Message[];
		toolCalls: InlineToolCall[];
		open: boolean;
		onclose: () => void;
		streaming: boolean;
	} = $props();

	// Extract diff blocks from completed messages (skip last if streaming)
	let codeDiffs = $derived.by(() => {
		const msgs = streaming ? messages.slice(0, -1) : messages;
		return msgs
			.filter((m) => m.role === "assistant" && m.content)
			.flatMap((m) => extractDiffBlocks(m.content, m.id));
	});

	// Aggregate tool call diffs from completed tool calls
	let fileChanges = $derived.by(() => {
		const completed = toolCalls.filter((tc) => tc.status === "complete");
		return aggregateToolCallDiffs(
			completed.map((tc) => ({ toolName: tc.toolName, input: tc.input, output: tc.output })),
		);
	});

	// Stats
	let totalFiles = $derived(fileChanges.length + codeDiffs.length);

	// Collapse state per section: key is "file-{idx}" or "code-{idx}"
	let expanded = $state<Set<string>>(new Set());
	// Split/unified is a global personal preference — restore the last pick so a
	// refresh doesn't snap back to split. See $lib/diff-view-mode.ts.
	let diffView = $state<DiffViewMode>(loadDiffViewMode());
	let panelBody = $state<HTMLElement | undefined>(undefined);

	function setDiffView(mode: DiffViewMode) {
		diffView = mode;
		persistDiffViewMode(mode);
	}

	// Re-apply hljs highlighting whenever the set of expanded diffs, the view
	// mode, or the underlying diff inputs change. Walks every .d2h-file-wrapper
	// currently in the DOM, so it handles lazy-expanded sections too.
	$effect(() => {
		void expanded;
		void diffView;
		void fileChanges;
		void codeDiffs;
		if (panelBody) highlightDiff(panelBody);
	});

	// Auto-expand all sections when fewer than 10 files
	$effect(() => {
		if (totalFiles > 0 && totalFiles < 10) {
			const keys = new Set<string>();
			fileChanges.forEach((_, i) => keys.add(`file-${i}`));
			codeDiffs.forEach((_, i) => keys.add(`code-${i}`));
			expanded = keys;
		}
	});

	function toggleSection(key: string) {
		const next = new Set(expanded);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expanded = next;
	}

	function renderDiffHtml(diffText: string): string {
		try {
			const parsed = Diff2Html.parse(diffText);
			return Diff2Html.html(parsed, { outputFormat: diffView, drawFileList: false });
		} catch {
			return `<pre>${diffText}</pre>`;
		}
	}
</script>

<SwipeDrawer {open} side="right" width="w-full md:w-[48rem]" {onclose} ariaLabel="Diff summary">
	<div
		class="flex h-full flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
		data-testid="diff-summary-panel"
	>
		<div class="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
			<div class="flex items-center gap-2">
				<h2 class="text-sm font-semibold text-[var(--color-text-primary)]">Diff Summary</h2>
				<InfoTooltip key="chat.diff-panel" />
				{#if totalFiles > 0}
					<span class="text-xs text-[var(--color-text-muted)]">{totalFiles} file{totalFiles !== 1 ? "s" : ""}</span>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				<div class="flex rounded border border-[var(--color-border)] text-xs" data-testid="diff-view-toggle">
					<button
						onclick={() => setDiffView("side-by-side")}
						class="px-2 py-1 transition-colors {diffView === 'side-by-side' ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}"
					>Split</button>
					<button
						onclick={() => setDiffView("line-by-line")}
						class="px-2 py-1 transition-colors {diffView === 'line-by-line' ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}"
					>Unified</button>
				</div>
				<button
					type="button"
					onclick={onclose}
					aria-label="Close"
					class="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
					data-testid="diff-panel-close"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>
		</div>

		<div bind:this={panelBody} class="flex-1 overflow-y-auto p-4 space-y-4">
			{#if fileChanges.length === 0 && codeDiffs.length === 0}
				<!-- Empty state -->
				<div class="flex flex-col items-center justify-center py-12 text-center" data-testid="diff-panel-empty">
					<svg class="h-10 w-10 text-[var(--color-text-muted)] mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
					</svg>
					<p class="text-sm text-[var(--color-text-muted)]">No file changes in this conversation</p>
				</div>
			{:else}
				<!-- File Changes section -->
				{#if fileChanges.length > 0}
					<div>
						<h3 class="mb-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">File Changes</h3>
						{#each fileChanges as group, i}
							{@const key = `file-${i}`}
							{@const isExpanded = expanded.has(key)}
							<div class="mb-2 rounded border border-[var(--color-border)] overflow-hidden" data-testid="diff-file-section" data-expanded={isExpanded}>
								<button
									class="w-full flex items-center gap-2 px-3 py-2 text-left text-xs bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
									onclick={() => toggleSection(key)}
									data-testid="diff-file-toggle"
								>
									<svg class="h-3 w-3 transition-transform {isExpanded ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
									</svg>
									<span class="font-mono text-[var(--color-text-primary)] truncate">{group.filePath}</span>
									<span class="ml-auto text-[var(--color-text-muted)]">{group.diffs.length} edit{group.diffs.length !== 1 ? "s" : ""}</span>
								</button>
								{#if isExpanded}
									<div class="p-2 overflow-x-auto diff-panel-content">
										{#each group.diffs as diff}
											{@html renderDiffHtml(diff)}
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				<!-- Code Diffs section -->
				{#if codeDiffs.length > 0}
					<div>
						<h3 class="mb-2 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">Code Diffs</h3>
						{#each codeDiffs as diff, i}
							{@const key = `code-${i}`}
							{@const isExpanded = expanded.has(key)}
							<div class="mb-2 rounded border border-[var(--color-border)] overflow-hidden" data-testid="diff-code-section" data-expanded={isExpanded}>
								<button
									class="w-full flex items-center gap-2 px-3 py-2 text-left text-xs bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
									onclick={() => toggleSection(key)}
									data-testid="diff-code-toggle"
								>
									<svg class="h-3 w-3 transition-transform {isExpanded ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
									</svg>
									<span class="font-mono text-[var(--color-text-primary)] truncate">{diff.fileName ?? "unnamed diff"}</span>
								</button>
								{#if isExpanded}
									<div class="p-2 overflow-x-auto diff-panel-content">
										{@html renderDiffHtml(diff.content)}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</div>
</SwipeDrawer>

<style>
	.diff-panel-content :global(.d2h-wrapper) {
		font-size: 11px;
		background: transparent;
	}
	.diff-panel-content :global(.d2h-file-header) {
		display: none;
	}
	.diff-panel-content :global(.d2h-file-wrapper) {
		border: none;
		margin-bottom: 0;
	}
	.diff-panel-content :global(table) {
		width: 100%;
	}
	.diff-panel-content :global(.d2h-diff-table) {
		border-collapse: collapse;
		font-size: 0.85em;
	}
	.diff-panel-content :global(.d2h-diff-tbody tr td) {
		border: none;
		padding: 0 0.5rem;
	}
	.diff-panel-content :global(.d2h-file-diff) {
		overflow-x: auto;
	}

	/* Dark mode overrides */
	:global(.dark) .diff-panel-content :global(.d2h-file-wrapper) {
		border-color: var(--color-border);
	}
	:global(.dark) .diff-panel-content :global(.d2h-code-side-emptyplaceholder),
	:global(.dark) .diff-panel-content :global(.d2h-emptyplaceholder) {
		background-color: rgba(255, 255, 255, 0.05);
	}
	:global(.dark) .diff-panel-content :global(.d2h-ins) {
		background-color: rgba(126, 231, 135, 0.1);
	}
	:global(.dark) .diff-panel-content :global(.d2h-del) {
		background-color: rgba(255, 161, 152, 0.1);
	}
	:global(.dark) .diff-panel-content :global(.d2h-ins .d2h-code-side-line),
	:global(.dark) .diff-panel-content :global(.d2h-ins .d2h-code-line) {
		background-color: rgba(126, 231, 135, 0.15);
	}
	:global(.dark) .diff-panel-content :global(.d2h-del .d2h-code-side-line),
	:global(.dark) .diff-panel-content :global(.d2h-del .d2h-code-line) {
		background-color: rgba(179, 29, 40, 0.15);
	}
	:global(.dark) .diff-panel-content :global(.d2h-info) {
		background-color: rgba(255, 255, 255, 0.05);
		color: var(--color-text-muted);
	}
	.diff-panel-content :global(.d2h-code-linenumber),
	.diff-panel-content :global(.d2h-code-side-linenumber) {
		color: #000;
	}
	:global(.dark) .diff-panel-content :global(.d2h-code-linenumber),
	:global(.dark) .diff-panel-content :global(.d2h-code-side-linenumber) {
		color: #fff;
	}
</style>
