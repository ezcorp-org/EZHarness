<script lang="ts">
	import type { Agent } from "$lib/api.js";
	import { inputClass } from "$lib/styles.js";
	import type { StepDraft } from "$lib/workflow-builder-logic.js";

	let {
		step,
		agents = [],
		allStepNames = [],
		onremove,
	}: {
		step: StepDraft;
		agents: Agent[];
		allStepNames: string[];
		onremove: () => void;
	} = $props();

	let otherStepNames = $derived(allStepNames.filter((n) => n !== step.name));

	function addInputPair() {
		step.inputPairs = [...step.inputPairs, { key: "", value: "" }];
	}
	function removeInputPair(idx: number) {
		step.inputPairs = step.inputPairs.filter((_, i) => i !== idx);
	}
	function addOutputPair() {
		step.outputPairs = [...step.outputPairs, { key: "", value: "" }];
	}
	function removeOutputPair(idx: number) {
		step.outputPairs = step.outputPairs.filter((_, i) => i !== idx);
	}
	function toggleDep(depName: string) {
		step.dependsOn = step.dependsOn.includes(depName)
			? step.dependsOn.filter((d) => d !== depName)
			: [...step.dependsOn, depName];
	}
</script>

<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4 space-y-3">
	<div class="flex items-center justify-between">
		<h4 class="text-sm font-medium text-[var(--color-text-primary)]">Step</h4>
		<button type="button" onclick={onremove} class="text-red-400 hover:text-red-300 text-sm">&times; Remove</button>
	</div>

	<div class="grid grid-cols-1 md:grid-cols-3 gap-3">
		<div>
			<label for="step-name-{step.name}" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Step Name</label>
			<input id="step-name-{step.name}" type="text" bind:value={step.name} placeholder="step-name" class={inputClass} />
		</div>
		<div>
			<label for="step-kind-{step.name}" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Kind</label>
			<select id="step-kind-{step.name}" bind:value={step.kind} class={inputClass}>
				<option value="agent">Agent</option>
				<option value="transform">Transform</option>
				<option value="gate">Gate</option>
			</select>
		</div>
		{#if step.kind === "agent"}
			<div>
				<label for="step-agent-{step.name}" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Agent</label>
				<select id="step-agent-{step.name}" bind:value={step.agent} class={inputClass}>
					<option value="">-- Select Agent --</option>
					{#each agents as a}
						<option value={a.name}>{a.name}</option>
					{/each}
				</select>
			</div>
		{/if}
	</div>

	{#if step.kind === "agent"}
		<!-- Input Mapping (agent only — the executor never reads `input` on a
		     transform step, so surfacing the editor there is dead/misleading UX). -->
		<div>
			<div class="mb-1 flex items-center justify-between">
				<div class="text-xs text-[var(--color-text-secondary)]">Input Mapping</div>
				<button type="button" onclick={addInputPair} class="text-xs text-blue-400 hover:text-blue-300">+ Add</button>
			</div>
			{#each step.inputPairs as pair, idx}
				<div class="mb-1 flex flex-wrap md:flex-nowrap items-center gap-2">
					<label class="sr-only" for="input-key-{step.name}-{idx}">Input field name</label>
					<input id="input-key-{step.name}-{idx}" type="text" bind:value={pair.key} placeholder="field" class="{inputClass} w-full md:w-28" />
					<span class="text-[var(--color-text-muted)]">=</span>
					<label class="sr-only" for="input-val-{step.name}-{idx}">Input field value</label>
					<input id="input-val-{step.name}-{idx}" type="text" bind:value={pair.value} placeholder="$input.x or $prev.output" class="{inputClass} w-full md:w-auto md:flex-1" />
					<button type="button" onclick={() => removeInputPair(idx)} class="text-red-400 hover:text-red-300">&times;</button>
				</div>
			{/each}
		</div>
	{/if}

	{#if step.kind === "transform"}
		<!-- Output Mapping -->
		<div>
			<div class="mb-1 flex items-center justify-between">
				<div class="text-xs text-[var(--color-text-secondary)]">Output Mapping</div>
				<button type="button" onclick={addOutputPair} class="text-xs text-blue-400 hover:text-blue-300">+ Add</button>
			</div>
			{#each step.outputPairs as pair, idx}
				<div class="mb-1 flex flex-wrap md:flex-nowrap items-center gap-2">
					<label class="sr-only" for="output-key-{step.name}-{idx}">Output field name</label>
					<input id="output-key-{step.name}-{idx}" type="text" bind:value={pair.key} placeholder="field" class="{inputClass} w-full md:w-28" />
					<span class="text-[var(--color-text-muted)]">=</span>
					<label class="sr-only" for="output-val-{step.name}-{idx}">Output field value</label>
					<input id="output-val-{step.name}-{idx}" type="text" bind:value={pair.value} placeholder={"{{$input.a}} — or literal"} class="{inputClass} w-full md:w-auto md:flex-1" />
					<button type="button" onclick={() => removeOutputPair(idx)} class="text-red-400 hover:text-red-300">&times;</button>
				</div>
			{/each}
		</div>
	{/if}

	{#if step.kind === "gate"}
		<!-- Gate Condition -->
		<div>
			<label for="cond-{step.name}" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Condition (JSON)</label>
			<textarea
				id="cond-{step.name}"
				bind:value={step.conditionText}
				rows="3"
				placeholder={'{ "ref": "$steps.a.output.n", "op": "gte", "value": 3 }'}
				class="{inputClass} font-mono"
			></textarea>
		</div>
	{/if}

	{#if step.kind !== "gate"}
		<!-- Loop -->
		<div class="rounded border border-[var(--color-border)] p-2">
			<label class="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
				<input type="checkbox" bind:checked={step.loopEnabled} />
				Loop this step
			</label>
			{#if step.loopEnabled}
				<div class="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
					<div>
						<label for="loop-max-{step.name}" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Max iterations (1–25)</label>
						<input id="loop-max-{step.name}" type="number" min="1" max="25" bind:value={step.maxIterations} class={inputClass} />
					</div>
					<div>
						<label for="loop-exh-{step.name}" class="mb-1 block text-xs text-[var(--color-text-secondary)]">On exhausted</label>
						<select id="loop-exh-{step.name}" bind:value={step.onExhausted} class={inputClass}>
							<option value="fail">fail (loud)</option>
							<option value="pass">pass</option>
						</select>
					</div>
				</div>
				<div class="mt-2">
					<label for="loop-until-{step.name}" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Until condition (JSON, optional)</label>
					<textarea
						id="loop-until-{step.name}"
						bind:value={step.untilText}
						rows="2"
						placeholder={'{ "ref": "$result.output.n", "op": "gte", "value": 3 }'}
						class="{inputClass} font-mono"
					></textarea>
				</div>
			{/if}
		</div>
	{/if}

	{#if step.kind === "agent" && !step.loopEnabled}
		<div>
			<label for="retries-{step.name}" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Retries (0–2)</label>
			<input id="retries-{step.name}" type="number" min="0" max="2" bind:value={step.retries} class="{inputClass} w-24" />
		</div>
	{/if}

	<!-- Depends On -->
	{#if otherStepNames.length > 0}
		<div>
			<div class="mb-1 block text-xs text-[var(--color-text-secondary)]">Depends On</div>
			<div class="flex flex-wrap gap-2">
				{#each otherStepNames as depName}
					<label class="flex items-center gap-1 text-xs text-[var(--color-text-secondary)]">
						<input
							type="checkbox"
							checked={step.dependsOn.includes(depName)}
							onchange={() => toggleDep(depName)}
						/>
						{depName}
					</label>
				{/each}
			</div>
		</div>
	{/if}
</div>
