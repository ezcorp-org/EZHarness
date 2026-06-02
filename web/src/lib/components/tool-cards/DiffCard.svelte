<script lang="ts">
	import type { ToolCallState } from "$lib/stores.svelte.js";
	import { slide } from "svelte/transition";
	import * as Diff2Html from "diff2html";
	// diff2html-patched.css + hljs-theme.css are loaded globally via app.css
	// (Svelte-scoped imports confuse @tailwindcss/vite — issue #16233).
	import { highlightDiff } from "$lib/highlight-diff.js";
	import { loadDiffViewMode, persistDiffViewMode, type DiffViewMode } from "$lib/diff-view-mode.js";
	import CopyButton from "./CopyButton.svelte";
	import { extractDiffDetails, extractDiffInput, generateDiffText, isNewFile as checkNewFile } from "./utils.js";

	let { toolCall }: { toolCall: ToolCallState } = $props();
	let expanded = $state(true);
	// Split/unified is a global personal preference — restore the last pick so a
	// refresh doesn't snap back to split. See $lib/diff-view-mode.ts.
	let diffView = $state<DiffViewMode>(loadDiffViewMode());
	let diffContainer = $state<HTMLElement | undefined>(undefined);

	function setDiffView(mode: DiffViewMode) {
		diffView = mode;
		persistDiffViewMode(mode);
	}

	let filePath = $derived.by((): string => {
		if (!toolCall.input || typeof toolCall.input !== 'object') return 'unknown file';
		const inp = toolCall.input as Record<string, unknown>;
		return typeof inp.path === 'string' ? inp.path : typeof inp.file_path === 'string' ? inp.file_path : 'unknown file';
	});

	// Live streaming carries the full {content, details} object; after a
	// page reload only tool_call.content is persisted, so output.details is
	// gone. Fall back to the tool INPUT (old_string/new_string) — the same
	// source the diff panel uses — so the inline card survives a refresh.
	let details = $derived(extractDiffDetails(toolCall.output));
	let inputContent = $derived(extractDiffInput(toolCall.input));

	let oldContent = $derived(details.oldContent ?? inputContent.oldContent ?? '');
	let newContent = $derived(details.newContent ?? inputContent.newContent ?? '');

	let isNew = $derived(checkNewFile(oldContent, newContent));

	let diffText = $derived(generateDiffText(oldContent, newContent, filePath));

	let diffHtml = $derived.by((): string => {
		if (!diffText) return '';
		try {
			const parsed = Diff2Html.parse(diffText);
			return Diff2Html.html(parsed, { outputFormat: diffView, drawFileList: false });
		} catch {
			return `<pre>${diffText}</pre>`;
		}
	});

	// Apply hljs highlighting after the diff HTML mounts / changes.
	$effect(() => {
		// Touch reactive deps so this re-runs whenever they change.
		void diffHtml;
		void diffView;
		if (diffContainer) highlightDiff(diffContainer);
	});
</script>

<div data-testid="tool-card-diff" class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] overflow-hidden">
	<!-- Header -->
	<button
		onclick={() => expanded = !expanded}
		class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs bg-[var(--color-surface-secondary)] hover:bg-[var(--color-surface-tertiary)] transition-colors"
	>
		<svg class="h-3 w-3 shrink-0 transition-transform {expanded ? 'rotate-90' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
		</svg>

		<svg class="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
			<path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
		</svg>

		<span class="font-mono text-[var(--color-text-primary)] truncate">{filePath}</span>

		{#if isNew}
			<span class="rounded-full bg-green-600/30 px-2 py-0.5 text-[10px] font-medium text-green-300">New file</span>
		{/if}

		<div class="ml-auto flex items-center gap-1">
			{#if newContent}
				<CopyButton text={newContent} />
			{/if}
		</div>
	</button>

	{#if expanded}
		<div transition:slide={{ duration: 150 }}>
			<!-- View toggle -->
			<div class="flex items-center gap-2 px-3 py-1 border-t border-[var(--color-border)] bg-[var(--color-surface-secondary)]">
				<div class="flex rounded border border-[var(--color-border)] text-[10px]">
					<button
						onclick={() => setDiffView("side-by-side")}
						class="px-2 py-0.5 transition-colors {diffView === 'side-by-side' ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}"
					>Split</button>
					<button
						onclick={() => setDiffView("line-by-line")}
						class="px-2 py-0.5 transition-colors {diffView === 'line-by-line' ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}"
					>Unified</button>
				</div>
			</div>

			<!-- Diff content -->
			<div bind:this={diffContainer} class="overflow-x-auto border-t border-[var(--color-border)] diff-card-content">
				{#if diffHtml}
					{@html diffHtml}
				{:else if isNew && newContent}
					<pre class="p-3 text-xs text-green-300 font-mono whitespace-pre-wrap">{newContent}</pre>
				{:else}
					<p class="p-3 text-xs text-[var(--color-text-muted)] italic">No diff available</p>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.diff-card-content :global(.d2h-wrapper) {
		font-size: 11px;
		background: transparent;
	}
	.diff-card-content :global(.d2h-file-header) {
		display: none;
	}
	.diff-card-content :global(.d2h-file-wrapper) {
		border: none;
		margin-bottom: 0;
	}
	.diff-card-content :global(table) {
		width: 100%;
	}
	.diff-card-content :global(.d2h-diff-table) {
		border-collapse: collapse;
		font-size: 0.85em;
	}
	.diff-card-content :global(.d2h-diff-tbody tr td) {
		border: none;
		padding: 0 0.5rem;
	}

	:global(.dark) .diff-card-content :global(.d2h-ins) {
		background-color: rgba(126, 231, 135, 0.1);
	}
	:global(.dark) .diff-card-content :global(.d2h-del) {
		background-color: rgba(255, 161, 152, 0.1);
	}
	:global(.dark) .diff-card-content :global(.d2h-ins .d2h-code-side-line),
	:global(.dark) .diff-card-content :global(.d2h-ins .d2h-code-line) {
		background-color: rgba(126, 231, 135, 0.15);
	}
	:global(.dark) .diff-card-content :global(.d2h-del .d2h-code-side-line),
	:global(.dark) .diff-card-content :global(.d2h-del .d2h-code-line) {
		background-color: rgba(179, 29, 40, 0.15);
	}
	:global(.dark) .diff-card-content :global(.d2h-info) {
		background-color: rgba(255, 255, 255, 0.05);
		color: var(--color-text-muted);
	}
	.diff-card-content :global(.d2h-code-linenumber),
	.diff-card-content :global(.d2h-code-side-linenumber) {
		color: #000;
	}
	:global(.dark) .diff-card-content :global(.d2h-code-linenumber),
	:global(.dark) .diff-card-content :global(.d2h-code-side-linenumber) {
		color: #fff;
	}
</style>
