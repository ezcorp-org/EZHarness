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
	import { rankAgents } from "$lib/workers/agent-fuzzy-search-bridge.js";

	let agents = $state<Agent[]>([]);
	let agentConfigs = $state<AgentConfig[]>([]);
	let loading = $state(true);
	let errorMsg = $state("");
	let pageTab = $derived<"agents" | "teams">($page.url.searchParams.get("tab") === "teams" ? "teams" : "agents");
	let ownershipFilter = $state<"all" | "mine" | "shared">("all");
	let selectedCategory = $state<string | null>(null);
	let creatingChat = $state<string | null>(null);
	let shareAgent = $state<Agent | null>(null);

	// Phase 49.2 — fuzzy search. Empty `searchQuery` keeps the legacy
	// ordering (no ranking applied); a non-empty query routes through
	// `rankAgents()` which decides synchronously between main-thread
	// scoring and a Web Worker based on candidate count
	// (`WORKER_THRESHOLD`, currently 100). The 100ms debounce keeps the
	// input responsive on slow devices without bombarding the worker.
	let searchQuery = $state("");
	let rankedIndices = $state<number[] | null>(null); // null = no active query
	let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	const SEARCH_DEBOUNCE_MS = 100;

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
		// Apply fuzzy ranking last so it composes with the ownership +
		// category filters above. `rankedIndices` is null when no query
		// is active; otherwise it indexes into the *unfiltered* `agents`
		// array (matches that survived ranking, in descending-score
		// order). Walk the ranked indices and keep only agents that also
		// passed the ownership/category filter — this preserves the
		// score-sorted order while honouring active filters.
		if (rankedIndices !== null) {
			const allowed = new Set(filtered);
			const ranked: Agent[] = [];
			for (const i of rankedIndices) {
				const a = agents[i];
				if (a && allowed.has(a)) ranked.push(a);
			}
			filtered = ranked;
		}
		return filtered;
	});

	function runSearch(q: string) {
		const trimmed = q.trim();
		if (!trimmed) {
			rankedIndices = null;
			return;
		}
		// `rankAgents` returns a Promise even on the sync path so a single
		// call site handles both. We intentionally don't await — the
		// derived `displayAgents` re-runs once `rankedIndices` updates.
		rankAgents(trimmed, agents)
			.then((res) => {
				// Stale-response guard: only commit if the query is still
				// the same. Otherwise a slow worker reply for an old
				// keystroke would clobber a newer search.
				if (searchQuery.trim() === trimmed) {
					rankedIndices = res.indices;
				}
			})
			.catch(() => {
				// Worker crash: fall back to "no ranking" so the user still
				// sees their full list rather than a blank page.
				rankedIndices = null;
			});
	}

	function onSearchInput(e: Event) {
		const value = (e.currentTarget as HTMLInputElement).value;
		searchQuery = value;
		clearTimeout(searchDebounceTimer);
		searchDebounceTimer = setTimeout(() => runSearch(value), SEARCH_DEBOUNCE_MS);
	}

	function clearSearch() {
		searchQuery = "";
		rankedIndices = null;
		clearTimeout(searchDebounceTimer);
	}

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
	<!-- Phase 49.2 — Fuzzy search input. Debounced 100ms; offloads to a
	     Web Worker once the candidate list crosses 100 agents. -->
	<div class="relative">
		<svg
			class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]"
			fill="none"
			stroke="currentColor"
			viewBox="0 0 24 24"
			aria-hidden="true"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width="2"
				d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
			/>
		</svg>
		<input
			type="search"
			value={searchQuery}
			oninput={onSearchInput}
			placeholder="Search agents by name or description..."
			aria-label="Search agents"
			data-testid="agent-search-input"
			class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] py-2 pl-10 pr-10 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
		/>
		{#if searchQuery}
			<button
				type="button"
				onclick={clearSearch}
				aria-label="Clear search"
				data-testid="agent-search-clear"
				class="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
				style="min-width: 32px; min-height: 32px;"
			>
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		{/if}
	</div>

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
		{#if searchQuery.trim()}
			<div
				class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-8 text-center"
				data-testid="agent-search-empty"
			>
				<p class="text-[var(--color-text-secondary)]">
					No agents match "{searchQuery}"
				</p>
				<button
					type="button"
					onclick={clearSearch}
					class="mt-3 rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-border)]"
				>
					Clear search
				</button>
			</div>
		{:else if ownershipFilter === "shared"}
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
