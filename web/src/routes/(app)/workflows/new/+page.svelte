<script lang="ts">
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { createWorkflow, type Workflow } from "$lib/api.js";
	import { store, refreshWorkflows } from "$lib/stores.svelte.js";
	import WorkflowBuilder from "$lib/components/WorkflowBuilder.svelte";
	import { duplicateName } from "$lib/workflow-builder-logic.js";

	let submitting = $state(false);
	let errorMsg = $state("");

	// `?from=<name>` prefills from an existing workflow (the Duplicate action
	// on the detail page). It reads the already-loaded store rather than
	// refetching, and works for YAML/extension workflows too — copying one
	// into an editable DB workflow is the only productive thing you can do
	// with a read-only demo.
	let sourceName = $derived(page.url.searchParams.get("from"));
	let source = $derived(
		sourceName ? store.workflows.find((w) => w.name === sourceName) : undefined,
	);
	// `source` carries server-derived `source`/`canEdit`; neither is a
	// builder field and `workflowBodySchema` is `.strict()`, so only the three
	// authored fields are forwarded — sending the rest would 400 on create.
	let initial = $derived(
		source
			? {
					name: duplicateName(source.name),
					description: source.description,
					steps: source.steps,
				}
			: {},
	);

	async function handleSubmit(data: Record<string, unknown>) {
		submitting = true;
		errorMsg = "";
		try {
			await createWorkflow(data as unknown as Workflow);
			refreshWorkflows();
			goto("/workflows");
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to create workflow";
		} finally {
			submitting = false;
		}
	}
</script>

<div class="space-y-6">
	<div>
		<a href="/workflows" class="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]">&larr; Back</a>
	</div>

	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		<h2 class="mb-4 text-2xl font-bold text-[var(--color-text-primary)]">
			{source ? `Duplicate ${source.name}` : "New Workflow"}
		</h2>
		{#if sourceName && !source}
			<p class="mb-4 text-sm text-[var(--color-text-muted)]" data-testid="duplicate-source-missing">
				Could not find "{sourceName}" to copy — starting from an empty workflow.
			</p>
		{/if}
		<!-- Keyed on `initial`: the builder snapshots its props with `untrack`
		     (a form must not be yanked out from under a typing user), so the
		     prefill would be missed if the store list arrives after mount. -->
		{#key initial}
			<WorkflowBuilder {initial} agents={store.agents} onsubmit={handleSubmit} {submitting} />
		{/key}
		{#if errorMsg}
			<p class="mt-3 text-sm text-red-400">{errorMsg}</p>
		{/if}
	</div>
</div>
