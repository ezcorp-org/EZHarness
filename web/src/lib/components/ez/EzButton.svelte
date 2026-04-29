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
		<span class="ez-button__icon" aria-hidden="true">🪄</span>
		<span class="ez-button__label">Ez</span>
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
		gap: 0.4rem;
		padding: 0.55rem 0.95rem;
		border-radius: 9999px;
		border: 1px solid var(--color-border);
		background: var(--color-surface-secondary);
		color: var(--color-text-primary);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
		font-size: 0.875rem;
		font-weight: 600;
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
	.ez-button__icon {
		font-size: 1rem;
		line-height: 1;
	}
	.ez-button__label {
		letter-spacing: 0.02em;
	}
</style>
