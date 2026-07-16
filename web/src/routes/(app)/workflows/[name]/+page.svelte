<script lang="ts">
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import { store, refreshWorkflows } from "$lib/stores.svelte.js";
	import { triggerWorkflowRun, deleteWorkflow } from "$lib/api.js";

	let workflowName = $derived(page.params.name);
	let workflow = $derived(store.workflows.find((w) => w.name === workflowName));
	let runs = $derived(store.workflowRuns.filter((r) => r.workflowName === workflowName));

	const statusColor: Record<string, string> = {
		success: "text-green-400",
		error: "text-red-400",
		cancelled: "text-[var(--color-text-muted)]",
	};

	const kindLabel: Record<string, string> = {
		agent: "agent",
		transform: "transform",
		gate: "gate",
	};

	let inputText = $state("{}");
	let submitting = $state(false);
	let errorMsg = $state("");

	async function handleRun() {
		if (!workflowName) return;
		submitting = true;
		errorMsg = "";
		try {
			const input = JSON.parse(inputText);
			await triggerWorkflowRun(workflowName, input, store.activeProjectId);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to run workflow";
		} finally {
			submitting = false;
		}
	}

	async function handleDelete() {
		if (!workflowName || !confirm(`Delete workflow "${workflowName}"?`)) return;
		await deleteWorkflow(workflowName);
		refreshWorkflows();
		goto("/workflows");
	}
</script>

<div class="space-y-6">
	<div>
		<a href="/workflows" class="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]">&larr; Workflows</a>
	</div>

	{#if workflow}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<div class="flex items-start justify-between">
				<div>
					<h2 class="mb-2 text-2xl font-bold text-[var(--color-text-primary)]">{workflow.name}</h2>
					{#if workflow.description}
						<p class="mb-4 text-[var(--color-text-secondary)]">{workflow.description}</p>
					{/if}
				</div>
				<button
					onclick={handleDelete}
					class="rounded-md bg-red-600/20 px-3 py-1 text-sm text-red-400 hover:bg-red-600/30"
				>
					Delete
				</button>
			</div>

			<h3 class="mb-2 text-sm font-medium text-[var(--color-text-secondary)]">Steps</h3>
			<div class="space-y-2">
				{#each workflow.steps as step, idx}
					{@const kind = step.kind ?? "agent"}
					<div class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
						<div class="flex items-center gap-2">
							<span class="text-xs text-[var(--color-text-muted)]">{idx + 1}.</span>
							<span class="font-medium text-[var(--color-text-primary)]">{step.name}</span>
							<span class="rounded bg-[var(--color-surface-tertiary)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{kindLabel[kind]}</span>
							{#if kind === "agent"}
								<span class="text-[var(--color-text-muted)]">&rarr;</span>
								<span class="text-blue-400">{step.agent}</span>
							{/if}
							{#if step.loop}
								<span class="text-xs text-purple-400">loop &times;{step.loop.maxIterations}{step.loop.until ? " (until)" : ""}</span>
							{/if}
						</div>
						{#if step.input && Object.keys(step.input).length > 0}
							<div class="mt-1 text-xs text-[var(--color-text-muted)]">
								Input: {Object.entries(step.input).map(([k, v]) => `${k}=${v}`).join(", ")}
							</div>
						{/if}
						{#if step.output && Object.keys(step.output).length > 0}
							<div class="mt-1 text-xs text-[var(--color-text-muted)]">
								Output: {Object.entries(step.output).map(([k, v]) => `${k}=${v}`).join(", ")}
							</div>
						{/if}
						{#if step.dependsOn && step.dependsOn.length > 0}
							<div class="mt-1 text-xs text-[var(--color-text-muted)]">
								Depends on: {step.dependsOn.join(", ")}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<h3 class="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">Run Workflow</h3>
			<label class="mb-2 block text-sm text-[var(--color-text-secondary)]" for="workflow-input">JSON Input</label>
			<textarea
				id="workflow-input"
				bind:value={inputText}
				class="mb-3 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
				rows="3"
				placeholder={'{"key": "value"}'}
			></textarea>
			{#if errorMsg}
				<p class="mb-3 text-sm text-red-400">{errorMsg}</p>
			{/if}
			<button
				onclick={handleRun}
				disabled={submitting}
				class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
			>
				{submitting ? "Running..." : "Run Workflow"}
			</button>
		</div>

		{#if runs.length > 0}
			<section>
				<h3 class="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">Run History</h3>
				<div class="space-y-2">
					{#each runs as run (run.id)}
						<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium text-[var(--color-text-primary)]">{run.id.slice(0, 8)}</span>
								<span class="rounded bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs {statusColor[run.status] ?? 'text-yellow-400'}">{run.status}</span>
							</div>
							{#if run.steps.length > 0}
								<div class="mt-2 space-y-1">
									{#each run.steps as step}
										<div class="text-xs text-[var(--color-text-secondary)]">
											{step.stepName}: <span class="{statusColor[step.status] ?? 'text-yellow-400'}">{step.status}</span>{#if step.iterations} <span class="text-[var(--color-text-muted)]">({step.iterations} iteration{step.iterations !== 1 ? "s" : ""})</span>{/if}
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{:else}
			<p class="text-[var(--color-text-muted)]">No runs yet — trigger one above.</p>
		{/if}
	{:else}
		<p class="text-[var(--color-text-muted)]">Workflow "{workflowName}" not found.</p>
	{/if}
</div>
