<script lang="ts">
	import { goto } from "$app/navigation";
	import { createWorkflow, type Workflow } from "$lib/api.js";
	import { store, refreshWorkflows } from "$lib/stores.svelte.js";
	import WorkflowBuilder from "$lib/components/WorkflowBuilder.svelte";

	let submitting = $state(false);
	let errorMsg = $state("");

	// This route creates a workflow FROM SCRATCH, and only that.
	//
	// It used to also answer `?from=<name>`, prefilling itself from an
	// existing workflow — the client-side half of the platform's two copy
	// affordances. The product owner ruled ONE copy verb; the survivor is
	// the server-side one on the detail page, which carries `forked_from`
	// provenance and the global name-collision rule that a prefilled create
	// form structurally could not. Nothing navigates here with `?from=`
	// any more, so the branch is gone rather than left as an unreachable
	// second definition of what a copy is.

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
		<h2 class="mb-4 text-2xl font-bold text-[var(--color-text-primary)]">New Workflow</h2>
		<WorkflowBuilder initial={{}} agents={store.agents} onsubmit={handleSubmit} {submitting} />
		{#if errorMsg}
			<p class="mt-3 text-sm text-red-400">{errorMsg}</p>
		{/if}
	</div>
</div>
