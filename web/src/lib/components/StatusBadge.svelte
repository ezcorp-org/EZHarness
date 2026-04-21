<script lang="ts">
	let { status }: { status: string } = $props();

	const colorMap: Record<string, string> = {
		running: "bg-blue-500/20 text-blue-400 border-blue-500/30",
		success: "bg-green-500/20 text-green-400 border-green-500/30",
		error: "bg-red-500/20 text-red-400 border-red-500/30",
		idle: "bg-gray-500/20 text-gray-400 border-gray-500/30",
		cancelled: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
	};

	let classes = $derived(colorMap[status] ?? colorMap.idle);
	let isRunning = $derived(status === "running");
</script>

<span class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium {classes}">
	{#if isRunning}
		<span class="relative flex h-2 w-2">
			<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75"></span>
			<span class="relative inline-flex h-2 w-2 rounded-full bg-blue-500"></span>
		</span>
	{/if}
	{status}
</span>
