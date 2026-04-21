<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		text,
		position = 'top',
		children,
	}: {
		text: string;
		position?: 'top' | 'bottom' | 'left' | 'right';
		children: Snippet;
	} = $props();

	let show = $state(false);
	let resolvedPosition = $state(position);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let el: HTMLSpanElement;

	const TOOLTIP_MARGIN = 40; // approximate tooltip height/width + padding

	const flipMap: Record<string, string> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

	function startDelay() {
		timer = setTimeout(() => {
			resolvedPosition = position;
			if (el) {
				const rect = el.getBoundingClientRect();
				if (position === 'top' && rect.top < TOOLTIP_MARGIN) resolvedPosition = 'bottom';
				else if (position === 'bottom' && window.innerHeight - rect.bottom < TOOLTIP_MARGIN) resolvedPosition = 'top';
				else if (position === 'left' && rect.left < TOOLTIP_MARGIN) resolvedPosition = 'right';
				else if (position === 'right' && window.innerWidth - rect.right < TOOLTIP_MARGIN) resolvedPosition = 'left';
			}
			show = true;
		}, 300);
	}

	function cancelDelay() {
		if (timer) clearTimeout(timer);
		timer = null;
		show = false;
	}

	const positionClasses: Record<string, string> = {
		top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
		bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
		left: 'right-full top-1/2 -translate-y-1/2 mr-2',
		right: 'left-full top-1/2 -translate-y-1/2 ml-2',
	};

	const arrowClasses: Record<string, string> = {
		top: 'left-1/2 top-full -translate-x-1/2 border-t-[var(--color-border)] border-x-transparent border-b-transparent',
		bottom: 'left-1/2 bottom-full -translate-x-1/2 border-b-[var(--color-border)] border-x-transparent border-t-transparent',
		left: 'left-full top-1/2 -translate-y-1/2 border-l-[var(--color-border)] border-y-transparent border-r-transparent',
		right: 'right-full top-1/2 -translate-y-1/2 border-r-[var(--color-border)] border-y-transparent border-l-transparent',
	};
</script>

<span
	bind:this={el}
	class="relative inline-flex"
	onmouseenter={startDelay}
	onmouseleave={cancelDelay}
	onfocusin={startDelay}
	onfocusout={cancelDelay}
>
	{@render children()}
	{#if show}
		<div
			class="absolute {positionClasses[resolvedPosition]} z-50 whitespace-nowrap rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-secondary)] shadow-lg pointer-events-none"
			role="tooltip"
		>
			{text}
			<div class="absolute border-4 {arrowClasses[resolvedPosition]}"></div>
		</div>
	{/if}
</span>
