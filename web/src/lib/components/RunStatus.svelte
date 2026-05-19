<script lang="ts">
	import type { Run } from "$lib/api.js";
	import StatusBadge from "./StatusBadge.svelte";

	let { run }: { run: Run } = $props();

	let duration = $derived.by(() => {
		if (!run.startedAt) return null;
		const start = new Date(run.startedAt).getTime();
		const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
		const seconds = Math.round((end - start) / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const remaining = seconds % 60;
		return `${minutes}m ${remaining}s`;
	});
</script>

<a
	href="/runs/{run.id}"
	class="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-4 py-3 transition-colors hover:border-[var(--color-border)]"
>
	<div class="flex items-center gap-3">
		<StatusBadge status={run.status} />
		<span class="text-sm font-medium text-[var(--color-text-primary)]">{run.agentName}</span>
		<span class="text-xs text-[var(--color-text-muted)]">{run.id.slice(0, 8)}</span>
	</div>
	<div class="flex items-center gap-3 text-xs text-[var(--color-text-secondary)]">
		{#if duration}
			<span>{duration}</span>
		{/if}
		<span>{new Date(run.startedAt).toLocaleTimeString()}</span>
	</div>
</a>
