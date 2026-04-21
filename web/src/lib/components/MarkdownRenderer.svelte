<script lang="ts">
	import { renderMarkdown } from "$lib/markdown.js";
	import { copyToClipboard } from "$lib/clipboard.js";
	import { highlightDiff } from "$lib/highlight-diff.js";
	import "$lib/hljs-theme.css";

	let { content, streaming = false }: { content: string; streaming?: boolean } = $props();

	let html = $derived(renderMarkdown(content, streaming));
	let body = $state<HTMLElement | undefined>(undefined);

	// Highlight any diff blocks rendered inside markdown (e.g. ```diff fences).
	$effect(() => {
		void html;
		if (body) highlightDiff(body);
	});

	function handleClick(e: MouseEvent) {
		const target = e.target as HTMLElement;

		// Copy button
		const copyBtn = target.closest('.copy-btn') as HTMLElement | null;
		if (copyBtn) {
			const code = copyBtn.getAttribute('data-code') ?? '';
			copyToClipboard(code);
			copyBtn.textContent = 'Copied!';
			setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
			return;
		}

		// Diff view toggle (side-by-side <-> unified)
		const toggleBtn = target.closest('.diff-toggle-btn') as HTMLElement | null;
		if (toggleBtn) {
			const container = toggleBtn.closest('.diff-container') as HTMLElement | null;
			if (!container) return;
			const current = container.getAttribute('data-view');
			const sideView = container.querySelector('.diff-view-side') as HTMLElement | null;
			const unifiedView = container.querySelector('.diff-view-unified') as HTMLElement | null;
			if (current === 'side-by-side') {
				container.setAttribute('data-view', 'unified');
				if (sideView) sideView.style.display = 'none';
				if (unifiedView) unifiedView.style.display = '';
				toggleBtn.textContent = 'Side-by-side';
			} else {
				container.setAttribute('data-view', 'side-by-side');
				if (sideView) sideView.style.display = '';
				if (unifiedView) unifiedView.style.display = 'none';
				toggleBtn.textContent = 'Unified';
			}
			return;
		}

		// Diff file collapse/expand toggle
		const fileToggle = target.closest('.diff-file-toggle') as HTMLElement | null;
		if (fileToggle) {
			const fileSection = fileToggle.closest('.diff-file-section') as HTMLElement | null;
			if (!fileSection) return;
			const expanded = fileSection.getAttribute('data-expanded') === 'true';
			fileSection.setAttribute('data-expanded', expanded ? 'false' : 'true');
			const body = fileSection.querySelector('.diff-file-body') as HTMLElement | null;
			if (body) body.style.display = expanded ? 'none' : '';
		}
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={body} class="markdown-body prose max-w-none text-sm leading-relaxed text-[var(--color-text-primary)]" onclick={handleClick}>
	{@html html}
	{#if streaming}
		<span class="streaming-cursor">|</span>
	{/if}
</div>

<style>
	.streaming-cursor {
		display: inline;
		animation: blink 0.8s step-end infinite;
		font-weight: bold;
		color: var(--color-accent);
	}

	@keyframes blink {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0;
		}
	}

	.markdown-body :global(pre) {
		background: var(--color-surface-tertiary);
		border-radius: 0.5rem;
		padding: 1rem;
		overflow-x: auto;
		margin: 0.75rem 0;
	}

	.markdown-body :global(code) {
		font-size: 0.85em;
		font-family: "Fira Code", "JetBrains Mono", monospace;
	}

	.markdown-body :global(:not(pre) > code) {
		background: var(--color-surface-tertiary);
		padding: 0.15em 0.35em;
		border-radius: 0.25rem;
	}

	.markdown-body :global(p) {
		margin: 0.5em 0;
	}

	.markdown-body :global(ul),
	.markdown-body :global(ol) {
		padding-left: 1.5em;
		margin: 0.5em 0;
	}

	.markdown-body :global(blockquote) {
		border-left: 3px solid var(--color-border);
		padding-left: 1em;
		color: var(--color-text-muted);
		margin: 0.5em 0;
	}

	.markdown-body :global(h1) { font-size: 1.5em; font-weight: 700; margin-top: 1em; margin-bottom: 0.5em; }
	.markdown-body :global(h2) { font-size: 1.25em; font-weight: 600; margin-top: 1em; margin-bottom: 0.5em; }
	.markdown-body :global(h3) { font-size: 1.1em; font-weight: 600; margin-top: 1em; margin-bottom: 0.5em; }
	.markdown-body :global(h4) { font-size: 1em; font-weight: 600; margin-top: 1em; margin-bottom: 0.5em; }
	.markdown-body :global(h5) { font-size: 0.9em; font-weight: 600; margin-top: 1em; margin-bottom: 0.5em; }
	.markdown-body :global(h6) { font-size: 0.85em; font-weight: 600; margin-top: 1em; margin-bottom: 0.5em; }

	/* Code block wrapper */
	.markdown-body :global(.code-block-wrapper) { position: relative; margin: 0.75rem 0; }
	.markdown-body :global(.code-block-header) {
		display: flex; justify-content: space-between; align-items: center;
		padding: 0.25rem 0.75rem;
		background: var(--color-surface-tertiary);
		border-radius: 0.5rem 0.5rem 0 0;
		border-bottom: 1px solid var(--color-border);
	}
	.markdown-body :global(.code-block-wrapper pre) { margin: 0; border-radius: 0 0 0.5rem 0.5rem; }
	.markdown-body :global(.code-lang) { font-size: 0.75em; color: var(--color-text-muted); text-transform: uppercase; }
	.markdown-body :global(.copy-btn) {
		font-size: 0.75em; color: var(--color-text-muted); background: none; border: none;
		cursor: pointer; padding: 0.15em 0.4em; border-radius: 0.25rem;
	}
	.markdown-body :global(.copy-btn:hover) { color: var(--color-text-primary); background: var(--color-border); }

	/* Table styling */
	.markdown-body :global(.table-wrapper) { overflow-x: auto; margin: 0.75rem 0; }
	.markdown-body :global(table) { border-collapse: collapse; width: 100%; font-size: 0.85em; }
	.markdown-body :global(th), .markdown-body :global(td) { border: 1px solid var(--color-border); padding: 0.5rem 0.75rem; text-align: left; }
	.markdown-body :global(th) { font-weight: 600; background: var(--color-surface-tertiary); }
	.markdown-body :global(tr:nth-child(even)) { background: var(--color-surface-tertiary); }

	/* Nested list bullet differentiation */
	.markdown-body :global(ul) { list-style-type: disc; }
	.markdown-body :global(ul ul) { list-style-type: circle; }
	.markdown-body :global(ul ul ul) { list-style-type: square; }

	.markdown-body :global(.citation-marker) {
		color: var(--color-accent);
		font-size: 0.75em;
		font-weight: 600;
		cursor: default;
	}

	/* Highlight.js theme moved to `$lib/hljs-theme.css` (imported above) for reuse. */

	/* Diff container */
	.markdown-body :global(.diff-container) {
		border: 1px solid var(--color-border);
		border-radius: 0.5rem;
		margin: 0.75rem 0;
		overflow-x: auto;
	}

	/* Diff header */
	.markdown-body :global(.diff-header) {
		display: flex;
		justify-content: flex-end;
		padding: 0.25rem 0.75rem;
		background: var(--color-surface-tertiary);
		border-bottom: 1px solid var(--color-border);
	}

	/* Diff toggle button — same style as copy button */
	.markdown-body :global(.diff-toggle-btn) {
		font-size: 0.75em;
		color: var(--color-text-muted);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.15em 0.4em;
		border-radius: 0.25rem;
	}
	.markdown-body :global(.diff-toggle-btn:hover) {
		color: var(--color-text-primary);
		background: var(--color-border);
	}

	/* File section header button */
	.markdown-body :global(.diff-file-toggle) {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		text-align: left;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--color-border);
		cursor: pointer;
		padding: 0.375rem 0.75rem;
		font-size: 0.85em;
		color: var(--color-text-primary);
		font-family: "Fira Code", "JetBrains Mono", monospace;
	}
	.markdown-body :global(.diff-file-toggle:hover) {
		background: var(--color-surface-tertiary);
	}

	/* Addition/deletion stat colors */
	.markdown-body :global(.diff-additions) { color: #22863a; }
	.markdown-body :global(.diff-deletions) { color: #b31d28; }
	:global(.dark) .markdown-body :global(.diff-additions) { color: #7ee787; }
	:global(.dark) .markdown-body :global(.diff-deletions) { color: #ffa198; }

	/* File body */
	.markdown-body :global(.diff-file-body) { overflow-x: auto; }

	/* diff2html overrides */
	.markdown-body :global(.d2h-wrapper) { background: transparent; }
	.markdown-body :global(.d2h-file-header) { display: none; }


	/* Light mode diff colors */
	.markdown-body :global(.d2h-ins) { background-color: rgba(34, 134, 58, 0.1); }
	.markdown-body :global(.d2h-del) { background-color: rgba(179, 29, 40, 0.1); }
	.markdown-body :global(.d2h-ins .d2h-code-side-line),
	.markdown-body :global(.d2h-ins .d2h-code-line) { background-color: rgba(34, 134, 58, 0.15); }
	.markdown-body :global(.d2h-del .d2h-code-side-line),
	.markdown-body :global(.d2h-del .d2h-code-line) { background-color: rgba(179, 29, 40, 0.15); }

	/* Dark mode diff colors */
	:global(.dark) .markdown-body :global(.d2h-ins) { background-color: rgba(126, 231, 135, 0.1); }
	:global(.dark) .markdown-body :global(.d2h-del) { background-color: rgba(255, 161, 152, 0.1); }
	:global(.dark) .markdown-body :global(.d2h-ins .d2h-code-side-line),
	:global(.dark) .markdown-body :global(.d2h-ins .d2h-code-line) { background-color: rgba(126, 231, 135, 0.15); }
	:global(.dark) .markdown-body :global(.d2h-del .d2h-code-side-line),
	:global(.dark) .markdown-body :global(.d2h-del .d2h-code-line) { background-color: rgba(255, 161, 152, 0.15); }

	/* diff2html table/cell resets */
	.markdown-body :global(.d2h-diff-table) { border-collapse: collapse; font-size: 0.85em; }
	.markdown-body :global(.d2h-diff-tbody tr td) { border: none; padding: 0 0.5rem; }
	.markdown-body :global(.d2h-file-diff) { overflow-x: auto; }

	/* Responsive: let overflow-x handle narrow viewports */
	@media (max-width: 600px) {
		.markdown-body :global(.diff-container[data-view="side-by-side"] .diff-view-side) { display: none; }
		.markdown-body :global(.diff-container[data-view="side-by-side"] .diff-view-unified) { display: block !important; }
	}
</style>
