<script lang="ts">
	// Thin shell: the gesture's decision logic lives in
	// `./pull-to-refresh-logic` (unit-tested against the shipped code). This
	// file only wires touch events and `location.reload()` to it.
	import {
		IDLE,
		PULL_THRESHOLD_PX,
		beginPull,
		cancelPull,
		endPull,
		isPullEnabled,
		movePull,
		nearestScrollTop,
		type PullState,
	} from "./pull-to-refresh-logic";

	let { target }: { target?: HTMLElement | null } = $props();

	let pull = $state<PullState>(IDLE);
	let refreshing = $state(false);

	/**
	 * Scroll offset of the container the finger is actually over. Reading the
	 * document scroller instead is what armed this gesture app-wide: the shell
	 * is a `100dvh` layout, so the document never scrolls and its `scrollTop`
	 * stays 0 no matter how far down the chat list the user is.
	 */
	function scrollTopUnder(node: EventTarget | null): number {
		if (target) return target.scrollTop;
		return nearestScrollTop(
			node instanceof Element ? node : null,
			(n) => getComputedStyle(n as Element).overflowY,
			document.scrollingElement ?? document.documentElement,
		);
	}

	function onTouchStart(e: TouchEvent) {
		const touch = e.touches[0];
		if (!touch) return;
		pull = beginPull({
			x: touch.clientX,
			y: touch.clientY,
			atTop: scrollTopUnder(e.target) <= 0,
			enabled: isPullEnabled(window.innerWidth),
		});
	}

	function onTouchMove(e: TouchEvent) {
		const touch = e.touches[0];
		if (!touch) return;
		pull = movePull(pull, touch.clientX, touch.clientY);
	}

	function onTouchEnd() {
		const resolved = endPull(pull);
		pull = resolved.state;
		if (resolved.refresh) {
			refreshing = true;
			location.reload();
		}
	}

	function onTouchCancel() {
		pull = cancelPull();
	}
</script>

<svelte:document
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
	ontouchcancel={onTouchCancel}
/>

{#if pull.distance > 0}
	<div
		class="md:hidden fixed top-0 left-0 right-0 z-50 flex items-center justify-center transition-transform pointer-events-none"
		style="transform: translateY({pull.distance - 40}px); height: 40px;"
	>
		<div
			class="flex items-center justify-center h-8 w-8 rounded-full bg-[var(--color-surface-tertiary)] border border-[var(--color-border)] shadow-md"
		>
			{#if refreshing}
				<svg class="h-4 w-4 text-[var(--color-text-muted)] animate-spin" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
				</svg>
			{:else}
				<svg
					class="h-4 w-4 text-[var(--color-text-muted)] transition-transform"
					style="transform: rotate({Math.min(pull.distance / PULL_THRESHOLD_PX, 1) * 180}deg);"
					fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"
				>
					<path stroke-linecap="round" stroke-linejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
				</svg>
			{/if}
		</div>
	</div>
{/if}
