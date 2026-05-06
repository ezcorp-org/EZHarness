<script lang="ts">
	/**
	 * Recursive renderer for the `$feature` chip's hover popover file
	 * list. Tree is pre-built by `$lib/feature-file-tree.ts`; this
	 * component owns only display + per-instance collapse state.
	 *
	 * Visual style mirrors the unix `tree` CLI / VS Code outline view:
	 * box-drawing connectors (`├─` / `└─`) + a chevron on directories
	 * to signal the toggle affordance. `whitespace-pre` + monospace
	 * keeps the columns aligned regardless of file/folder name length.
	 *
	 * Why we track *collapsed* dirs instead of expanded ones: the
	 * default UX is "everything visible the moment the popover opens."
	 * That default needs to apply even when `nodes` arrives
	 * asynchronously, and Svelte 5 warns when `$state` initialisers
	 * read prop values (they're captured once at mount). Tracking the
	 * inverse keeps the default ("nothing in the set ⇒ everything
	 * open") prop-free.
	 */
	import type { FileTreeNode } from "$lib/feature-file-tree";
	import Self from "./FeatureFileTree.svelte";

	let {
		nodes,
		ancestorIsLast = [],
	}: {
		nodes: FileTreeNode[];
		/**
		 * For each ancestor depth, was that ancestor the last child of
		 * its parent? Drives whether each indent column draws a
		 * vertical guide (`│`) or blank space — the standard `tree`
		 * algorithm.
		 */
		ancestorIsLast?: boolean[];
	} = $props();

	let collapsedDirs = $state(new Set<string>());

	function isOpen(path: string): boolean {
		return !collapsedDirs.has(path);
	}

	function toggle(path: string) {
		const next = new Set(collapsedDirs);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		collapsedDirs = next;
	}

	/**
	 * Build the indent prefix (`│  ` per ancestor that still has
	 * siblings below, `   ` per ancestor that was its parent's last
	 * child). The classic unix `tree` rule.
	 */
	function indentPrefix(ancestors: boolean[]): string {
		return ancestors.map((wasLast) => (wasLast ? "   " : "│  ")).join("");
	}

	function connector(isLast: boolean): string {
		return isLast ? "└─ " : "├─ ";
	}
</script>

{#each nodes as node, i (node.path)}
	{@const isLast = i === nodes.length - 1}
	{#if node.type === "dir"}
		{@const open = isOpen(node.path)}
		<button
			type="button"
			class="block w-full m-0 p-0 border-0 bg-transparent whitespace-pre text-left font-mono leading-none hover:bg-[var(--color-surface-secondary)]/50"
			onclick={(e) => { e.stopPropagation(); toggle(node.path); }}
			data-feature-tree-dir={node.path}
			aria-expanded={open}
		>
			<span class="text-[var(--color-text-muted)]"
				>{indentPrefix(ancestorIsLast)}{connector(isLast)}</span
			>
			<span class="text-[var(--color-text-muted)]">{open ? "▾" : "▸"} </span
			><span class="text-[var(--color-text-primary)]">{node.name}/</span>
		</button>
		{#if open}
			<Self
				nodes={node.children}
				ancestorIsLast={[...ancestorIsLast, isLast]}
			/>
		{/if}
	{:else}
		<div
			class="block whitespace-pre font-mono leading-none"
			data-feature-tree-file={node.path}
		>
			<span class="text-[var(--color-text-muted)]"
				>{indentPrefix(ancestorIsLast)}{connector(isLast)}</span
			><span class="text-[var(--color-text-secondary)]">{node.name}</span>
		</div>
	{/if}
{/each}
