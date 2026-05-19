<script lang="ts">
	import { helpContent } from "$lib/data/help-content";

	let { text, key }: { text?: string; key?: string } = $props();

	const displayText = $derived(text ?? (key ? helpContent[key] : ""));

	let show = $state(false);
	let placedBelow = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let el = $state<HTMLSpanElement | undefined>();

	function startDelay() {
		timer = setTimeout(() => {
			if (el) {
				const rect = el.getBoundingClientRect();
				// Tooltip is ~80px tall; flip below if not enough space above
				placedBelow = rect.top < 90;
			}
			show = true;
		}, 300);
	}

	function cancelDelay() {
		if (timer) clearTimeout(timer);
		timer = null;
		show = false;
	}
</script>

{#if displayText}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
	bind:this={el}
	class="relative inline-flex"
	onmouseenter={startDelay}
	onmouseleave={cancelDelay}
>
	<button
		type="button"
		class="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--color-border)] text-[10px] font-medium text-[var(--color-text-secondary)] hover:border-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
		aria-label="More info"
		onfocus={startDelay}
		onblur={cancelDelay}
	>
		?
	</button>
	{#if show}
		<div
			class="absolute {placedBelow ? 'top-full mt-2' : 'bottom-full mb-2'} left-1/2 z-50 w-64 -translate-x-1/2 whitespace-pre-line rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-2 text-xs leading-relaxed text-[var(--color-text-secondary)] shadow-lg"
			role="tooltip"
		>
			{displayText}
			{#if placedBelow}
				<div class="absolute left-1/2 bottom-full -translate-x-1/2 border-4 border-transparent border-b-[var(--color-border)]"></div>
			{:else}
				<div class="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-[var(--color-border)]"></div>
			{/if}
		</div>
	{/if}
</span>
{/if}
