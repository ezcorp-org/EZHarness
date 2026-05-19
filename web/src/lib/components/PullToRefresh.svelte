<script lang="ts">
	let { target }: { target?: HTMLElement | null } = $props();

	let pulling = $state(false);
	let pullDistance = $state(0);
	let refreshing = $state(false);
	let startY = 0;

	const THRESHOLD = 80;

	function onTouchStart(e: TouchEvent) {
		// Only activate when scrolled to top
		const scrollEl = target ?? document.scrollingElement ?? document.documentElement;
		if (scrollEl.scrollTop > 0) return;
		startY = e.touches[0]!.clientY;
		pulling = true;
		pullDistance = 0;
	}

	function onTouchMove(e: TouchEvent) {
		if (!pulling) return;
		const dy = e.touches[0]!.clientY - startY;
		if (dy < 0) {
			pulling = false;
			pullDistance = 0;
			return;
		}
		// Dampen the pull distance
		pullDistance = Math.min(dy * 0.4, THRESHOLD * 1.5);
	}

	function onTouchEnd() {
		if (!pulling) return;
		pulling = false;
		if (pullDistance >= THRESHOLD) {
			refreshing = true;
			pullDistance = THRESHOLD * 0.6;
			location.reload();
		} else {
			pullDistance = 0;
		}
	}
</script>

<svelte:document
	ontouchstart={onTouchStart}
	ontouchmove={onTouchMove}
	ontouchend={onTouchEnd}
/>

{#if pullDistance > 0}
	<div
		class="md:hidden fixed top-0 left-0 right-0 z-50 flex items-center justify-center transition-transform pointer-events-none"
		style="transform: translateY({pullDistance - 40}px); height: 40px;"
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
					style="transform: rotate({Math.min(pullDistance / THRESHOLD, 1) * 180}deg);"
					fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"
				>
					<path stroke-linecap="round" stroke-linejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
				</svg>
			{/if}
		</div>
	</div>
{/if}
