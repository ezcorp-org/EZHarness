<script lang="ts">
	/**
	 * Mounted inside ProjectRail just above the "+ Add Project" button on
	 * every (app) route. Auto-hides when the EzPanel is open so the panel's
	 * own close button is the single way back.
	 */
	import { ezPanelState, openEzPanel } from "$lib/ez/panel-store.svelte.js";

	let {
		onopen,
		hidden = false,
	}: {
		/** Click handler. Defaults to opening the global Ez panel. */
		onopen?: () => void;
		/** Force-hide the button (tests, or pages that don't want it). */
		hidden?: boolean;
	} = $props();

	let panelOpen = $derived(ezPanelState.open);
	let visible = $derived(!hidden && !panelOpen);
	let hovered = $state(false);

	function handleClick() {
		if (onopen) onopen();
		else openEzPanel();
	}
</script>

{#if visible}
	<button
		type="button"
		class="group relative flex cursor-pointer items-center"
		aria-label="Open Ez assistant"
		title="Ask Ez (in-app concierge)"
		data-testid="ez-button"
		onclick={handleClick}
		onmouseenter={() => (hovered = true)}
		onmouseleave={() => (hovered = false)}
	>
		<div
			class="ml-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)] transition-all duration-200 group-hover:rounded-2xl group-hover:bg-blue-600"
		>
			<span class="ez-button__icon-wrap">
				<img class="ez-button__icon" src="/favicon-192.png" alt="" aria-hidden="true" width="24" height="24" />
				<svg class="ez-button__sparkle" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M12 2 L13.5 9.5 L21 11 L13.5 12.5 L12 20 L10.5 12.5 L3 11 L10.5 9.5 Z" fill="currentColor" />
				</svg>
			</span>
		</div>

		{#if hovered}
			<div class="absolute left-[76px] z-50 whitespace-nowrap rounded-md bg-[var(--color-surface)] px-3 py-2 text-sm font-medium text-[var(--color-text-primary)] shadow-lg ring-1 ring-[var(--color-border)]">
				Ask Ez
			</div>
		{/if}
	</button>
{/if}

<style>
	.ez-button__icon-wrap {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
	}
	.ez-button__icon {
		width: 1.5rem;
		height: 1.5rem;
		display: block;
		object-fit: contain;
	}
	.ez-button__sparkle {
		position: absolute;
		top: -3px;
		right: -3px;
		width: 0.6rem;
		height: 0.6rem;
		color: var(--color-accent, #4c8cff);
		filter: drop-shadow(0 0 3px currentColor);
		animation: ez-button-sparkle 2.4s ease-in-out infinite;
		pointer-events: none;
	}
	@keyframes ez-button-sparkle {
		0%, 100% { transform: scale(1) rotate(0deg); opacity: 0.85; }
		50% { transform: scale(1.25) rotate(20deg); opacity: 1; }
	}
	@media (prefers-reduced-motion: reduce) {
		.ez-button__sparkle { animation: none; }
	}
</style>
