<script lang="ts">
	/**
	 * Phase 48 Wave 3 — propose_* tool result card.
	 *
	 * The Ez panel renders this when the LLM emits a `propose_*` tool
	 * (create_project / create_agent / install_extension). The tool's
	 * server-side execute persists a draft row and returns:
	 *
	 *     { draftId, openUrl: '/new-project?prefill=<id>' }
	 *
	 * That payload reaches us on `result`. We render a single primary
	 * action — a real `<a href>` (D2: same-origin relative path, safe
	 * Svelte `href` binding, NEVER `{@html}`). SvelteKit's client
	 * router auto-enhances same-origin relative anchors, so a plain
	 * `<a>` gives SPA navigation, Cmd-click / open-in-new-tab, and
	 * screen-reader link semantics for free — no JS `goto` indirection.
	 * The destination page's own Submit (propose flow) or the Library
	 * (install flow) is the real action; this card is a one-click
	 * bridge, not an "Accept" gate, so there is no second confirmation.
	 *
	 * Label is generalized (D1): the install card passes
	 * `openUrlLabel="Open extension"`; every existing propose_* caller
	 * omits it and keeps the original "Open prefilled form" default —
	 * an additive, non-breaking change to the card's contract.
	 */

	import type { EzProposeResult } from "./ez-tool-result.js";
	// Re-export so existing `import { EzProposeResult } from
	// '.../EzToolResultCard.svelte'` call sites keep resolving.
	export type { EzProposeResult } from "./ez-tool-result.js";

	let {
		result,
		toolName = "propose_*",
	}: {
		result: EzProposeResult;
		toolName?: string;
	} = $props();

	let displayTitle = $derived(result.title ?? defaultTitle(toolName));
	let displaySummary = $derived(result.summary ?? defaultSummary(toolName));
	let actionLabel = $derived(result.openUrlLabel ?? defaultActionLabel(toolName));

	function defaultTitle(name: string): string {
		switch (name) {
			case "propose_create_project": return "Open new project form";
			case "propose_create_agent": return "Open new agent form";
			case "propose_install_extension": return "Browse extensions";
			default: return "Open prefilled form";
		}
	}
	function defaultSummary(name: string): string {
		switch (name) {
			case "propose_create_project": return "Ez prepared a project draft. Review and submit on the next page.";
			case "propose_create_agent": return "Ez prepared an agent draft. Review and submit on the next page.";
			case "propose_install_extension": return "Ez surfaced relevant extensions. Pick one to install.";
			default: return "Ez prepared a form for you.";
		}
	}
	// D1: the button label default. Every existing propose_* caller
	// keeps "Open prefilled form"; the install card overrides via
	// `result.openUrlLabel`. Split from title/summary so the label can
	// be generalized without touching the heading copy.
	function defaultActionLabel(_name: string): string {
		return "Open prefilled form";
	}
</script>

<div class="ez-card" data-testid="ez-tool-result-card" data-tool-name={toolName}>
	<div class="ez-card__header">
		<span class="ez-card__icon" aria-hidden="true">🪄</span>
		<div class="ez-card__heading">
			<div class="ez-card__title">{displayTitle}</div>
			<div class="ez-card__summary">{displaySummary}</div>
		</div>
	</div>
	<div class="ez-card__actions">
		{#if result.openUrl}
			<!-- D2: same-origin relative path bound via Svelte's safe
			     `href` (never {@html}/innerHTML). SvelteKit auto-enhances
			     this to client-side nav while keeping real-anchor
			     semantics (Cmd-click, new-tab, screen readers). -->
			<a
				class="ez-card__primary"
				data-testid="ez-card-open"
				href={result.openUrl}
			>
				{actionLabel}
			</a>
		{:else}
			<!-- No URL → render the affordance disabled (matches the
			     prior button's `disabled` state) without an href so it
			     is inert and non-focusable. -->
			<span
				class="ez-card__primary ez-card__primary--disabled"
				data-testid="ez-card-open"
				aria-disabled="true"
			>
				{actionLabel}
			</span>
		{/if}
	</div>
</div>

<style>
	.ez-card {
		border: 1px solid var(--color-border);
		background: var(--color-surface-secondary);
		border-radius: 0.6rem;
		padding: 0.85rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}
	.ez-card__header {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
	}
	.ez-card__icon {
		font-size: 1.1rem;
		line-height: 1.2;
	}
	.ez-card__heading {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.ez-card__title {
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--color-text-primary);
	}
	.ez-card__summary {
		font-size: 0.8rem;
		color: var(--color-text-muted);
	}
	.ez-card__actions {
		display: flex;
		gap: 0.5rem;
	}
	.ez-card__primary {
		flex: 1;
		display: block;
		text-align: center;
		text-decoration: none;
		padding: 0.55rem 0.9rem;
		font-size: 0.875rem;
		font-weight: 600;
		border-radius: 0.4rem;
		border: none;
		background: var(--color-accent, #4c8cff);
		color: white;
		cursor: pointer;
		transition: filter 120ms ease;
	}
	a.ez-card__primary:hover { filter: brightness(1.1); }
	.ez-card__primary--disabled { filter: grayscale(0.5); cursor: not-allowed; }
	.ez-card__primary:focus-visible {
		outline: 2px solid var(--color-text-primary);
		outline-offset: 2px;
	}
</style>
