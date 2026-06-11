<script lang="ts">
	import type { Snippet } from 'svelte';
	import { tick, untrack } from 'svelte';

	let {
		text,
		header,
		position = 'top',
		children,
	}: {
		text: string;
		/** Optional bold first line (e.g. a tool name above its description). */
		header?: string;
		position?: 'top' | 'bottom' | 'left' | 'right';
		children: Snippet;
	} = $props();

	let show = $state(false);
	let resolvedPosition = $state(untrack(() => position));
	let timer: ReturnType<typeof setTimeout> | null = null;
	let el: HTMLSpanElement;
	let tipEl = $state<HTMLDivElement | null>(null);
	// Inline style for the fixed-position tooltip; computed after render
	// so the tooltip can be clamped to the viewport edges. Using fixed
	// positioning also means the tooltip escapes any clipping ancestor
	// (overflow:hidden headers, scroll containers, etc.).
	let tipStyle = $state('');

	const MARGIN = 8; // viewport padding
	const GAP = 8; // gap between trigger and tooltip

	function startDelay() {
		timer = setTimeout(async () => {
			if (!el) return;
			const rect = el.getBoundingClientRect();
			// Axis-flip if the preferred side doesn't have room.
			let p = position;
			if (p === 'top' && rect.top < 40) p = 'bottom';
			else if (p === 'bottom' && window.innerHeight - rect.bottom < 40) p = 'top';
			else if (p === 'left' && rect.left < 40) p = 'right';
			else if (p === 'right' && window.innerWidth - rect.right < 40) p = 'left';
			resolvedPosition = p;
			show = true;
			await tick();
			positionTooltip();
		}, 300);
	}

	function positionTooltip() {
		if (!el || !tipEl) return;
		const trig = el.getBoundingClientRect();
		const tip = tipEl.getBoundingClientRect();
		let left = 0;
		let top = 0;
		if (resolvedPosition === 'top' || resolvedPosition === 'bottom') {
			// Center horizontally on trigger, then clamp to viewport.
			left = trig.left + trig.width / 2 - tip.width / 2;
			left = Math.max(MARGIN, Math.min(left, window.innerWidth - tip.width - MARGIN));
			top = resolvedPosition === 'top' ? trig.top - tip.height - GAP : trig.bottom + GAP;
		} else {
			// Left/right: center vertically on trigger, clamp vertically.
			top = trig.top + trig.height / 2 - tip.height / 2;
			top = Math.max(MARGIN, Math.min(top, window.innerHeight - tip.height - MARGIN));
			left = resolvedPosition === 'left' ? trig.left - tip.width - GAP : trig.right + GAP;
		}
		tipStyle = `left:${Math.round(left)}px; top:${Math.round(top)}px;`;
	}

	function cancelDelay() {
		if (timer) clearTimeout(timer);
		timer = null;
		show = false;
		tipStyle = '';
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') cancelDelay();
	}
</script>

<svelte:window onresize={show ? positionTooltip : undefined} onscroll={show ? positionTooltip : undefined} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
	bind:this={el}
	class="relative inline-flex"
	onmouseenter={startDelay}
	onmouseleave={cancelDelay}
	onfocusin={startDelay}
	onfocusout={cancelDelay}
	onclick={cancelDelay}
	onkeydown={handleKeydown}
>
	{@render children()}
	{#if show}
		<div
			bind:this={tipEl}
			class="fixed z-50 max-w-xs rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-secondary)] shadow-lg pointer-events-none"
			style={tipStyle}
			role="tooltip"
		>
			{#if header}
				<div class="mb-0.5 font-mono font-semibold text-[var(--color-text-primary)]">{header}</div>
			{/if}
			{text}
		</div>
	{/if}
</span>
