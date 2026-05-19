<script lang="ts">
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import { store, refreshAgentConfigs } from "$lib/stores.svelte.js";
	import MentionText from "$lib/components/MentionText.svelte";
	import { triggerRun, createConversation, fetchTestConversations, deleteTestConversations, fetchAgentConfigs, fetchAgentConfig, updateAgentConfig, type Conversation, type AgentConfig } from "$lib/api.js";
	import RunStatus from "$lib/components/RunStatus.svelte";
	import AgentInputForm from "$lib/components/AgentInputForm.svelte";
	import TeamBuilderForm from "$lib/components/TeamBuilderForm.svelte";
	import AgentConfigForm from "$lib/components/AgentConfigForm.svelte";
	import Breadcrumb from "$lib/components/Breadcrumb.svelte";


	let inputText = $state("{}");
	let submitting = $state(false);
	let errorMsg = $state("");

	let agentName = $derived(page.params.name);
	let agent = $derived(store.agents.find((a) => a.name === agentName));
	let isTeam = $derived(agent?.category === "team");
	let isEditable = $derived(
		!isTeam &&
		agent?.source === "config" &&
		!!agent?.id &&
		!(agent?.shared && agent?.permission === "read")
	);

	// Team editing state
	let teamEditSubmitting = $state(false);
	let teamEditError = $state("");

	// Agent editing state
	let agentEditSubmitting = $state(false);
	let agentEditError = $state("");
	let agentConfigPromise = $state<Promise<AgentConfig> | null>(null);
	let _lastAgentFetchId: string | null = null;

	// Reactive promise that loads team data when agent resolves to a team
	let teamDataPromise = $state<Promise<[AgentConfig, AgentConfig[]]> | null>(null);
	let _lastTeamFetchId: string | null = null; // non-reactive guard to prevent re-fetch

	$effect(() => {
		const a = agent; // track agent reactively
		if (a?.category === "team" && a.id && a.id !== _lastTeamFetchId) {
			_lastTeamFetchId = a.id;
			teamDataPromise = Promise.all([fetchAgentConfig(a.id), fetchAgentConfigs()]);
		}
	});

	$effect(() => {
		const a = agent;
		if (a && a.category !== "team" && a.source === "config" && a.id && a.id !== _lastAgentFetchId) {
			_lastAgentFetchId = a.id;
			agentConfigPromise = fetchAgentConfig(a.id);
		}
	});

	async function handleTeamEditSubmit(data: Record<string, unknown>) {
		if (!agent?.id) return;
		teamEditSubmitting = true;
		teamEditError = "";
		try {
			await updateAgentConfig(agent.id, data as Parameters<typeof updateAgentConfig>[1]);
			refreshAgentConfigs();
			goto("/agents");
		} catch (e) {
			teamEditError = e instanceof Error ? e.message : "Failed to update team";
		} finally {
			teamEditSubmitting = false;
		}
	}

	async function handleAgentEditSubmit(data: Record<string, unknown>) {
		if (!agent?.id) return;
		agentEditSubmitting = true;
		agentEditError = "";
		try {
			await updateAgentConfig(agent.id, data as Parameters<typeof updateAgentConfig>[1]);
			refreshAgentConfigs();
			goto("/agents");
		} catch (e) {
			agentEditError = e instanceof Error ? e.message : "Failed to update agent";
		} finally {
			agentEditSubmitting = false;
		}
	}
	let activeProject = $derived(store.projects.find((p) => p.id === store.activeProjectId));
	let projectDefaults = $derived({
		...(activeProject?.path ? { cwd: activeProject.path } : {}),
		...((activeProject?.variables as Record<string, unknown>) ?? {}),
	});
	let agentRuns = $derived(
		[...store.runs]
			.filter((r) => r.agentName === agentName && r.projectId === store.activeProjectId)
			.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
	);

	async function handleFormRun(input: Record<string, unknown>) {
		if (!agentName) return;
		submitting = true;
		errorMsg = "";
		try {
			const run = await triggerRun(agentName, input, store.activeProjectId);
			goto(`/runs/${run.id}`);
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : "Failed to trigger run";
		} finally {
			submitting = false;
		}
	}

	let testConversations = $state<Conversation[]>([]);
	let testLoading = $state(false);
	let testTesting = $state(false);
	let testError = $state("");
	let clearing = $state(false);

	async function loadTestConversations() {
		if (!agentName) return;
		testLoading = true;
		try {
			testConversations = await fetchTestConversations(agentName);
		} catch {
			testConversations = [];
		}
		testLoading = false;
	}

	async function handleTest() {
		if (!agent?.id) return;
		const projectId = store.activeProjectId;
		if (!projectId || projectId === "global") {
			testError = "Select a project first";
			return;
		}
		testTesting = true;
		testError = "";
		try {
			const conv = await createConversation({
				projectId,
				agentConfigId: agent.id,
				test: true,
				title: `Test: ${agent.name}`,
			});
			goto(`/project/${projectId}/chat/${conv.id}`);
		} catch (e) {
			testError = e instanceof Error ? e.message : "Failed to start test";
		} finally {
			testTesting = false;
		}
	}

	async function handleClearTests() {
		if (!agentName) return;
		clearing = true;
		try {
			await deleteTestConversations(agentName);
			testConversations = [];
		} catch {
			// silent
		}
		clearing = false;
	}

	$effect(() => {
		if (agent?.id) loadTestConversations();
	});

	let chatting = $state(false);
	let chatError = $state("");

	async function handleChat() {
		if (!agent?.id) return;
		const projectId = store.activeProjectId;
		if (!projectId || projectId === "global") {
			chatError = "Select a project first";
			return;
		}
		chatting = true;
		chatError = "";
		try {
			const conv = await createConversation({
				projectId,
				agentConfigId: agent.id,
			});
			goto(`/project/${projectId}/chat/${conv.id}`);
		} catch (e) {
			chatError = e instanceof Error ? e.message : "Failed to start chat";
		} finally {
			chatting = false;
		}
	}

	async function handleRun() {
		errorMsg = "";
		let input: Record<string, unknown>;
		try {
			input = JSON.parse(inputText);
		} catch {
			errorMsg = "Invalid JSON input";
			return;
		}
		await handleFormRun(input);
	}
