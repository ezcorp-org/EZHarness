<script lang="ts">
	import { goto } from "$app/navigation";
	import { createPipeline, type Pipeline } from "$lib/api.js";
	import { store, refreshPipelines } from "$lib/stores.svelte.js";
	import PipelineBuilder from "$lib/components/PipelineBuilder.svelte";

	let submitting = $state(false);
	let errorMsg = $state("");

	async function handleSubmit(data: Record<string, unknown>) {
		submitting = true;
		errorMsg = "";
		try {
			await createPipeline(data as unknown as Pipeline);
			refreshPipelines();
			goto("/pipelines");
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to create pipeline";
		} finally {
			submitting = false;
		}
	}
</script>

<div class="space-y-6">
	<div>
		<a href="/pipelines" class="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]">&larr; Back</a>
	</div>

	<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
		<h2 class="mb-4 text-2xl font-bold text-[var(--color-text-primary)]">New Pipeline</h2>
		<PipelineBuilder agents={store.agents} onsubmit={handleSubmit} {submitting} />
		{#if errorMsg}
			<p class="mt-3 text-sm text-red-400">{errorMsg}</p>
		{/if}
	</div>
</div>
