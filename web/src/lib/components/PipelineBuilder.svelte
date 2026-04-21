<script lang="ts">
	import type { Agent } from "$lib/api.js";
	import { inputClass } from "$lib/styles.js";
	import PipelineStepForm from "./PipelineStepForm.svelte";

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

	let name = $state((initial.name as string) ?? "");
	let description = $state((initial.description as string) ?? "");

	type StepData = { name: string; agent: string; input: Record<string, string>; dependsOn: string[] };

	let steps = $state<StepData[]>(
		(initial.steps as StepData[]) ?? [{ name: "step-1", agent: "", input: {}, dependsOn: [] }],
	);

	let allStepNames = $derived(steps.map((s) => s.name));

	let errorMsg = $state("");

	function addStep() {
		steps = [...steps, { name: `step-${steps.length + 1}`, agent: "", input: {}, dependsOn: [] }];
	}

	function removeStep(idx: number) {
		const removedName = steps[idx].name;
		steps = steps.filter((_, i) => i !== idx);
		// Clean up dependsOn references
		for (const step of steps) {
			step.dependsOn = step.dependsOn.filter((d) => d !== removedName);
		}
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		errorMsg = "";

		if (!name.trim()) {
			errorMsg = "Pipeline name is required";
			return;
		}
		if (steps.length === 0) {
			errorMsg = "At least one step is required";
			return;
		}
		for (const step of steps) {
			if (!step.name.trim() || !step.agent) {
				errorMsg = "Each step needs a name and agent";
				return;
			}
		}

		onsubmit({
			name: name.trim(),
			description: description.trim(),
			steps: steps.map((s) => ({
				name: s.name,
				agent: s.agent,
				...(Object.keys(s.input).length > 0 ? { input: s.input } : {}),
				...(s.dependsOn.length > 0 ? { dependsOn: s.dependsOn } : {}),
			})),
		});
	}
</script>

<form onsubmit={handleSubmit} class="space-y-4">
	<div>
		<label for="pl-name" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Pipeline Name</label>
		<input id="pl-name" type="text" bind:value={name} class={inputClass} placeholder="my-pipeline" />
	</div>

	<div>
		<label for="pl-desc" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Description</label>
		<input id="pl-desc" type="text" bind:value={description} class={inputClass} placeholder="What does this pipeline do?" />
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
				<PipelineStepForm {step} {agents} {allStepNames} onremove={() => removeStep(idx)} />
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
		{submitting ? "Saving..." : "Save Pipeline"}
	</button>
</form>
