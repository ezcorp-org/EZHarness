<script lang="ts">
	/**
	 * GitHub's five-square diffstat bar — green squares for additions, red for
	 * deletions, grey for the remainder. Purely decorative, so the whole thing
	 * carries a single title + `aria-hidden`; the `+N −M` counts next to it are
	 * the accessible copy.
	 */
	import { diffStatBlocks } from "$lib/diff-review/review-model.js";

	let { additions, deletions }: { additions: number; deletions: number } = $props();

	let blocks = $derived(diffStatBlocks(additions, deletions));
</script>

<span
	class="gh-statbar"
	data-testid="diff-stat-bar"
	aria-hidden="true"
	title="{additions} additions & {deletions} deletions"
>
	{#each blocks as block, i (i)}
		<span class="gh-statbar__block gh-statbar__block--{block}" data-block={block}></span>
	{/each}
</span>

<style>
	.gh-statbar {
		display: inline-flex;
		gap: 1px;
	}
	.gh-statbar__block {
		display: block;
		height: 8px;
		width: 8px;
		outline: 1px solid rgba(0, 0, 0, 0.06);
		outline-offset: -1px;
	}
	.gh-statbar__block--added {
		background-color: #2da44e;
	}
	.gh-statbar__block--deleted {
		background-color: #cf222e;
	}
	.gh-statbar__block--neutral {
		background-color: var(--gh-neutral-block, #d1d9e0);
	}

	:global(.dark) .gh-statbar__block--added {
		background-color: #3fb950;
	}
	:global(.dark) .gh-statbar__block--deleted {
		background-color: #f85149;
	}
</style>
