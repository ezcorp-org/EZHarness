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
	.dev-badge {
		position: fixed;
		bottom: 0.5rem;
		right: 0.5rem;
		z-index: 40;
		pointer-events: none;
		opacity: 0.7;
		padding: 0.125rem 0.375rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.6875rem;
		line-height: 1.2;
		color: color-mix(in srgb, currentColor 75%, transparent);
		background: color-mix(in srgb, currentColor 8%, transparent);
		border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
		border-radius: 0.3125rem;
	}
</style>
