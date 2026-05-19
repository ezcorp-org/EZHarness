<script lang="ts">
	/**
	 * Phase 48 Wave 4 — banner shown above the new-agent form when the
	 * page was reached via a `?prefill=<draftId>` link from the Ez panel.
	 *
	 * Two visual states:
	 *   - active draft  → "Prefilled by Ez" with a dismiss (×) button
	 *   - expired/used  → "This prefill expired" muted variant
	 *
	 * This is a pure presentational component. The page owns the
	 * dismiss state — clicking the close button raises `ondismiss()`,
	 * the page hides the banner. We deliberately do NOT auto-clear the
	 * `?prefill=` query param here; the page can decide whether
	 * stripping it from the URL makes sense for that route's history
	 * model (Phase 48 v1: leave it alone).
	 */
	let {
		state = "active",
		ondismiss,
	}: {
		/** Whether the prefill draft is still usable. */
		state?: "active" | "expired";
		/** Click handler for the dismiss button. */
		ondismiss?: () => void;
	} = $props();
</script>

<div
	class="ez-prefill-banner ez-prefill-banner--{state}"
	role="status"
	data-testid="agent-prefill-banner"
	data-state={state}
>
	<span class="ez-prefill-banner__icon" aria-hidden="true">🪄</span>
	<span class="ez-prefill-banner__body">
		{#if state === "expired"}
			<strong>This prefill expired</strong> — please ask Ez again or fill the form manually.
		{:else}
			<strong>Prefilled by Ez</strong> — review the draft and submit when ready.
		{/if}
	</span>
	{#if ondismiss}
		<button
			type="button"
			class="ez-prefill-banner__close"
			aria-label="Dismiss prefill banner"
			data-testid="agent-prefill-banner-dismiss"
			onclick={ondismiss}
		>
			×
		</button>
	{/if}
</div>

<style>
	.ez-prefill-banner {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.55rem 0.85rem;
		border-radius: 0.5rem;
		margin-bottom: 1rem;
		font-size: 0.85rem;
		border: 1px solid var(--color-border);
		background: var(--color-surface-secondary);
		color: var(--color-text-primary);
	}
	.ez-prefill-banner--active {
		border-color: var(--color-accent, #4c8cff);
		background: rgba(76, 140, 255, 0.08);
	}
	.ez-prefill-banner--expired {
		opacity: 0.85;
		color: var(--color-text-muted);
	}
	.ez-prefill-banner__icon { font-size: 1rem; }
	.ez-prefill-banner__body { flex: 1; }
	.ez-prefill-banner__close {
		background: transparent;
		border: none;
		color: var(--color-text-muted);
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0.1rem 0.4rem;
		border-radius: 0.3rem;
	}
	.ez-prefill-banner__close:hover {
		color: var(--color-text-primary);
		background: var(--color-surface-tertiary);
	}
</style>
