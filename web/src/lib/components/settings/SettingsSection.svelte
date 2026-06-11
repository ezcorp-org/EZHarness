<script lang="ts">
	import type { Snippet } from "svelte";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";

	let {
		id = undefined,
		title,
		description = undefined,
		tooltip = undefined,
		collapsible = false,
		open = $bindable(true),
		testid = undefined,
		actions = undefined,
		headerExtra = undefined,
		children,
	}: {
		id?: string;
		title: string;
		description?: string;
		tooltip?: string;
		/** Chevron-button accordion variant (locked decision 11). */
		collapsible?: boolean;
		open?: boolean;
		testid?: string;
		/** Header-right actions (buttons / links) for non-collapsible sections. */
		actions?: Snippet;
		/** Extra header content rendered left of the chevron (collapsible only). */
		headerExtra?: Snippet;
		children?: Snippet;
	} = $props();
</script>

<section
	{id}
	data-testid={testid}
	class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] {collapsible ? '' : 'p-6'}"
>
	{#if collapsible}
		<button
			type="button"
			onclick={() => (open = !open)}
			aria-expanded={open}
			class="flex w-full items-center justify-between p-6 text-left"
		>
			<h2 class="flex items-center gap-2 text-lg font-semibold text-[var(--color-text-primary)]">
				{title}
				{#if tooltip}<InfoTooltip text={tooltip} />{/if}
			</h2>
			<div class="flex items-center gap-2">
				{#if headerExtra}{@render headerExtra()}{/if}
				<svg
					class="h-5 w-5 text-[var(--color-text-secondary)] transition-transform duration-200 {open ? 'rotate-180' : ''}"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
				</svg>
			</div>
		</button>
		{#if description && !open}
			<p class="-mt-4 px-6 pb-4 text-xs text-[var(--color-text-secondary)]">{description}</p>
		{/if}
		{#if open}
			<div class="border-t border-[var(--color-border)] p-6 pt-4">
				{#if description}
					<p class="mb-4 text-xs text-[var(--color-text-secondary)]">{description}</p>
				{/if}
				{@render children?.()}
			</div>
		{/if}
	{:else}
		<div class="mb-1 flex items-center justify-between">
			<h2 class="flex items-center gap-2 text-lg font-semibold text-[var(--color-text-primary)]">
				{title}
				{#if tooltip}<InfoTooltip text={tooltip} />{/if}
			</h2>
			{#if actions}{@render actions()}{/if}
		</div>
		{#if description}
			<p class="mb-4 text-xs text-[var(--color-text-secondary)]">{description}</p>
		{/if}
		{@render children?.()}
	{/if}
</section>
