<script lang="ts">
	/**
	 * One file in the review — GitHub's diff card.
	 *
	 * Header (sticky while the file's diff scrolls past): collapse chevron,
	 * `+N −M` counts, the five-square diffstat, the monospace path, a copy-path
	 * button, and the Viewed checkbox. Ticking Viewed collapses the body and
	 * greys the header, exactly like GitHub — the diff is still one click away.
	 */
	import type { ReviewFile } from "$lib/diff-review/review-model.js";
	import type { DiffViewMode } from "$lib/diff-view-mode.js";
	import { renderDiffHtml } from "$lib/diff-review/render-diff.js";
	import { highlightDiff } from "$lib/highlight-diff.js";
	import DiffStatBar from "./DiffStatBar.svelte";

	let {
		file,
		expanded,
		viewed,
		diffView,
		ontoggle,
		onviewed,
	}: {
		file: ReviewFile;
		expanded: boolean;
		viewed: boolean;
		diffView: DiffViewMode;
		ontoggle: () => void;
		onviewed: () => void;
	} = $props();

	let body = $state<HTMLElement | undefined>(undefined);
	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	// Viewed files stay collapsed until explicitly re-opened.
	let showDiff = $derived(expanded && !viewed);
	let diffHtml = $derived(showDiff ? renderDiffHtml(file.diffText, diffView) : "");

	const STATUS_LABEL: Record<ReviewFile["status"], string> = {
		added: "Added",
		removed: "Deleted",
		modified: "Modified",
	};

	$effect(() => {
		void diffHtml;
		if (body) highlightDiff(body);
	});

	$effect(() => () => clearTimeout(copyTimer));

	async function copyPath() {
		try {
			await navigator.clipboard.writeText(file.path);
			copied = true;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 1500);
		} catch {
			/* clipboard denied — the path is still selectable in the header */
		}
	}
</script>

<section
	class="gh-file"
	class:gh-file--viewed={viewed}
	data-testid="diff-file-card"
	data-path={file.path}
	data-status={file.status}
	data-expanded={showDiff}
	data-viewed={viewed}
	data-source={file.source}
	id="review-file-{file.key}"
>
	<div class="gh-file__header" data-testid="diff-file-header">
		<button
			type="button"
			class="gh-file__chevron-btn"
			data-testid="diff-file-toggle"
			aria-expanded={showDiff}
			aria-label={showDiff ? `Collapse ${file.path}` : `Expand ${file.path}`}
			onclick={ontoggle}
		>
			<svg
				class="gh-file__chevron"
				class:gh-file__chevron--open={showDiff}
				viewBox="0 0 16 16"
				width="16"
				height="16"
				aria-hidden="true"
			>
				<path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
			</svg>
		</button>

		<span class="gh-file__stat" data-testid="diff-file-stat">
			<span class="gh-file__add">+{file.additions}</span>
			<span class="gh-file__del">−{file.deletions}</span>
		</span>
		<DiffStatBar additions={file.additions} deletions={file.deletions} />

		<span class="gh-file__path" title={file.path}>{file.path}</span>

		{#if file.status !== "modified"}
			<span class="gh-file__badge gh-file__badge--{file.status}" data-testid="diff-file-status">
				{STATUS_LABEL[file.status]}
			</span>
		{/if}

		<button
			type="button"
			class="gh-file__icon-btn"
			data-testid="diff-copy-path"
			aria-label="Copy path"
			onclick={copyPath}
		>
			{#if copied}
				<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
					<path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
				</svg>
			{:else}
				<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
					<path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
					<path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
				</svg>
			{/if}
		</button>

		<label class="gh-file__viewed">
			<input
				type="checkbox"
				checked={viewed}
				data-testid="diff-viewed-checkbox"
				onchange={onviewed}
			/>
			<span>Viewed</span>
		</label>
	</div>

	{#if showDiff}
		<div bind:this={body} class="gh-file__body diff-panel-content" data-testid="diff-file-body">
			{@html diffHtml}
		</div>
	{/if}
</section>

<style>
	.gh-file {
		background-color: var(--gh-canvas);
		border: 1px solid var(--gh-border);
		border-radius: 6px;
		margin-bottom: 16px;
		overflow: hidden;
	}
	.gh-file--viewed .gh-file__path,
	.gh-file--viewed .gh-file__stat {
		opacity: 0.6;
	}

	.gh-file__header {
		align-items: center;
		background-color: var(--gh-canvas-subtle);
		border-bottom: 1px solid var(--gh-border);
		display: flex;
		gap: 8px;
		padding: 6px 8px 6px 6px;
		position: sticky;
		top: 0;
		z-index: 2;
	}
	/* Collapsed cards have no body, so the header owns the bottom radius. */
	.gh-file:not([data-expanded="true"]) .gh-file__header {
		border-bottom: 0;
	}

	.gh-file__chevron-btn,
	.gh-file__icon-btn {
		align-items: center;
		background: none;
		border: 0;
		border-radius: 4px;
		color: var(--gh-fg-muted);
		cursor: pointer;
		display: flex;
		justify-content: center;
		padding: 2px;
	}
	.gh-file__chevron-btn:hover,
	.gh-file__icon-btn:hover {
		background-color: var(--gh-border-muted);
		color: var(--gh-fg);
	}
	.gh-file__chevron {
		transition: transform 120ms ease;
	}
	.gh-file__chevron--open {
		transform: rotate(90deg);
	}

	.gh-file__stat {
		display: inline-flex;
		font-family: var(--gh-mono);
		font-size: 12px;
		gap: 4px;
		white-space: nowrap;
	}
	.gh-file__add {
		color: var(--gh-success-fg);
	}
	.gh-file__del {
		color: var(--gh-danger-fg);
	}

	.gh-file__path {
		color: var(--gh-fg);
		flex: 1;
		font-family: var(--gh-mono);
		font-size: 12px;
		font-weight: 600;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.gh-file__badge {
		border: 1px solid transparent;
		border-radius: 2em;
		font-size: 11px;
		font-weight: 500;
		line-height: 18px;
		padding: 0 7px;
		white-space: nowrap;
	}
	.gh-file__badge--added {
		background-color: rgba(45, 164, 78, 0.15);
		border-color: rgba(45, 164, 78, 0.4);
		color: var(--gh-success-fg);
	}
	.gh-file__badge--removed {
		background-color: rgba(207, 34, 46, 0.15);
		border-color: rgba(207, 34, 46, 0.4);
		color: var(--gh-danger-fg);
	}

	.gh-file__viewed {
		align-items: center;
		color: var(--gh-fg-muted);
		cursor: pointer;
		display: flex;
		font-size: 12px;
		gap: 4px;
		user-select: none;
		white-space: nowrap;
	}
	.gh-file__viewed input {
		accent-color: var(--gh-accent);
		cursor: pointer;
		height: 13px;
		margin: 0;
		width: 13px;
	}

	.gh-file__body {
		background-color: var(--gh-canvas);
		overflow-x: auto;
	}
</style>
