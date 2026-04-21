<script lang="ts">
	import type { LogEntry } from "$lib/api.js";

	let { logs }: { logs: LogEntry[] } = $props();

	let container: HTMLDivElement | undefined = $state();

	const levelColors: Record<string, string> = {
		debug: "text-[var(--color-text-muted)]",
		info: "text-[var(--color-text-primary)]",
		warn: "text-yellow-400",
		error: "text-red-400",
	};

	function formatTime(timestamp: string): string {
		const d = new Date(timestamp);
		return d.toTimeString().slice(0, 8);
	}

	$effect(() => {
		// Track logs length to trigger auto-scroll
		logs.length;
		if (container) {
			container.scrollTop = container.scrollHeight;
		}
	});
</script>

<div
	bind:this={container}
	class="max-h-96 overflow-y-auto rounded-lg bg-[var(--color-surface-secondary)] p-4 font-mono text-sm"
>
	{#if logs.length === 0}
		<p class="text-[var(--color-text-muted)]">No logs yet...</p>
	{:else}
		{#each logs as log}
			<div class="flex gap-2 py-0.5 {levelColors[log.level] ?? levelColors.info}">
				<span class="shrink-0 text-[var(--color-text-muted)]">{formatTime(log.timestamp)}</span>
				<span class="shrink-0 w-12 text-right uppercase text-xs leading-5 {levelColors[log.level] ?? levelColors.info}">{log.level}</span>
				<span class="whitespace-pre-wrap break-all">{log.message}</span>
			</div>
		{/each}
	{/if}
</div>