</script>

{#snippet runAgentContent()}
	{#if agent?.inputSchema || Object.keys(projectDefaults).length > 0}
		<AgentInputForm schema={agent?.inputSchema ?? {}} onsubmit={handleFormRun} {submitting} defaults={projectDefaults} projectVariables={projectDefaults} />
		{#if errorMsg}
			<p class="mt-3 text-sm text-red-400">{errorMsg}</p>
		{/if}
	{:else}
		<label class="mb-2 block text-sm text-[var(--color-text-secondary)]" for="json-input">JSON Input</label>
		<textarea
			id="json-input"
			bind:value={inputText}
			class="mb-3 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
			rows="5"
			placeholder={'{"key": "value"}'}
		></textarea>
		{#if errorMsg}
			<p class="mb-3 text-sm text-red-400">{errorMsg}</p>
		{/if}
		<button
			onclick={handleRun}
			disabled={submitting}
			class="rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50" style="min-height: 44px;"
		>
			{submitting ? "Starting..." : "Run"}
		</button>
	{/if}
{/snippet}

<div class="space-y-6">
	<Breadcrumb items={[{ label: "Agents", href: "/agents" }, { label: agentName ?? "" }]} />
	<div class="hidden md:block">
		<a href="/agents" class="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]">&larr; Back to Agents</a>
	</div>

	{#if agent}
		{#if isTeam}
			<!-- Team edit view -->
			<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-2xl font-bold text-[var(--color-text-primary)]">Edit Team: {agent.name}</h2>
					<div class="flex gap-2">
						<button
							onclick={handleChat}
							disabled={chatting}
							class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
						>
							{chatting ? "Starting..." : "Chat"}
						</button>
					</div>
				</div>
				{#if chatError}
					<p class="mb-3 text-sm text-red-400">{chatError}</p>
				{/if}
				{#if teamDataPromise}
					{#await teamDataPromise}
						<p class="text-sm text-[var(--color-text-muted)]">Loading team configuration...</p>
					{:then [config, configs]}
						<TeamBuilderForm
							initial={config}
							agentConfigs={configs}
							onsubmit={handleTeamEditSubmit}
							submitting={teamEditSubmitting}
						/>
						{#if teamEditError}
							<p class="mt-3 text-sm text-red-400">{teamEditError}</p>
						{/if}
					{:catch}
						<p class="text-sm text-red-400">Failed to load team configuration.</p>
					{/await}
				{/if}
			</div>
		{:else}
			<!-- Regular agent view -->
			<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
				<div class="mb-4 flex items-center justify-between">
					<h2 class="text-2xl font-bold text-[var(--color-text-primary)]">
						{isEditable ? `Edit Agent: ${agent.name}` : agent.name}
					</h2>
					{#if agent.source === "config" && agent.prompt && agent.id}
						<div class="flex gap-2">
							<button
								data-testid="agent-chat-cta"
								onclick={handleChat}
								disabled={chatting}
								class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
							>
								{chatting ? "Starting..." : "Chat"}
							</button>
							<button
								onclick={handleTest}
								disabled={testTesting}
								class="rounded-md bg-amber-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-600 disabled:opacity-50"
							>
								{testTesting ? "Starting..." : "Test"}
							</button>
						</div>
					{/if}
				</div>
				{#if chatError}<p class="mb-3 text-sm text-red-400">{chatError}</p>{/if}
				{#if testError}<p class="mb-3 text-sm text-red-400">{testError}</p>{/if}

				{#if isEditable && agentConfigPromise}
					{#await agentConfigPromise}
						<p class="text-sm text-[var(--color-text-muted)]">Loading agent configuration...</p>
					{:then config}
						<AgentConfigForm
							initial={config as unknown as Record<string, unknown>}
							onsubmit={handleAgentEditSubmit}
							submitting={agentEditSubmitting}
						/>
						{#if agentEditError}
							<p class="mt-3 text-sm text-red-400">{agentEditError}</p>
						{/if}
					{:catch}
						<p class="text-sm text-red-400">Failed to load agent configuration.</p>
					{/await}
				{:else}
					<p class="mb-4 text-[var(--color-text-secondary)]">{agent.description}</p>
					{#if agent.capabilities.length > 0}
						<div class="mb-3 flex flex-wrap gap-1.5">
							{#each agent.capabilities as cap}
								<span class="rounded-md bg-[var(--color-surface-tertiary)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">{cap}</span>
							{/each}
						</div>
					{/if}
					<!-- Pre-populated configuration summary (read-only view) — reads the
					     full AgentConfig (model / provider / temperature / maxTokens /
					     extensions) which are NOT present on the lightweight Agent listing. -->
					{#if agentConfigPromise}
						{#await agentConfigPromise then cfg}
							{#if cfg.provider || cfg.model || cfg.temperature != null || cfg.maxTokens != null || (cfg.extensions && cfg.extensions.length > 0)}
								<dl data-testid="agent-config-summary" class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
									{#if cfg.provider}
										<dt class="text-[var(--color-text-muted)]">Provider</dt>
										<dd class="text-[var(--color-text-secondary)]">{cfg.provider}</dd>
									{/if}
									{#if cfg.model}
										<dt class="text-[var(--color-text-muted)]">Model</dt>
										<dd class="text-[var(--color-text-secondary)]">{cfg.model}</dd>
									{/if}
									{#if cfg.temperature != null}
										<dt class="text-[var(--color-text-muted)]">Temperature</dt>
										<dd class="text-[var(--color-text-secondary)]">{cfg.temperature}</dd>
									{/if}
									{#if cfg.maxTokens != null}
										<dt class="text-[var(--color-text-muted)]">Max tokens</dt>
										<dd class="text-[var(--color-text-secondary)]">{cfg.maxTokens}</dd>
									{/if}
									{#if cfg.extensions && cfg.extensions.length > 0}
										<dt class="text-[var(--color-text-muted)]">Extensions</dt>
										<dd class="text-[var(--color-text-secondary)]">{cfg.extensions.join(", ")}</dd>
									{/if}
								</dl>
							{/if}
						{/await}
					{/if}
				{/if}
			</div>
		{/if}

		{#if !isTeam}
			{#if agent.source === "config" && agent.id && testConversations.length > 0}
				<div class="rounded-lg border border-amber-700/50 bg-[var(--color-surface-secondary)] p-6">
					<div class="mb-3 flex items-center justify-between">
						<h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Test Conversations</h3>
						<button
							onclick={handleClearTests}
							disabled={clearing}
							class="rounded-md bg-red-600/80 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
						>
							{clearing ? "Clearing..." : "Clear All Tests"}
						</button>
					</div>
					<div class="flex flex-col gap-1">
						{#each testConversations as conv (conv.id)}
							<a
								href="/project/{conv.projectId}/chat/{conv.id}"
								class="flex items-center justify-between rounded-md px-3 py-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-tertiary)]"
							>
								<span class="flex items-center gap-2">
									<span class="rounded bg-amber-600/80 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">TEST</span>
									<span class="truncate"><MentionText text={conv.title} /></span>
								</span>
								<span class="text-xs text-[var(--color-text-muted)]">{new Date(conv.createdAt).toLocaleString()}</span>
							</a>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Run Agent: collapsible on mobile, always open on desktop -->
			<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
				<details class="md:hidden" open>
					<summary class="mb-3 text-lg font-semibold text-[var(--color-text-primary)] cursor-pointer list-none flex items-center justify-between">
						Run Agent
						<svg class="h-4 w-4 text-[var(--color-text-muted)] transition-transform details-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
					</summary>
					{@render runAgentContent()}
				</details>
				<div class="hidden md:block">
					<h3 class="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">Run Agent</h3>
					{@render runAgentContent()}
				</div>
			</div>

			{#if agentRuns.length > 0}
				<section>
					<details class="md:hidden" open>
						<summary class="mb-3 text-lg font-semibold text-[var(--color-text-primary)] cursor-pointer list-none flex items-center justify-between">
							Run History
							<svg class="h-4 w-4 text-[var(--color-text-muted)] transition-transform details-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
						</summary>
						<div class="flex flex-col gap-2">
							{#each agentRuns as run (run.id)}
								<RunStatus {run} />
							{/each}
						</div>
					</details>
					<div class="hidden md:block">
						<h3 class="mb-3 text-lg font-semibold text-[var(--color-text-primary)]">Run History</h3>
						<div class="flex flex-col gap-2">
							{#each agentRuns as run (run.id)}
								<RunStatus {run} />
							{/each}
						</div>
					</div>
				</section>
			{/if}
		{/if}
	{:else}
		<div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] p-6">
			<p class="text-[var(--color-text-secondary)]">Agent "{agentName}" not found.</p>
		</div>
	{/if}
</div>
