<script lang="ts">
	import { goto } from "$app/navigation";
	import { page } from "$app/stores";
	import { fetchAgents, fetchAgentConfigs, createConversation, type Agent, type AgentConfig } from "$lib/api.js";
	import { store } from "$lib/stores.svelte.js";
	import AgentCard from "$lib/components/AgentCard.svelte";
	import TeamCard from "$lib/components/TeamCard.svelte";
	import EmptyState from "$lib/components/EmptyState.svelte";
	import ShareAgentDialog from "$lib/components/ShareAgentDialog.svelte";
	import { onMount } from "svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";

	let agents = $state<Agent[]>([]);
	let agentConfigs = $state<AgentConfig[]>([]);
	let loading = $state(true);
	let errorMsg = $state("");
	let pageTab = $derived<"agents" | "teams">($page.url.searchParams.get("tab") === "teams" ? "teams" : "agents");
	let ownershipFilter = $state<"all" | "mine" | "shared">("all");
	let selectedCategory = $state<string | null>(null);
	let creatingChat = $state<string | null>(null);
	let shareAgent = $state<Agent | null>(null);

	function setTab(tab: "agents" | "teams") {
		const url = new URL($page.url.href);
		if (tab === "teams") {
			url.searchParams.set("tab", "teams");
		} else {
			url.searchParams.delete("tab");
		}
		goto(url.pathname + url.search, { noScroll: true, keepFocus: true });
	}

	onMount(async () => {
		try {
			const [a, c] = await Promise.all([fetchAgents(), fetchAgentConfigs()]);
			agents = a;
			agentConfigs = c;
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to load agents";
		} finally {
			loading = false;
		}
	});

	let nonTeamAgents = $derived(agents.filter((a) => a.category !== "team"));
	let ownedAgents = $derived(nonTeamAgents.filter((a) => !a.shared));
	let sharedAgents = $derived(nonTeamAgents.filter((a) => a.shared));

	let teamConfigs = $derived(agentConfigs.filter((c) => c.category === "team"));

	let displayAgents = $derived(() => {
		let filtered = ownershipFilter === "mine" ? ownedAgents
			: ownershipFilter === "shared" ? sharedAgents
			: nonTeamAgents;
		if (selectedCategory) {
			filtered = filtered.filter((a) => a.category === selectedCategory);
		}
		return filtered;
	});

	let categories = $derived(
		[...new Set(agents.map((a) => a.category).filter(Boolean) as string[])].sort(),
	);

	async function handleChat(agent: Agent) {
		if (!agent.id) return;
		const projectId = store.activeProjectId;
		if (!projectId || projectId === "global") {
			errorMsg = "Select a project first";
			return;
		}
		creatingChat = agent.name;
		try {
			const conv = await createConversation({
				projectId,
				agentConfigId: agent.id,
			});
			goto(`/project/${projectId}/chat/${conv.id}`);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to start chat";
		} finally {
			creatingChat = null;
		}
	}

	async function handleTeamChat(team: AgentConfig) {
		const projectId = store.activeProjectId;
		if (!projectId || projectId === "global") {
			errorMsg = "Select a project first";
			return;
		}
		creatingChat = team.name;
		try {
			const conv = await createConversation({
				projectId,
				agentConfigId: team.id,
			});
			goto(`/project/${projectId}/chat/${conv.id}`);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to start chat";
		} finally {
			creatingChat = null;
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h2 class="text-xl font-semibold text-[var(--color-text-primary)]">Agents</h2>
		{#if pageTab === "teams"}
			<a
				href="/agents/new?type=team"
				class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
			>
				+ New Team
			</a>
		{:else}
			<a
				href="/agents/new"
				class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-500"
			>
				+ New Agent
			</a>
		{/if}
	</div>

	<!-- Agents / Teams tab bar -->
	<div class="mb-4 flex border-b border-[var(--color-border)]">
		<button
			onclick={() => setTab('agents')}
			class="px-4 py-2 text-sm font-medium transition-colors {pageTab === 'agents'
				? 'border-b-2 border-blue-500 text-[var(--color-text-primary)]'
				: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
		>
			Agents
		</button>
		<button
			onclick={() => setTab('teams')}
			class="px-4 py-2 text-sm font-medium transition-colors {pageTab === 'teams'
				? 'border-b-2 border-blue-500 text-[var(--color-text-primary)]'
				: 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}"
		>
			Teams
			{#if teamConfigs.length > 0}
				<span class="ml-1 rounded-full bg-indigo-500/30 px-1.5 text-xs">{teamConfigs.length}</span>
			{/if}
		</button>
	</div>

	{#if errorMsg}
		<p class="text-sm text-red-400">{errorMsg}</p>
	{/if}

	{#if pageTab === "agents"}
	<!-- Ownership filter tabs -->
	<div class="flex flex-wrap gap-2">
		{#each [
			{ key: "all", label: "All" },
			{ key: "mine", label: "My agents" },
			{ key: "shared", label: "Shared with me" },
		] as tab}
			<button
				onclick={() => (ownershipFilter = tab.key as typeof ownershipFilter)}
				class="rounded-full px-3 py-1 text-sm transition-colors {ownershipFilter === tab.key ? 'bg-blue-600 text-white' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]'}"
			>
				{tab.label}
				{#if tab.key === "shared" && sharedAgents.length > 0}
					<span class="ml-1 rounded-full bg-blue-500/30 px-1.5 text-xs">{sharedAgents.length}</span>
				{/if}
			</button>
		{/each}
	</div>

	{#if categories.length > 0}
		<div class="flex flex-wrap gap-2">
			<button
				onclick={() => (selectedCategory = null)}
				class="rounded-full px-3 py-1 text-sm transition-colors {selectedCategory === null ? 'bg-blue-600 text-white' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]'}"
			>
				All categories
			</button>
			{#each categories as cat}
				<button
					onclick={() => (selectedCategory = selectedCategory === cat ? null : cat)}
					class="rounded-full px-3 py-1 text-sm transition-colors {selectedCategory === cat ? 'bg-blue-600 text-white' : 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-border)]'}"
				>
					{cat}
				</button>
			{/each}
		</div>
	{/if}

	{#if loading}
		<SkeletonLoader type="card-grid" count={6} />
	{:else if displayAgents().length === 0}
		{#if ownershipFilter === "shared"}
			<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center">
				<p class="text-[var(--color-text-secondary)]">No agents have been shared with you yet.</p>
			</div>
		{:else if selectedCategory}
			<p class="text-[var(--color-text-muted)]">No agents in category "{selectedCategory}" available.</p>
		{:else}
			<EmptyState
				title="No agents configured"
				description="Agents are AI personas with custom instructions and tool access. Create one to get started."
				ctaLabel="Create Agent"
				ctaHref="/agents/new"
			>
				{#snippet icon()}
					<svg class="h-12 w-12 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 14v-1m-3-3h.01M15 10h.01" />
					</svg>
				{/snippet}
			</EmptyState>
		{/if}
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
			{#each displayAgents() as agent (agent.name)}
				<AgentCard
					{agent}
					onchat={agent.source === "config" && !!agent.prompt ? () => handleChat(agent) : undefined}
					onshare={!agent.shared && agent.id && agent.source === "config" ? () => (shareAgent = agent) : undefined}
					onedit={agent.source === "config" && agent.id && !(agent.shared && agent.permission === "read") ? () => goto(`/agents/${agent.name}`) : undefined}
				/>
			{/each}
		</div>
	{/if}

	{:else}
		<!-- Teams tab -->
		{#if loading}
			<SkeletonLoader type="card-grid" count={4} />
		{:else if teamConfigs.length === 0}
			<EmptyState
				title="No teams configured"
				description="Teams coordinate multiple agents to work together. Create one to get started."
				ctaLabel="Create Team"
				ctaHref="/agents/new?type=team"
			>
				{#snippet icon()}
					<svg class="h-12 w-12 text-[var(--color-text-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
					</svg>
				{/snippet}
			</EmptyState>
		{:else}
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{#each teamConfigs as team (team.id)}
					<TeamCard
						{team}
						{agentConfigs}
						onchat={() => handleTeamChat(team)}
						onedit={() => goto(`/agents/${team.name}`)}
					/>
				{/each}
			</div>
		{/if}
	{/if}
</div>

{#if shareAgent?.id}
	<ShareAgentDialog
		agentId={shareAgent.id}
		agentName={shareAgent.name}
		open={true}
		onclose={() => (shareAgent = null)}
	/>
{/if}
