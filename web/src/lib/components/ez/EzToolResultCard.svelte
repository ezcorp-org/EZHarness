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
	 * "Open prefilled form" button — clicking it navigates the user to
	 * the prefilled form page. The form's own Submit button is the
	 * accept action; this card is a one-click bridge, not an "Accept"
	 * gate, so we deliberately offer no second confirmation.
	 *
	 * Why pass `goto` in via props instead of importing from
	 * `$app/navigation` directly: keeps the component testable under
	 * vitest+jsdom without setting up a SvelteKit runtime.
	 */
	import { goto as appGoto } from "$app/navigation";

	export interface EzProposeResult {
		draftId?: string;
		openUrl: string;
		title?: string;
		summary?: string;
	}

	let {
		result,
		toolName = "propose_*",
		goto = appGoto,
	}: {
		result: EzProposeResult;
		toolName?: string;
		goto?: (path: string) => Promise<unknown> | unknown;
	} = $props();

	let displayTitle = $derived(result.title ?? defaultTitle(toolName));
	let displaySummary = $derived(result.summary ?? defaultSummary(toolName));

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

	function handleOpen() {
		void goto(result.openUrl);
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
		<button
			type="button"
			class="ez-card__primary"
			data-testid="ez-card-open"
			onclick={handleOpen}
			disabled={!result.openUrl}
		>
			Open prefilled form
		</button>
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
	.ez-card__primary:hover { filter: brightness(1.1); }
	.ez-card__primary:disabled { filter: grayscale(0.5); cursor: not-allowed; }
	.ez-card__primary:focus-visible {
		outline: 2px solid var(--color-text-primary);
		outline-offset: 2px;
	}
</style>
