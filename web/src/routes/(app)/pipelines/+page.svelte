<script lang="ts">
	import { store } from "$lib/stores.svelte.js";
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="text-2xl font-bold text-[var(--color-text-primary)]">Pipelines</h2>
		<a
			href="/pipelines/new"
			class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
		>
			New Pipeline
		</a>
	</div>

	{#if store.pipelines.length === 0}
		<p class="text-[var(--color-text-muted)]">No pipelines defined yet.</p>
	{:else}
		<div class="space-y-2">
			{#each store.pipelines as pipeline}
				<a
					href="/pipelines/{pipeline.name}"
					class="block rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-4 transition-colors hover:border-[var(--color-text-muted)]"
				>
					<h3 class="font-medium text-[var(--color-text-primary)]">{pipeline.name}</h3>
					{#if pipeline.description}
						<p class="mt-1 text-sm text-[var(--color-text-secondary)]">{pipeline.description}</p>
					{/if}
					<p class="mt-1 text-xs text-[var(--color-text-muted)]">{pipeline.steps.length} step{pipeline.steps.length !== 1 ? "s" : ""}</p>
				</a>
			{/each}
		</div>
	{/if}
</div>
