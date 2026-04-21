<script lang="ts">
	import { page } from "$app/state";
	import { store } from "$lib/stores.svelte.js";
	import { fetchRun, type Run } from "$lib/api.js";
	import { onMount } from "svelte";
	import StatusBadge from "$lib/components/StatusBadge.svelte";
	import LogStream from "$lib/components/LogStream.svelte";

	let run: Run | null = $state<Run | null>(null);
	let runId = $derived(page.params.id);

	// Keep in sync with store updates (from WS)
	let storeRun = $derived(store.runs.find((r) => r.id === runId) ?? null);

	$effect(() => {
		if (storeRun) {
			run = storeRun;
		}
	});

	onMount(async () => {
		if (!runId) return;
		try {
			const data = await fetchRun(runId);
			run = data;
		} catch {
			// will show not found
		}
	});

	let duration = $derived.by(() => {
		if (!run?.startedAt) return null;
		const start = new Date(run.startedAt).getTime();
		const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
		const seconds = Math.round((end - start) / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const remaining = seconds % 60;
		return `${minutes}m ${remaining}s`;
	});

	let resultJson = $derived(run?.result ? JSON.stringify(run.result, null, 2) : null);
</script>

<div class="space-y-6">
	<div>
		<a href="/" class="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]">&larr; Back</a>
	</div>

	{#if run}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<div class="mb-4 flex items-center gap-4">
				<StatusBadge status={run.status} />
				<h2 class="text-xl font-bold text-[var(--color-text-primary)]">{run.agentName}</h2>
				<span class="text-sm text-[var(--color-text-muted)]">{run.id}</span>
			</div>

			<div class="grid gap-4 text-sm sm:grid-cols-3">
				<div>
					<span class="text-[var(--color-text-muted)]">Started</span>
					<p class="text-[var(--color-text-primary)]">{new Date(run.startedAt).toLocaleString()}</p>
				</div>
				{#if run.finishedAt}
					<div>
						<span class="text-[var(--color-text-muted)]">Finished</span>
						<p class="text-[var(--color-text-primary)]">{new Date(run.finishedAt).toLocaleString()}</p>
					</div>
				{/if}
				{#if duration}
					<div>
						<span class="text-[var(--color-text-muted)]">Duration</span>
						<p class="text-[var(--color-text-primary)]">{duration}</p>
					</div>
				{/if}
			</div>
		</div>

		<section>
			<h3 class="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">Logs</h3>
			<LogStream logs={run.logs} />
		</section>

		{#if resultJson}
			<section>
				<h3 class="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">Result</h3>
				<pre class="overflow-x-auto rounded-lg bg-[var(--color-surface-secondary)] p-4 font-mono text-sm text-green-400">{resultJson}</pre>
			</section>
		{/if}
	{:else}
		<p class="text-[var(--color-text-muted)]">Loading run...</p>
	{/if}
</div>
