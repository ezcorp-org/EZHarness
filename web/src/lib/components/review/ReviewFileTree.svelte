<script lang="ts">
	/**
	 * GitHub's left-hand file tree for the Files-changed tab.
	 *
	 * Recursive: directories render a chevron row that collapses their subtree,
	 * files render a jump row with the `+N −M` counts on the right and a check
	 * once the file is ticked as viewed. Expansion state and selection live in
	 * the panel so a filter re-render doesn't lose them.
	 */
	import type { FileTreeNode, ReviewFile } from "$lib/diff-review/review-model.js";
	import Self from "./ReviewFileTree.svelte";

	let {
		nodes,
		depth = 0,
		expandedDirs,
		viewed,
		activeKey,
		ontoggledir,
		onselect,
	}: {
		nodes: FileTreeNode[];
		depth?: number;
		expandedDirs: Set<string>;
		viewed: Set<string>;
		activeKey: string | null;
		ontoggledir: (path: string) => void;
		onselect: (file: ReviewFile) => void;
	} = $props();

	// 12px per level, matching GitHub's tree indent.
	function indent(level: number): string {
		return `${8 + level * 12}px`;
	}
</script>

<ul class="gh-tree" role="group">
	{#each nodes as node (node.key)}
		<li>
			{#if node.type === "dir"}
				<button
					type="button"
					class="gh-tree__row gh-tree__row--dir"
					style:padding-left={indent(depth)}
					data-testid="review-tree-dir"
					data-path={node.path}
					aria-expanded={expandedDirs.has(node.path)}
					onclick={() => ontoggledir(node.path)}
				>
					<svg
						class="gh-tree__chevron"
						class:gh-tree__chevron--open={expandedDirs.has(node.path)}
						viewBox="0 0 16 16"
						width="12"
						height="12"
						aria-hidden="true"
					>
						<path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
					</svg>
					<svg class="gh-tree__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
						<path fill="currentColor" d="M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1h6.5A1.75 1.75 0 0 1 16 4.75v8.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.909.513-1.237Z" />
					</svg>
					<span class="gh-tree__name">{node.name}</span>
				</button>
				{#if expandedDirs.has(node.path)}
					<Self
						nodes={node.children}
						depth={depth + 1}
						{expandedDirs}
						{viewed}
						{activeKey}
						{ontoggledir}
						{onselect}
					/>
				{/if}
			{:else}
				<button
					type="button"
					class="gh-tree__row gh-tree__row--file"
					class:gh-tree__row--active={activeKey === node.file.key}
					class:gh-tree__row--viewed={viewed.has(node.file.key)}
					style:padding-left={indent(depth + 1)}
					data-testid="review-tree-file"
					data-path={node.path}
					data-viewed={viewed.has(node.file.key)}
					onclick={() => onselect(node.file)}
				>
					<svg class="gh-tree__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
						<path fill="currentColor" d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm8.75.75v2.5c0 .138.112.25.25.25h2.5Z" />
					</svg>
					<span class="gh-tree__name" title={node.path}>{node.name}</span>
					{#if viewed.has(node.file.key)}
						<svg class="gh-tree__check" viewBox="0 0 16 16" width="12" height="12" aria-label="Viewed">
							<path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
						</svg>
					{:else}
						<span class="gh-tree__stat">
							{#if node.file.additions > 0}<span class="gh-tree__add">+{node.file.additions}</span>{/if}
							{#if node.file.deletions > 0}<span class="gh-tree__del">−{node.file.deletions}</span>{/if}
						</span>
					{/if}
				</button>
			{/if}
		</li>
	{/each}
</ul>

<style>
	.gh-tree {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.gh-tree__row {
		align-items: center;
		background: none;
		border: 0;
		border-radius: 6px;
		cursor: pointer;
		display: flex;
		font-size: 12px;
		gap: 6px;
		line-height: 20px;
		padding-bottom: 3px;
		padding-right: 8px;
		padding-top: 3px;
		text-align: left;
		width: 100%;
	}
	.gh-tree__row:hover {
		background-color: var(--gh-canvas-subtle);
	}
	.gh-tree__row--active {
		background-color: var(--gh-canvas-subtle);
		font-weight: 600;
	}
	.gh-tree__row--viewed .gh-tree__name {
		color: var(--gh-fg-muted);
	}
	.gh-tree__chevron {
		color: var(--gh-fg-muted);
		flex-shrink: 0;
		transition: transform 120ms ease;
	}
	.gh-tree__chevron--open {
		transform: rotate(90deg);
	}
	.gh-tree__icon {
		color: var(--gh-fg-muted);
		flex-shrink: 0;
	}
	.gh-tree__row--dir .gh-tree__icon {
		color: #54aeff;
	}
	.gh-tree__name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.gh-tree__stat {
		display: inline-flex;
		flex-shrink: 0;
		font-size: 11px;
		gap: 4px;
	}
	.gh-tree__add {
		color: var(--gh-success-fg);
	}
	.gh-tree__del {
		color: var(--gh-danger-fg);
	}
	.gh-tree__check {
		color: var(--gh-success-fg);
		flex-shrink: 0;
	}
</style>
