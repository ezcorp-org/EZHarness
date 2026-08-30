<!--
  WorkflowRunCard — renders `run_workflow`'s result (`cardType:
  "workflow-run"`) verbatim: the workflow name + terminal status, the
  per-step list (with loop iteration counts when a step carries one), the
  RESULT object pretty-printed in full, and — for a run that did not
  succeed — the error.

  WHY this card exists: `run_workflow`'s result is deterministic for
  identical input, but the model's PROSE about it is not — the same JSON
  can read as a fenced code block one turn and a bullet-list summary the
  next (`workflow-run-card-logic.ts` has the full story). `cardType:
  "default"` routed this through DefaultCard, whose preview line is a
  50-char truncated JSON blob that starts collapsed — a canonical value
  shown through a component with no determinism contract of its own. This
  card is the one surface the user can trust to look the same twice, so it
  never paraphrases: every string below is either the raw shape (a status
  word, a step name) or `JSON.stringify(result, null, 2)` unmodified.

  TEMPLATE ONLY, same rule as CityConditionsCard: every parse and format
  lives in `workflow-run-card-logic.ts`; the markup here branches solely on
  precomputed booleans (`succeeded`, `hasIterations`, `hasError`,
  `hasRunId`) and iterates a precomputed `steps` array.
-->

<script lang="ts">
	import type { WorkflowRunView } from "./workflow-run-card-logic";

	let { view }: { view: WorkflowRunView } = $props();
</script>

<article
	class="card"
	class:failed={!view.succeeded}
	aria-label={`Workflow run: ${view.workflowName}`}
	data-testid="workflow-run-card"
>
	<header class="head">
		<div class="title">
			<h3 class="name" data-testid="workflow-run-name">{view.workflowName}</h3>
			{#if view.hasRunId}
				<span class="run-id" data-testid="workflow-run-id">{view.runId}</span>
			{/if}
		</div>
		<span
			class="status status-{view.status}"
			data-testid="workflow-run-status"
			data-status={view.status}>{view.status}</span
		>
	</header>

	{#if view.steps.length > 0}
		<ol class="steps" data-testid="workflow-run-steps">
			{#each view.steps as step, i (i)}
				<li class="step" data-testid="workflow-run-step" data-step-status={step.status}>
					<span class="step-name">{step.name}</span>
					<span
						class="step-status step-status-{step.status}"
						data-testid="workflow-run-step-status">{step.status}</span
					>
					{#if step.hasIterations}
						<span class="step-iterations" data-testid="workflow-run-step-iterations"
							>({step.iterations} iterations)</span
						>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}

	<details class="panel" data-testid="workflow-run-result" open={view.succeeded}>
		<summary class="panel-title">Result</summary>
		<pre class="result-body" data-testid="workflow-run-result-body">{view.resultText}</pre>
	</details>

	{#if view.hasError}
		<div class="panel error-panel" data-testid="workflow-run-error">
			<p class="panel-title">Error</p>
			<p class="error-message" data-testid="workflow-run-error-message">{view.errorText}</p>
		</div>
	{/if}
</article>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.875rem 1rem 1rem;
		background: var(--color-surface, #ffffff);
		border: 1px solid var(--color-border, #d4dae8);
		border-radius: 8px;
		color: var(--color-text-primary, #11141f);
		font-family: system-ui, -apple-system, sans-serif;
		/* Sized off the CARD, not the viewport — it sits in a chat column
		   whose width varies with the sidebar. */
		container-type: inline-size;
	}
	.card.failed {
		border-color: color-mix(
			in srgb,
			var(--color-red-600, #df3b39) 40%,
			var(--color-border, #d4dae8)
		);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.25rem 0.75rem;
	}
	.title {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}
	.name {
		margin: 0;
		min-width: 0;
		font-size: 1rem;
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.run-id {
		min-width: 0;
		font-size: 0.6875rem;
		font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
		color: var(--color-text-muted, #565d72);
		overflow-wrap: anywhere;
	}

	/* ── Status badges (run + step) ──
	   Same vocabulary as web/src/lib/workflow-run-display.ts's STATUS_COLOR
	   (success/error/cancelled/awaiting_approval/suspended/skipped) — an
	   unrecognised status simply falls through to the neutral default. */
	.status,
	.step-status {
		flex: 0 0 auto;
		padding: 0.0625rem 0.5rem;
		border-radius: 9999px;
		font-size: 0.6875rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		text-transform: uppercase;
		background: #374151;
		color: #e5e7eb;
	}
	.status-success {
		background: #065f46;
		color: #d1fae5;
	}
	.status-error {
		background: #7f1d1d;
		color: #fee2e2;
	}
	.status-cancelled,
	.status-skipped {
		background: #374151;
		color: #d1d5db;
	}
	.status-awaiting_approval,
	.status-suspended {
		background: #78350f;
		color: #fef3c7;
	}

	.steps {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.step {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
		padding: 0.375rem 0.625rem;
		border-radius: 6px;
		background: var(--color-surface-tertiary, #e0e5ef);
	}
	.step-name {
		min-width: 0;
		font-size: 0.8125rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.step-iterations {
		font-size: 0.75rem;
		color: var(--color-text-muted, #565d72);
	}

	.panel {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border, #d4dae8);
	}
	.panel-title {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--color-text-muted, #565d72);
		cursor: pointer;
	}
	/* The result is the CANONICAL value this card exists to protect — full
	   width, wrapped, never clipped by a max-height like DefaultCard's
	   truncated preview. */
	.result-body {
		margin: 0;
		min-width: 0;
		padding: 0.625rem 0.75rem;
		background: var(--color-surface-secondary, #eef1f7);
		border-radius: 6px;
		font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
		font-size: 0.8125rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.error-panel {
		border-top-color: color-mix(
			in srgb,
			var(--color-red-600, #df3b39) 40%,
			var(--color-border, #d4dae8)
		);
	}
	.error-panel .panel-title {
		color: var(--color-red-600, #df3b39);
	}
	.error-message {
		margin: 0;
		min-width: 0;
		font-size: 0.8125rem;
		line-height: 1.45;
		color: var(--color-text-secondary, #434b5e);
		overflow-wrap: anywhere;
	}
</style>
