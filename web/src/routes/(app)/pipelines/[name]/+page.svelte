<script lang="ts">
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import { store, refreshPipelines } from "$lib/stores.svelte.js";
	import { triggerPipelineRun, deletePipeline } from "$lib/api.js";

	let pipelineName = $derived(page.params.name);
	let pipeline = $derived(store.pipelines.find((p) => p.name === pipelineName));
	let runs = $derived(store.pipelineRuns.filter((r) => r.pipelineName === pipelineName));

	const statusColor: Record<string, string> = {
		success: "text-green-400",
		error: "text-red-400",
	};

	let inputText = $state("{}");
	let submitting = $state(false);
	let errorMsg = $state("");

	async function handleRun() {
		if (!pipelineName) return;
		submitting = true;
		errorMsg = "";
		try {
			const input = JSON.parse(inputText);
			await triggerPipelineRun(pipelineName, input, store.activeProjectId);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to run pipeline";
		} finally {
			submitting = false;
		}
	}

	async function handleDelete() {
		if (!pipelineName || !confirm(`Delete pipeline "${pipelineName}"?`)) return;
		await deletePipeline(pipelineName);
		refreshPipelines();
		goto("/pipelines");
	}
</script>

<div class="space-y-6">
	<div>
		<a href="/pipelines" class="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]">&larr; Pipelines</a>
	</div>

	{#if pipeline}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<div class="flex items-start justify-between">
				<div>
					<h2 class="mb-2 text-2xl font-bold text-[var(--color-text-primary)]">{pipeline.name}</h2>
					{#if pipeline.description}
						<p class="mb-4 text-[var(--color-text-secondary)]">{pipeline.description}</p>
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
				{#each pipeline.steps as step, idx}
					<div class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
						<div class="flex items-center gap-2">
							<span class="text-xs text-[var(--color-text-muted)]">{idx + 1}.</span>
							<span class="font-medium text-[var(--color-text-primary)]">{step.name}</span>
							<span class="text-[var(--color-text-muted)]">&rarr;</span>
							<span class="text-blue-400">{step.agent}</span>
						</div>
						{#if step.input && Object.keys(step.input).length > 0}
							<div class="mt-1 text-xs text-[var(--color-text-muted)]">
								Input: {Object.entries(step.input).map(([k, v]) => `${k}=${v}`).join(", ")}
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
			<h3 class="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">Run Pipeline</h3>
			<label class="mb-2 block text-sm text-[var(--color-text-secondary)]" for="pipeline-input">JSON Input</label>
			<textarea
				id="pipeline-input"
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
				{submitting ? "Running..." : "Run Pipeline"}
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
											{step.stepName}: <span class="{statusColor[step.status] ?? 'text-yellow-400'}">{step.status}</span>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{/if}
	{:else}
		<p class="text-[var(--color-text-muted)]">Pipeline "{pipelineName}" not found.</p>
	{/if}
</div>
