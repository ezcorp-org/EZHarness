<script lang="ts">
	/**
	 * Chat route shell. Phase 4 of the ChatThread parity refactor: the
	 * thread engine (message tree + composer + handlers + streaming +
	 * branch nav + select-mode + scroll/stream-resume) was extracted into
	 * `<ChatThread>`. This page is now only the route shell — sidebar,
	 * header, side-panels, modes/settings modals, URL sync — and renders
	 * exactly ONE `<ChatThread variant="page">`. The Phase-0 DRY pin
	 * (`ChatThread.behavior.component.test.ts`, `main-chat-parity.spec.ts`,
	 * `messages-ownership-baseline-api.test.ts`) stays green UNCHANGED —
	 * that is the proof there's no behaviour regression and no parallel
	 * reimplementation.
	 */
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import { onMount } from "svelte";
	import {
		fetchModes,
		createConversation,
		updateConversation,
		type Conversation,
		type Mode,
	} from "$lib/api.js";
	import { store, openTeamPanel, type AgentCallState, type TaskPanelTask } from "$lib/stores.svelte.js";
	import { persistLastModel } from "$lib/last-model.js";
	import { attachPanelPersistence } from "$lib/chat/page-handlers/panel-persistence.svelte.js";
	import { decideInheritedMode } from "$lib/chat/page-handlers/inherit-mode.js";
	import ConversationList from "$lib/components/ConversationList.svelte";
	import ProjectRail from "$lib/components/ProjectRail.svelte";
	import ChatThread, { type ChatThreadChrome } from "$lib/components/ChatThread.svelte";
	import ConversationSettings from "$lib/components/ConversationSettings.svelte";
	import ObservabilityPanel from "$lib/components/ObservabilityPanel.svelte";
	import DiffSummaryPanel from "$lib/components/DiffSummaryPanel.svelte";
	import { scrollToToolCall } from "$lib/scroll-to-tool-call";
	import ModeFormModal from "$lib/components/ModeFormModal.svelte";
	import SwipeDrawer from "$lib/components/SwipeDrawer.svelte";
	import AgentDetailPanel from "$lib/components/AgentDetailPanel.svelte";
	import TaskPanel from "$lib/components/TaskPanel.svelte";
	import ExtensionPanel from "$lib/components/ExtensionPanel.svelte";
	import TaskLogsPanel from "$lib/components/TaskLogsPanel.svelte";
	import ChatHeader from "$lib/components/chat/ChatHeader.svelte";
	import type { PermissionMode } from "$lib/permission-mode.js";

	let projectId = $derived(page.params.id!);
	let convId = $derived(page.params.convId!);

	let currentConversation = $state<Conversation | null>(null);
	let availableModes = $state<Mode[]>([]);
	let selectedMode = $state<Mode | null>(null);
	let showCreateModeModal = $state(false);

	// Side-panel open/close state — owned by the shell.
	let settingsOpen = $state(false);
	let obsOpen = $state(false);
	let showObsButton = $state(false);
	let mobileConvListOpen = $state(false);
	let toolsOpen = $state(false);
	let diffPanelOpen = $state(false);
	let taskLogsOpen = $state(false);
	let taskLogsTask = $state<TaskPanelTask | null>(null);
	let selectedAgent = $state<AgentCallState | null>(null);
	let permissionModeOverride = $state<PermissionMode | undefined>(undefined);
	let pendingSelectedAgentSubConvId = $state<string | null>(null);
	let convList: ConversationList | undefined = $state();

	// Task panel (driven by the thread's chrome state).
	let taskSnapshot = $derived(store.taskSnapshots[convId] ?? null);
	let hasAnyTasks = $derived(!!taskSnapshot && taskSnapshot.tasks.length > 0);

	attachPanelPersistence({
		convId: () => convId,
		searchParams: () => page.url.searchParams,
		settingsOpen: { get: () => settingsOpen, set: (v) => { settingsOpen = v; } },
		obsOpen: { get: () => obsOpen, set: (v) => { obsOpen = v; } },
		diffPanelOpen: { get: () => diffPanelOpen, set: (v) => { diffPanelOpen = v; } },
		toolsOpen: { get: () => toolsOpen, set: (v) => { toolsOpen = v; } },
		taskLogsOpen: { get: () => taskLogsOpen, set: (v) => { taskLogsOpen = v; } },
		taskLogsTask: { get: () => taskLogsTask, set: (v) => { taskLogsTask = v; } },
		agentDetailId: {
			get: () => pendingSelectedAgentSubConvId,
			set: (v) => { pendingSelectedAgentSubConvId = v; },
		},
		selectedAgent: { get: () => selectedAgent, set: (v) => { selectedAgent = v; } },
		taskSnapshot: () => taskSnapshot ?? null,
		subConversations: () => [],
		assignmentForSubConvo: () => undefined,
		streamingAgentCalls: () => store.streamingAgentCalls,
		onConvSwitch: () => {},
	});

	// Persist last-opened chat per project so /project/[id]/chat (the
	// index) can redirect back to the conversation the user actually had
	// open, instead of falling through to "most recent". Without this the
	// index's `ezcorp-last-chat:<projectId>` lookup is always a miss.
	$effect(() => {
		if (projectId && convId && typeof localStorage !== "undefined") {
			localStorage.setItem(`ezcorp-last-chat:${projectId}`, convId);
		}
	});

	async function checkObsEnabled() {
		try {
			const res = await fetch("/api/settings/global:showObservability");
			if (res.ok) {
				const data = await res.json();
				showObsButton = data.value === true;
			}
		} catch {
			// silent
		}
	}

	onMount(() => {
		// `?initial` (queued first message) is consumed by <ChatThread>
		// itself — it reads/strips the param on mount.
		checkObsEnabled();
		fetchModes()
			.then((m) => {
				availableModes = m;
			})
			.catch(() => {});
	});

	function handleModelChange(provider: string, model: string) {
		persistLastModel(
			typeof localStorage !== "undefined" ? localStorage : null,
			{ provider, model },
		);
		if (convId) {
			updateConversation(convId, { model, provider }).catch(() => {});
		}
	}

	function handleModeChange(mode: Mode | null) {
		selectedMode = mode;
		lastSyncedModeConvId = convId;
		updateConversation(convId, { modeId: mode?.id ?? null }).catch(() => {});
	}

	// First-paint mode inheritance for the composer Tools popover. The pure
	// decision (when + what to inherit, last-synced bookkeeping) lives in
	// `decideInheritedMode`; this effect just applies it. Navigating between
	// conversations re-inherits, but an explicit mid-session `handleModeChange`
	// (which stamps `lastSyncedModeConvId`) is never clobbered.
	let lastSyncedModeConvId = $state<string | null>(null);
	$effect(() => {
		const decision = decideInheritedMode({
			currentConversation,
			availableModes,
			convId,
			lastSyncedConvId: lastSyncedModeConvId,
		});
		if (!decision.sync) return;
		lastSyncedModeConvId = decision.syncedConvId;
		selectedMode = decision.mode;
	});

	async function handleCreate() {
		try {
			const conv = await createConversation({ projectId });
			goto(`/project/${projectId}/chat/${conv.id}`);
		} catch (err) {
			console.error("Failed to create conversation:", err);
		}
	}

	function handleSelect(id: string, messageId?: string) {
		// Sidebar search results forward the matched messageId so the thread
		// can deep-link (scroll + pulse) to it via `?m=`. A plain
		// title-row select passes no messageId → no stray `?m=` is appended.
		const base = `/project/${projectId}/chat/${id}`;
		goto(messageId ? `${base}?m=${encodeURIComponent(messageId)}` : base);
	}

	async function handleSaveSystemPrompt(systemPrompt: string) {
		if (!convId) return;
		try {
			currentConversation = await updateConversation(convId, {
				systemPrompt,
			});
			settingsOpen = false;
		} catch (err) {
			console.error("Failed to save system prompt:", err);
		}
	}
