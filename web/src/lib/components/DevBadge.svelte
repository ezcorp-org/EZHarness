<script lang="ts">
	import { onMount } from "svelte";
	import { readDevBadge, type DevBadgeInfo } from "$lib/dev-badge.js";

	// Read once on mount — the server stamps the dataset on `<html>` before
	// hydration, and dev branch/commit don't change without a full reload.
	let info = $state<DevBadgeInfo | null>(null);

	onMount(() => {
		info = readDevBadge(document.documentElement.dataset);
	});
</script>

{#if info}
	<div class="dev-badge" data-testid="dev-badge">{info.branch} · {info.commit}</div>
{/if}

<style>
	/* Solid status-chip styling — the ghosted currentColor mix was near
	   invisible on the light theme. A dark slate chip reads on both themes
	   (border + shadow separate it from dark backgrounds) while staying
	   non-interactive and out of content's way. */
	.dev-badge {
		position: fixed;
		bottom: 0.75rem;
		right: 0.75rem;
		z-index: 40;
		pointer-events: none;
		padding: 0.25rem 0.5rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.75rem;
		line-height: 1.2;
		font-weight: 500;
		color: #f9fafb;
		background: rgb(31 41 55 / 0.92);
		border: 1px solid rgb(107 114 128 / 0.5);
		border-radius: 0.375rem;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
	}
</style>
