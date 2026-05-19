<script lang="ts">
	import type { AgentCallState } from "$lib/stores.svelte.js";
	import { agentColor } from "$lib/agent-color.js";

	let {
		agent,
		onclick,
	}: {
		agent: AgentCallState;
		onclick?: () => void;
	} = $props();

	let color = $derived(agentColor(agent.agentName));

	// Elapsed time ticker for running agents
	let elapsed = $state(0);
	$effect(() => {
		if (agent.status !== 'running' || !agent.startedAt) return;
		elapsed = Math.floor((Date.now() - agent.startedAt) / 1000);
		const interval = setInterval(() => {
			elapsed = Math.floor((Date.now() - agent.startedAt!) / 1000);
		}, 1000);
		return () => clearInterval(interval);
	});
	let elapsedText = $derived(
		elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
	);

	let displayStatus = $derived(
		agent.status === 'running'
			? `${agent.statusText ?? 'Working...'} (${elapsedText})`
			: agent.status === 'error'
				? (agent.resultPreview ?? 'Failed')
				: (agent.resultPreview
					? (agent.resultPreview.length > 60 ? agent.resultPreview.slice(0, 60) + '...' : agent.resultPreview)
					: 'Done')
	);
</script>

<button
	data-testid="agent-chip"
	class="agent-chip inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors cursor-pointer hover:bg-white/5"
	style:border-color={color}
	style:background="rgba({parseInt(color.slice(1, 3), 16)}, {parseInt(color.slice(3, 5), 16)}, {parseInt(color.slice(5, 7), 16)}, 0.08)"
	onclick={onclick}
>
	<!-- Status indicator -->
	{#if agent.status === 'running'}
		<span class="agent-chip-running relative flex h-2 w-2">
			<span class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" style:background-color={color}></span>
			<span class="relative inline-flex h-2 w-2 rounded-full" style:background-color={color}></span>
		</span>
	{:else if agent.status === 'complete'}
		<svg class="agent-chip-complete h-3 w-3 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
		</svg>
	{:else}
		<svg class="agent-chip-error h-3 w-3 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12" />
		</svg>
	{/if}

	<!-- Agent name -->
	<span class="font-medium" style:color={color}>@{agent.agentName}</span>

	<!-- Status text -->
	<span class="text-[var(--color-text-muted,#888)] truncate max-w-[200px]">{displayStatus}</span>
</button>