</script>

<div class="absolute inset-0 flex">
	<!-- Desktop conversation list -->
	<div class="hidden md:flex">
		<ConversationList
			bind:this={convList}
			{projectId}
			activeConversationId={convId}
			oncreate={handleCreate}
			onselect={handleSelect}
		/>
	</div>

	<!-- Mobile conversation list overlay -->
	<SwipeDrawer
		open={mobileConvListOpen}
		side="left"
		width="w-[calc(72px+14rem)]"
		maxWidth="max-w-[85vw]"
		onclose={() => (mobileConvListOpen = false)}
		ariaLabel="Conversation list"
	>
		<div class="flex h-full">
			<ProjectRail />
			<div
				class="flex flex-1 min-w-0 flex-col bg-[var(--color-surface-secondary)]"
			>
				<div
					class="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-2"
				>
					<button
						onclick={() => {
							mobileConvListOpen = false;
							store.mobileMenuOpen = true;
						}}
						class="flex items-center justify-center rounded-md p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
						aria-label="Back to project menu"
						style="min-width: 44px; min-height: 44px;"
					>
						<svg
							class="h-5 w-5"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M15 19l-7-7 7-7"
							/>
						</svg>
					</button>
					<span
						class="text-sm font-medium text-[var(--color-text-secondary)]"
						>Chats</span
					>
				</div>
				<ConversationList
					{projectId}
					activeConversationId={convId}
					oncreate={() => {
						mobileConvListOpen = false;
						handleCreate();
					}}
					onselect={(id: string, messageId?: string) => {
						mobileConvListOpen = false;
						handleSelect(id, messageId);
					}}
				/>
			</div>
		</div>
	</SwipeDrawer>

	<ChatThread
		conversationId={convId}
		{projectId}
		variant="page"
		persistModel={handleModelChange}
		{currentConversation}
		{availableModes}
		{selectedMode}
		oncurrentconversation={(conv) => {
			currentConversation = conv;
		}}
		onmodechange={handleModeChange}
		onmodecreate={() => {
			showCreateModeModal = true;
		}}
		onagentclick={(agent) => {
			selectedAgent = agent;
		}}
		onopenobservability={() => {
			obsOpen = true;
		}}
		convListRefresh={() => convList?.refresh?.()}
	>
		{#snippet header(chrome: ChatThreadChrome)}
			<ChatHeader
				{projectId}
				{convId}
				{currentConversation}
				lastTurnInputTokens={chrome.lastTurnInputTokens}
				selectedModelContextWindow={chrome.selectedModelContextWindow}
				contextBreakdown={chrome.contextBreakdown}
				contextToolBreakdown={chrome.contextToolBreakdown}
				loadedTools={chrome.loadedTools}
				{toolsOpen}
				{diffPanelOpen}
				diffFileCount={chrome.diffFileCount}
				activeLeafId={chrome.activeLeafId}
				{showObsButton}
				{obsOpen}
				selectMode={chrome.selectMode}
				isStreaming={chrome.isStreaming}
				topics={chrome.topics}
				onmobilemenu={() => (mobileConvListOpen = true)}
				ontoolstoggle={(next) => (toolsOpen = next)}
				ondifftoggle={() => (diffPanelOpen = !diffPanelOpen)}
				onobstoggle={() => (obsOpen = !obsOpen)}
				onselecttoggle={chrome.toggleSelectMode}
				onsettingstoggle={() => (settingsOpen = true)}
				onpermissionmodechange={(mode) => {
					permissionModeOverride = mode;
					chrome.setPermissionMode(mode);
				}}
				oncallclick={scrollToToolCall}
				onrename={async (title) => {
					if (!currentConversation) return;
					const updated = await updateConversation(convId, { title });
					currentConversation = updated;
				}}
			/>
		{/snippet}

		{#snippet chrome_panels(chrome: ChatThreadChrome)}
			{#if hasAnyTasks && taskSnapshot}
				<TaskPanel
					snapshot={taskSnapshot}
					conversationId={convId}
					selectedModel={chrome.selectedModel}
					onsendmessage={() => {}}
					ontaskclick={(task) => {
						taskLogsTask = task;
						taskLogsOpen = true;
					}}
					onteamclick={(id, name) => openTeamPanel(convId, id, name)}
				/>
			{/if}

			{#each Object.entries(store.extensionPanelStates) as [extId, panelData] (extId)}
				<ExtensionPanel
					extensionId={extId}
					extensionName={panelData.extensionName}
					conversationId={convId}
					state={panelData.state}
				/>
			{/each}

			<DiffSummaryPanel
				messages={chrome.messages}
				toolCalls={chrome.diffPanelToolCalls}
				open={diffPanelOpen}
				onclose={() => (diffPanelOpen = false)}
				streaming={chrome.isStreaming}
			/>
		{/snippet}
	</ChatThread>

	{#if currentConversation}
		<ConversationSettings
			conversation={currentConversation}
			{projectId}
			open={settingsOpen}
			onclose={() => (settingsOpen = false)}
			onsave={handleSaveSystemPrompt}
		/>
	{/if}

	<ObservabilityPanel
		conversationId={convId}
		open={obsOpen}
		onclose={() => (obsOpen = false)}
		{taskSnapshot}
	/>

	{#if selectedAgent}
		<AgentDetailPanel
			agent={selectedAgent}
			open={!!selectedAgent}
			onclose={() => {
				selectedAgent = null;
			}}
		/>
	{/if}

	{#if taskLogsTask}
		<TaskLogsPanel
			task={taskLogsTask}
			conversationId={convId}
			open={taskLogsOpen}
			onclose={() => {
				taskLogsOpen = false;
				taskLogsTask = null;
			}}
		/>
	{/if}

	<ModeFormModal
		open={showCreateModeModal}
		onclose={() => {
			showCreateModeModal = false;
		}}
		onsaved={(mode) => {
			availableModes = [...availableModes, mode];
			selectedMode = mode;
			showCreateModeModal = false;
			updateConversation(convId, { modeId: mode.id }).catch(() => {});
		}}
	/>
</div>
