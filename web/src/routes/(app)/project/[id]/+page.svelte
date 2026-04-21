<script lang="ts">
	import { page } from "$app/state";
	import { store, setActiveProjectId } from "$lib/stores.svelte.js";
	import AgentCard from "$lib/components/AgentCard.svelte";
	import RunStatus from "$lib/components/RunStatus.svelte";

	$effect(() => {
		setActiveProjectId(page.params.id ?? null);
	});

	let project = $derived(store.projects.find((p) => p.id === page.params.id));

	let recentRuns = $derived(
		[...store.runs]
			.filter((r) => r.projectId === page.params.id)
			.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
			.slice(0, 20)
	);
</script>

<div class="space-y-8">
	<section>
		<h2 class="mb-4 text-xl font-semibold text-[var(--color-text-primary)]">Agents</h2>
		{#if store.agents.length === 0}
			<p class="text-gray-500">No agents available.</p>
		{:else}
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each store.agents as agent (agent.name)}
					<AgentCard {agent} />
				{/each}
			</div>
		{/if}
	</section>

	<section>
		<h2 class="mb-4 text-xl font-semibold text-[var(--color-text-primary)]">Recent Runs</h2>
		{#if recentRuns.length === 0}
			<p class="text-gray-500">No runs yet.</p>
		{:else}
			<div class="flex flex-col gap-2">
				{#each recentRuns as run (run.id)}
					<RunStatus {run} />
				{/each}
			</div>
		{/if}
	</section>
</div>
