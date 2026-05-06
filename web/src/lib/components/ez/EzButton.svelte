<script lang="ts">
	/**
	 * Phase 48 Wave 3 — floating Ez button.
	 *
	 * Mounted once in `(app)/+layout.svelte`. Visible at bottom-right on
	 * every (app) route by default; auto-hidden when the EzPanel is
	 * open so the panel's own close button is the single way back.
	 *
	 * Visibility is derived from the panel-open store — passing the
	 * state in via props would force every parent to thread it through.
	 *
	 * Props let callers override the click handler (panel-open store
	 * is the production hookup; tests assert via a local spy).
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

	function handleClick() {
		if (onopen) onopen();
		else openEzPanel();
	}
</script>

{#if visible}
	<button
		type="button"
		class="ez-button"
		aria-label="Open Ez assistant"
		title="Ask Ez (in-app concierge)"
		data-testid="ez-button"
		onclick={handleClick}
	>
		<span class="ez-button__icon-wrap">
			<img class="ez-button__icon" src="/favicon-192.png" alt="" aria-hidden="true" width="20" height="20" />
			<svg class="ez-button__sparkle" viewBox="0 0 24 24" aria-hidden="true">
				<path d="M12 2 L13.5 9.5 L21 11 L13.5 12.5 L12 20 L10.5 12.5 L3 11 L10.5 9.5 Z" fill="currentColor" />
			</svg>
		</span>
	</button>
{/if}

<style>
	.ez-button {
		position: fixed;
		bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
		right: 1rem;
		z-index: 50;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		padding: 0;
		border-radius: 9999px;
		overflow: visible;
		border: 1px solid var(--color-border);
		background: var(--color-surface-secondary);
		color: var(--color-text-primary);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
		cursor: pointer;
		transition: transform 120ms ease, background-color 120ms ease;
	}
	.ez-button:hover {
		transform: translateY(-1px);
		background: var(--color-surface-tertiary);
	}
	.ez-button:focus-visible {
		outline: 2px solid var(--color-accent, #4c8cff);
		outline-offset: 2px;
	}
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
		top: -1px;
		right: -1px;
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
