<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { buildActiveAgentHref } from "$lib/active-agents-href.js";
	import {
		groupAgentsByProject,
		type ProjectLike,
		type ActiveAgentsGroup,
	} from "$lib/group-active-agents.js";

	type ActiveAgent = {
		runId: string;
		agentName: string;
		conversationId: string;
		parentConversationId: string | null;
		projectId: string | null;
		conversationTitle: string | null;
		startedAt: number;
	};

	let {
		projectId,
		pollMs = 5000,
		groupByProject = false,
	}: { projectId?: string; pollMs?: number; groupByProject?: boolean } = $props();

	let rows = $state<ActiveAgent[]>([]);
	let projects = $state<ProjectLike[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | undefined;

	let groups = $derived<ActiveAgentsGroup<ActiveAgent>[]>(
		groupByProject ? groupAgentsByProject(rows, projects) : [],
	);

	async function loadAgents() {
		const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
		const res = await fetch(`/api/active-agents${qs}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		rows = (await res.json()) as ActiveAgent[];
	}

	async function loadProjects() {
		if (!groupByProject) return;
		const res = await fetch(`/api/projects`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		projects = (await res.json()) as ProjectLike[];
	}

	async function load() {
		try {
			await Promise.all([loadAgents(), loadProjects()]);
			error = null;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	function formatElapsed(startedAt: number): string {
		const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const remaining = seconds % 60;
		return `${minutes}m ${remaining}s`;
	}

	onMount(() => {
		load();
		timer = setInterval(load, pollMs);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});
</script>

{#snippet row(r: ActiveAgent)}
	{@const href = buildActiveAgentHref(r)}
	<a
		{href}
		class="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-4 py-3 transition-colors hover:border-[var(--color-accent)]"
	>
		<div class="flex min-w-0 items-center gap-3">
			<span class="relative flex h-2.5 w-2.5 shrink-0">
				<span
					class="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75"
				></span>
				<span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500"></span>
			</span>
			<span class="truncate text-sm font-medium text-[var(--color-text-primary)]">
				{r.agentName}
			</span>
			{#if r.conversationTitle}
				<span class="truncate text-xs text-[var(--color-text-secondary)]">
					— {r.conversationTitle}
				</span>
			{/if}
		</div>
		<div class="flex shrink-0 items-center gap-3 text-xs text-[var(--color-text-secondary)]">
			<span>{formatElapsed(r.startedAt)}</span>
			<span class="text-[var(--color-text-muted)]">{r.runId.slice(0, 8)}</span>
		</div>
	</a>
{/snippet}

{#if loading && rows.length === 0}
	<p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
{:else if error}
	<p class="text-sm text-red-500">Failed to load: {error}</p>
{:else if rows.length === 0}
	<p class="text-sm text-[var(--color-text-muted)]">No active agents right now.</p>
{:else if groupByProject}
	<div class="flex flex-col gap-6" data-testid="active-agents-grouped">
		{#each groups as group (group.projectId ?? "__unassigned__")}
			<section data-testid="active-agents-group" data-project-id={group.projectId ?? ""}>
				<h3
					class="mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]"
					data-testid="active-agents-group-heading"
				>
					{group.projectName}
					<span class="ml-2 text-xs font-normal normal-case text-[var(--color-text-muted)]">
						({group.agents.length})
					</span>
				</h3>
				<div class="flex flex-col gap-2">
					{#each group.agents as r (r.runId)}
						{@render row(r)}
					{/each}
				</div>
			</section>
		{/each}
	</div>
{:else}
	<div class="flex flex-col gap-2">
		{#each rows as r (r.runId)}
			{@render row(r)}
		{/each}
	</div>
{/if}
