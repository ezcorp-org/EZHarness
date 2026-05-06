<script lang="ts">
	import type { Agent } from "$lib/api.js";

	let {
		agent,
		onchat,
		onshare,
		onedit,
	}: {
		agent: Agent;
		onchat?: (agent: Agent) => void;
		onshare?: () => void;
		onedit?: () => void;
	} = $props();

	let isChatCapable = $derived(agent.source === "config" && !!agent.prompt);
	let isReadOnly = $derived(agent.shared && agent.permission === "read");
</script>

<div class="flex h-full flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-5 transition-colors hover:border-[var(--color-border)]">
	<div class="mb-3 min-w-0">
		<div class="flex flex-wrap items-center gap-2">
			<h3 class="truncate text-lg font-semibold text-[var(--color-text-primary)]">{agent.name}</h3>
			<span class="shrink-0 rounded px-1.5 py-0.5 text-xs {agent.source === 'config' ? 'bg-blue-900 text-blue-300' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]'}">
				{agent.source === "config" ? "Config" : "File"}
			</span>
			{#if agent.shared}
				<span class="shrink-0 rounded bg-purple-900/40 px-1.5 py-0.5 text-xs text-purple-300">Shared</span>
			{/if}
			{#if isReadOnly}
				<svg class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="Read-only">
					<title>Read-only</title>
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
				</svg>
			{/if}
		</div>
		{#if agent.shared && agent.sharedByName}
			<p class="mt-0.5 text-xs text-[var(--color-text-muted)]">Shared by {agent.sharedByName}</p>
		{:else if agent.category}
			<p class="mt-0.5 text-xs text-[var(--color-text-muted)]">{agent.category}</p>
		{/if}
	</div>
	<p class="mb-3 text-sm text-[var(--color-text-secondary)]">{agent.description}</p>
	<div class="flex flex-wrap gap-1.5">
		{#each agent.capabilities as cap}
			<span class="rounded-md bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">{cap}</span>
		{/each}
	</div>
	<div class="mt-auto flex flex-wrap gap-2 pt-4">
		{#if onshare}
			<button
				onclick={onshare}
				class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
				title="Share agent"
			>
				Share
			</button>
		{/if}
		{#if isChatCapable && onchat}
			<button
				onclick={() => onchat!(agent)}
				class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
			>
				Chat
			</button>
		{/if}
		{#if onedit}
			<button
				onclick={onedit}
				class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border)]"
			>
				Edit
			</button>
		{/if}
		{#if !isReadOnly}
			<a
				href="/agents/{agent.name}"
				class="rounded-md {isChatCapable ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)]' : 'bg-blue-600 text-white hover:bg-blue-500'} px-3 py-1.5 text-sm font-medium transition-colors"
			>
				Run
			</a>
		{:else}
			<a
				href="/agents/{agent.name}"
				class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
			>
				Run
			</a>
		{/if}
	</div>
</div>
