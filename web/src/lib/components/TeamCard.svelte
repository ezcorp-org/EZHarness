<script lang="ts">
	import type { AgentConfig } from "$lib/api";

	let {
		team,
		agentConfigs,
		onchat,
		onedit,
	}: {
		team: AgentConfig;
		agentConfigs: AgentConfig[];
		onchat: () => void;
		onedit: () => void;
	} = $props();

	let members = $derived(team.references?.members ?? []);
	let memberCount = $derived(members.length);

	let resolvedNames = $derived(
		members.slice(0, 3).map((m) => {
			const config = agentConfigs.find((c) => c.id === m.agentConfigId);
			return config?.name ?? "Unknown";
		}),
	);

	let extraCount = $derived(Math.max(0, memberCount - 3));
</script>

<div class="flex h-full flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-5 transition-colors hover:border-[var(--color-border)]">
	<div class="mb-3 min-w-0">
		<div class="flex flex-wrap items-center gap-2">
			<h3 class="truncate text-lg font-semibold text-[var(--color-text-primary)]">{team.name}</h3>
			<span class="shrink-0 rounded bg-indigo-900 px-1.5 py-0.5 text-xs text-indigo-300">
				{memberCount} member{memberCount === 1 ? "" : "s"}
			</span>
		</div>
	</div>
	{#if team.description}
		<p class="mb-3 truncate text-sm text-[var(--color-text-secondary)]">{team.description}</p>
	{/if}
	{#if resolvedNames.length > 0}
		<div class="flex flex-wrap gap-1.5">
			{#each resolvedNames as name}
				<span class="rounded-md bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">{name}</span>
			{/each}
			{#if extraCount > 0}
				<span class="rounded-md bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]">+{extraCount} more</span>
			{/if}
		</div>
	{/if}
	<div class="mt-auto flex flex-wrap gap-2 pt-4">
		<button
			onclick={onchat}
			class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
		>
			Chat
		</button>
		<button
			onclick={onedit}
			class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border)]"
		>
			Edit
		</button>
	</div>
</div>
