<script lang="ts">
	import type { Snippet } from "svelte";

	let {
		title,
		description,
		ctaLabel,
		ctaHref,
		ctaOnclick,
		icon,
	}: {
		title: string;
		description: string;
		ctaLabel?: string;
		ctaHref?: string;
		ctaOnclick?: () => void;
		icon?: Snippet;
	} = $props();
</script>

<div class="flex flex-col items-center py-12 text-center max-w-sm mx-auto">
	{#if icon}
		<div class="mb-4">
			{@render icon()}
		</div>
	{/if}
	<h3 class="text-lg font-semibold text-[var(--color-text-primary)] mb-2">{title}</h3>
	<p class="text-sm text-[var(--color-text-muted)] mb-6">{description}</p>
	{#if ctaHref}
		<a
			href={ctaHref}
			class="bg-[var(--color-accent)] text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
		>
			{ctaLabel}
		</a>
	{:else if ctaOnclick}
		<button
			onclick={ctaOnclick}
			class="bg-[var(--color-accent)] text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
		>
			{ctaLabel}
		</button>
	{/if}
</div>
