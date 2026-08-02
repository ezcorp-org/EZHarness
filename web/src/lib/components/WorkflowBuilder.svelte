<script lang="ts">
	import { untrack, onMount } from "svelte";
	import type { Agent } from "$lib/api.js";
	import { inputClass } from "$lib/styles.js";
	import WorkflowStepForm from "./WorkflowStepForm.svelte";
	import {
		blankStep,
		buildWorkflowPayload,
		defaultModelToText,
		pruneDependsOn,
		remapDependsOn,
		workflowToDrafts,
		type StepDraft,
		type StoredStep,
	} from "$lib/workflow-builder-logic.js";
	import {
		groupToolOptions,
		parseExtensionList,
		toToolOptions,
		type ToolOption,
	} from "$lib/extension-tool-options.js";

	let {
		initial = {},
		agents = [],
		onsubmit,
		oncancel,
		submitting = false,
		submitLabel = "Save Workflow",
	}: {
		initial?: Record<string, unknown>;
		agents: Agent[];
		onsubmit: (data: Record<string, unknown>) => void;
		/** When supplied, renders a Cancel button beside Save. Absent on the
		 *  create route, where there is nothing to return to. */
		oncancel?: () => void;
		submitting?: boolean;
		submitLabel?: string;
	} = $props();

	let name = $state(untrack(() => (initial.name as string) ?? ""));
	let description = $state(untrack(() => (initial.description as string) ?? ""));

	// `initial` carries STORED steps (an `input` record, a `condition` object,
	// a `loop` object, a per-step `model` binding) — not drafts.
	// `workflowToDrafts` is the inverse of the `stepToPayload` used on submit;
	// casting straight to `StepDraft[]` here (as this did before editing
	// existed) yields a form bound to fields that do not exist, which renders
	// blank and saves an erased definition. It also supplies the one blank
	// row an empty step list opens on.
	let steps = $state<StepDraft[]>(
		untrack(() => workflowToDrafts(initial.steps as StoredStep[] | undefined)),
	);
	let defaultModelText = $state(untrack(() => defaultModelToText(initial.defaultModel)));

	// Fetched once for the whole form rather than per step: a 6-step workflow
	// would otherwise issue 6 identical requests.
	let toolOptions = $state<ToolOption[]>([]);
	let toolGroups = $derived(groupToolOptions(toolOptions));

	onMount(async () => {
		try {
			const res = await fetch("/api/extensions");
			if (res.ok) toolOptions = toToolOptions(parseExtensionList(await res.json()));
		} catch {
			// Non-fatal: the tool picker degrades to empty and every other
			// step kind stays usable.
		}
	});

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
		const result = buildWorkflowPayload(name, description, steps, defaultModelText);
		// `!== null` (not truthiness): `error` is typed `string | null` and a
		// bare `if (result.error)` can't discriminate the union for TS (an
		// empty-string error would also be falsy). Every producer returns a
		// non-empty message, so behavior is identical.
		if (result.error !== null) {
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
		<label for="wf-default-model" class="mb-1 block text-sm font-medium text-[var(--color-text-secondary)]">Default model (JSON, optional)</label>
		<textarea
			id="wf-default-model"
			bind:value={defaultModelText}
			rows="2"
			placeholder={'{ "provider": "anthropic", "model": "claude-sonnet-5" }'}
			class="{inputClass} font-mono"
		></textarea>
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
				<WorkflowStepForm {step} {agents} {allStepNames} {toolGroups} onremove={() => removeStep(idx)} onnamechange={renameStep} />
			{/each}
		</div>
	</div>

	{#if errorMsg}
		<p class="text-sm text-red-400">{errorMsg}</p>
	{/if}

	<div class="flex flex-wrap items-center gap-2">
		<button
			type="submit"
			disabled={submitting}
			class="rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50" style="min-height: 44px;"
		>
			{submitting ? "Saving..." : submitLabel}
		</button>
		{#if oncancel}
			<button
				type="button"
				onclick={oncancel}
				disabled={submitting}
				data-testid="workflow-builder-cancel"
				class="rounded-md bg-[var(--color-surface-tertiary)] px-4 py-3 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border)] disabled:opacity-50" style="min-height: 44px;"
			>
				Cancel
			</button>
		{/if}
	</div>
</form>
