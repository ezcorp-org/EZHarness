<script lang="ts">
	import { untrack } from "svelte";
	import type { Agent } from "$lib/api.js";
	import { inputClass } from "$lib/styles.js";

	let {
		step = { name: "", agent: "", input: {}, dependsOn: [] },
		agents = [],
		allStepNames = [],
		onremove,
	}: {
		step: { name: string; agent: string; input: Record<string, string>; dependsOn: string[] };
		agents: Agent[];
		allStepNames: string[];
		onremove: () => void;
	} = $props();

	let inputPairs = $state(
		untrack(() => Object.entries(step.input).map(([k, v]) => ({ key: k, value: v }))),
	);

	function addInputPair() {
		inputPairs = [...inputPairs, { key: "", value: "" }];
	}

	function removeInputPair(idx: number) {
		inputPairs = inputPairs.filter((_, i) => i !== idx);
	}

	// Sync inputPairs back to step.input
	$effect(() => {
		const result: Record<string, string> = {};
		for (const pair of inputPairs) {
			if (pair.key.trim()) result[pair.key.trim()] = pair.value;
		}
		untrack(() => { step.input = result; });
	});

	let otherStepNames = $derived(allStepNames.filter((n) => n !== step.name));

	function toggleDep(depName: string) {
		if (step.dependsOn.includes(depName)) {
			step.dependsOn = step.dependsOn.filter((d) => d !== depName);
		} else {
			step.dependsOn = [...step.dependsOn, depName];
		}
	}
</script>

<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4 space-y-3">
	<div class="flex items-center justify-between">
		<h4 class="text-sm font-medium text-[var(--color-text-primary)]">Step</h4>
		<button type="button" onclick={onremove} class="text-red-400 hover:text-red-300 text-sm">&times; Remove</button>
	</div>

	<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
		<div>
			<label for="step-name-{step.name}" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Step Name</label>
			<input id="step-name-{step.name}" type="text" bind:value={step.name} placeholder="step-name" class={inputClass} />
		</div>
		<div>
			<label for="step-agent-{step.name}" class="mb-1 block text-xs text-[var(--color-text-secondary)]">Agent</label>
			<select id="step-agent-{step.name}" bind:value={step.agent} class={inputClass}>
				<option value="">-- Select Agent --</option>
				{#each agents as a}
					<option value={a.name}>{a.name}</option>
				{/each}
			</select>
		</div>
	</div>

	<!-- Input Mapping -->
	<div>
		<div class="mb-1 flex items-center justify-between">
			<div class="text-xs text-[var(--color-text-secondary)]">Input Mapping</div>
			<button type="button" onclick={addInputPair} class="text-xs text-blue-400 hover:text-blue-300">+ Add</button>
		</div>
		{#each inputPairs as pair, idx}
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
