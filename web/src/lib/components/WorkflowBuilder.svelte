<script lang="ts">
	import { untrack } from "svelte";
	import type { Agent } from "$lib/api.js";
	import { inputClass } from "$lib/styles.js";
	import WorkflowStepForm from "./WorkflowStepForm.svelte";
	import {
		blankStep,
		buildWorkflowPayload,
		pruneDependsOn,
		remapDependsOn,
		type StepDraft,
	} from "$lib/workflow-builder-logic.js";

	let {
		initial = {},
		agents = [],
		onsubmit,
		submitting = false,
	}: {
		initial?: Record<string, unknown>;
		agents: Agent[];
		onsubmit: (data: Record<string, unknown>) => void;
		submitting?: boolean;
	} = $props();

	let name = $state(untrack(() => (initial.name as string) ?? ""));
	let description = $state(untrack(() => (initial.description as string) ?? ""));

	let steps = $state<StepDraft[]>(
		untrack(() => (initial.steps as StepDraft[]) ?? [blankStep(0)]),
	);

	let allStepNames = $derived(steps.map((s) => s.name));

	let errorMsg = $state("");

	function addStep() {
		steps = [...steps, blankStep(steps.length)];
	}

	function removeStep(idx: number) {
		const removedName = steps[idx].name;
		steps = steps.filter((_, i) => i !== idx);
		pruneDependsOn(steps, removedName);
	}

	// Renaming a step must retarget the siblings' dependsOn entries the same
	// way removing one prunes them — otherwise the rename orphans them.
	function renameStep(oldName: string, newName: string) {
		remapDependsOn(steps, oldName, newName);
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		errorMsg = "";
		const result = buildWorkflowPayload(name, description, steps);
		if (result.error) {
			errorMsg = result.error;
			return;
		}
		onsubmit(result.payload);
	}
</script>

<form onsubmit={handleSubmit} class="space-y-4">
	<div>
		<label for="wf-name" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Workflow Name</label>
		<input id="wf-name" type="text" bind:value={name} class={inputClass} placeholder="my-workflow" />
	</div>

	<div>
		<label for="wf-desc" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Description</label>
		<input id="wf-desc" type="text" bind:value={description} class={inputClass} placeholder="What does this workflow do?" />
	</div>

	<div>
		<div class="mb-2 flex items-center justify-between">
			<h3 class="text-sm font-medium text-[var(--color-text-secondary)]">Steps</h3>
			<button type="button" onclick={addStep} class="rounded bg-[var(--color-surface-tertiary)] px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]" style="min-height: 44px;">
				+ Add Step
			</button>
		</div>
		<div class="space-y-3">
			{#each steps as step, idx}
				<WorkflowStepForm {step} {agents} {allStepNames} onremove={() => removeStep(idx)} onnamechange={renameStep} />
			{/each}
		</div>
	</div>

	{#if errorMsg}
		<p class="text-sm text-red-400">{errorMsg}</p>
	{/if}

	<button
		type="submit"
		disabled={submitting}
		class="rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50" style="min-height: 44px;"
	>
		{submitting ? "Saving..." : "Save Workflow"}
	</button>
</form>
