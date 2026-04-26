<script lang="ts">
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import { onMount, untrack, tick } from "svelte";
	import {
		fetchAllMessages,
		fetchModes,
		createConversation,
		updateConversation,
		patchMessageContent,
		setMessageExcluded,
		type Message,
		type Conversation,
		type Mode,
	} from "$lib/api.js";
	import {
		store,
		stopStreaming,
		getStreamingToolCalls,
		getStreamingContentBlocks,
		getStreamingAgentCalls,
		getTaskSnapshot,
		setTaskSnapshot,
		getWsReconnectCount,
		openTeamPanel,
		type AgentCallState,
		type AssignmentStatus,
		type TaskPanelTask,
	} from "$lib/stores.svelte.js";
	import { buildHistoricalBlocks } from "$lib/content-blocks.js";
	import {
		subConvoToAgentCallState,
		type SubConvoRecord,
	} from "$lib/sub-convo-agent-state.js";
	import { listenForOAuthResult, type OAuthPending } from "$lib/oauth.js";
	import { persistLastModel } from "$lib/last-model.js";
	import { attachPanelPersistence } from "$lib/chat/page-handlers/panel-persistence.svelte.js";
	import {
		INITIAL_MESSAGE_WINDOW,
		MESSAGE_LOAD_STEP,
		computeVisibleMessages,
		hasOlderMessages as computeHasOlder,
		nextWindowSize,
		anchorScrollTop,
	} from "$lib/message-window.js";
	import { unreadStore } from "$lib/unread.js";
	import {
		decideOpenScroll,
		getCachedScrollState,
		updateCachedScrollState,
	} from "$lib/chat-scroll-restore.js";
	import ConversationList from "$lib/components/ConversationList.svelte";
	import ChatMessage from "$lib/components/ChatMessage.svelte";
	import ChatInput from "$lib/components/ChatInput.svelte";
	import { shouldHandleChatWindowDragOver, filesFromChatWindowDrop } from "$lib/chat/chat-window-drop";
	import ConversationSettings from "$lib/components/ConversationSettings.svelte";
	import ExportMenu from "$lib/components/ExportMenu.svelte";
	import ObservabilityPanel from "$lib/components/ObservabilityPanel.svelte";
	import DiffSummaryPanel from "$lib/components/DiffSummaryPanel.svelte";
	import { aggregateToolCallDiffs } from "$lib/diff-aggregator.js";
	import InlineToolCard from "$lib/components/InlineToolCard.svelte";
	import MentionText from "$lib/components/MentionText.svelte";
	import InlineToolForm from "$lib/components/InlineToolForm.svelte";
	import PermissionModeIndicator from "$lib/components/PermissionModeIndicator.svelte";
	import ContextUsageIndicator from "$lib/components/ContextUsageIndicator.svelte";
	import { scrollToToolCall } from "$lib/scroll-to-tool-call";
	import {
		computeBreakdown,
		computeToolBreakdown,
		estimateToolCallTokens,
		pickLastTurnUsage,
	} from "$lib/context-usage-logic";
	import ModeFormModal from "$lib/components/ModeFormModal.svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import Tooltip from "$lib/components/Tooltip.svelte";
	import { inlineToolStore, type InlineToolCall } from "$lib/inline-tool-store.svelte.js";
	import type { PermissionMode } from "$lib/permission-mode.js";
	import { subConversationStore } from "$lib/sub-conversation-store.svelte.js";
	import SubConversationBlock from "$lib/components/SubConversationBlock.svelte";
	import SwipeDrawer from "$lib/components/SwipeDrawer.svelte";
	import AgentDetailPanel from "$lib/components/AgentDetailPanel.svelte";
	import TaskPanel from "$lib/components/TaskPanel.svelte";
	import ExtensionPanel from "$lib/components/ExtensionPanel.svelte";
	import TaskLogsPanel from "$lib/components/TaskLogsPanel.svelte";
	import StuckRunBanner from "$lib/components/StuckRunBanner.svelte";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";
	import ChatHeader from "$lib/components/chat/ChatHeader.svelte";
	import SelectModeActionBar from "$lib/components/chat/SelectModeActionBar.svelte";
	import { makeInlineToolHandlers } from "$lib/chat/page-handlers/inline-tool-handlers.js";
	import {
		makeLoadMessages,
		findLeafByMessageId,
		computeLatestLeaf,
		type HistoricalToolCall,
	} from "$lib/chat/page-handlers/load-messages.js";
	import { useSelectMode } from "$lib/chat/page-handlers/useSelectMode.svelte.js";
	import { makeSendMessage } from "$lib/chat/page-handlers/send-message.js";
	import { attachStreamResume } from "$lib/chat/page-handlers/stream-resume.svelte.js";
	import { shouldAutofocusComposer } from "$lib/chat-input-logic.js";
	import {
		backgroundFetch,
		userFetch,
		invalidate as invalidateFetchPolicy,
	} from "$lib/utils/fetch-policy.js";
	import type { ToolDefinition } from '../../../../../../src/extensions/types';

	// Historical tool call tracking. `HistoricalToolCall` is imported from
	// `$lib/chat/page-handlers/load-messages.js` (W5) — the hydration step
	// owns the type since it's the writer.
	let historicalToolCalls = $state<HistoricalToolCall[]>([]);
	let historicalByMessage = $derived(
		historicalToolCalls.reduce((map, tc) => {
			const arr = map.get(tc.messageId) ?? [];
			arr.push(tc);
			map.set(tc.messageId, arr);
			return map;
		}, new Map<string, HistoricalToolCall[]>())
	);

	// Saved memories: messageId → memoryId
	let savedMemories = $state(new Map<string, string>());

	// Sub-conversation state (type imported from $lib/sub-convo-agent-state.js)
	let subConversations = $state<SubConvoRecord[]>([]);
	let subConvoByMessage = $derived(new Map(subConversations.map(sc => [sc.parentMessageId, sc])));
	// Filter: user-initiated sub-convos (no agentConfigId) show as SubConversationBlock
	// Agent-spawned sub-convos (with agentConfigId) show as AgentChip instead
	let userSubConvoByMessage = $derived(
		new Map([...subConvoByMessage].filter(([, sc]) => !sc.agentConfigId))
	);

	// Multi-agent orchestration state
	let selectedAgent = $state<AgentCallState | null>(null);

	// All agent sub-conversations (with agentConfigId) for this conversation
	let agentSubConvos = $derived(subConversations.filter(sc => sc.agentConfigId));

	// Build a lookup from subConversationId → assignment status using the task snapshot
	let assignmentBySubConvo = $derived.by(() => {
		const map = new Map<string, { status: AssignmentStatus; resultPreview?: string }>();
		if (!taskSnapshot) return map;
		for (const task of taskSnapshot.tasks) {
			for (const a of task.assignments ?? []) {
				if (a.subConversationId) {
					map.set(a.subConversationId, { status: a.status, resultPreview: a.resultPreview });
				}
			}
		}
		return map;
	});

	function getHistoricalAgentCalls(messageId: string): AgentCallState[] | undefined {
		if (agentSubConvos.length === 0) return undefined;
		// Match agents anchored to this message OR to its parent (user message)
		// Auto-spin-up links sub-conversations to the user message, but we render on the assistant message
		const msg = allMessages.find(m => m.id === messageId);
		const parentMsgId = msg?.parentMessageId;
		const matched = agentSubConvos.filter(sc =>
			sc.parentMessageId === messageId || (parentMsgId && sc.parentMessageId === parentMsgId)
		);
		if (matched.length === 0) return undefined;

		return matched.map(sc => subConvoToAgentCallState(sc, assignmentBySubConvo.get(sc.id)));
	}

	let settingsOpen = $state(false);
	// Inline "Edit text" state for seeded assistant turns (content-only PATCH).
	let editTextMessageId = $state<string | null>(null);
	let editTextDraft = $state("");
	let editTextSaving = $state(false);
	let obsOpen = $state(false);
	let showObsButton = $state(false);
	let mobileConvListOpen = $state(false);

	// Tool visibility state
	let loadedTools = $state<Array<{ name: string; description: string; extension: string; extensionType?: string; tokenEstimate?: number }>>([]);
	let toolsOpen = $state(false);
	let diffPanelOpen = $state(false);
	let taskLogsOpen = $state(false);
	let taskLogsTask = $state<TaskPanelTask | null>(null);
	let toolsByExtension = $derived(
		loadedTools.reduce((map, t) => {
			const arr = map.get(t.extension) ?? [];
			arr.push(t);
			map.set(t.extension, arr);
			return map;
		}, new Map<string, typeof loadedTools>())
	);
	let extensionTypeMap = $derived(
		new Map(loadedTools.map(t => [t.extension, t.extensionType ?? "extension"]))
	);

	// Inline tool state
	let editRetryCall = $state<InlineToolCall | null>(null);
	let editRetryTool = $state<ToolDefinition | null>(null);

	// Session permission mode override (set via PermissionModeIndicator)
	let permissionModeOverride = $state<PermissionMode | undefined>(undefined);

	// Derive inline tool calls for this conversation
	let inlineCalls = $derived(inlineToolStore.calls.filter(c => c.conversationId === convId));

	// Tool calls shown in the Diff Summary panel — union of parent + all
	// sub-conversations so edits made by team members / invoked agents are
	// visible alongside the parent's edits. Sub conversations are hydrated
	// by hydrateToolCallsFromApi(); the store keys each call by its own
	// conversationId, so the union is a straight concatenation.
	let diffPanelToolCalls = $derived.by(() => {
		const ids = [convId, ...subConversations.map((sc) => sc.id)];
		return ids.flatMap((id) => inlineToolStore.getByConversation(id));
	});

	// Count of files modified (for diff badge) — uses the same expanded set
	// as the panel so the badge and the panel stay in sync.
	let diffFileCount = $derived.by(() => {
		const completed = diffPanelToolCalls.filter(tc => tc.status === 'complete');
		return aggregateToolCallDiffs(
			completed.map(tc => ({ toolName: tc.toolName, input: tc.input, output: tc.output }))
		).length;
	});

	// Inline tool handlers are extracted to $lib/chat/page-handlers/inline-tool-handlers.ts.
	// `convId` and `activeLeafId` are passed as getters because they're reactive
	// (a $derived and a $state slot respectively) and must be read fresh on
	// every invocation. The edit-retry slot is mediated through get/set so the
	// handler module never holds a stale snapshot of the page's $state.
	const inlineToolHandlers = makeInlineToolHandlers({
		convId: () => convId,
		activeLeafId: () => activeLeafId,
		getEditRetry: () => ({ call: editRetryCall, tool: editRetryTool }),
		setEditRetry: (call, tool) => {
			editRetryCall = call;
			editRetryTool = tool;
		},
	});
	const handleToolInvoke = inlineToolHandlers.handleToolInvoke;
	const handleInlineRetry = inlineToolHandlers.handleInlineRetry;
	const handleInlineEditRetry = inlineToolHandlers.handleInlineEditRetry;
	const handleEditRetryConfirm = inlineToolHandlers.handleEditRetryConfirm;
	const handleInlineCancel = inlineToolHandlers.handleInlineCancel;

	// Local-only system messages (not persisted) for /login commands and OAuth results
	let localSystemMessages = $state<Message[]>([]);

	// OAuth code-paste flow state for /login command
	let chatOAuthPending = $state<OAuthPending | null>(null);

	// Memory unavailable warning (shown once per failure run)
	let shownMemoryWarningForRun = $state<string | null>(null);
	$effect(() => {
		const failedRunId = store.memoryUnavailableRunId;
		if (failedRunId && failedRunId !== shownMemoryWarningForRun) {
			shownMemoryWarningForRun = failedRunId;
			addSystemMessage("Memory is currently unavailable. Responses won't include past context.");
		}
	});

	// Check if observability display is enabled
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
	let currentConversation = $state<Conversation | null>(null);

	let projectId = $derived(page.params.id!);
	let currentProject = $derived(store.projects.find(p => p.id === projectId));
	let sharedValues = $derived<Record<string, string>>({
		'project.cwd': currentProject?.path ?? '',
		'project.name': currentProject?.name ?? '',
	});
	let convId = $derived(page.params.convId!);

	// Task panel state (updated via task:snapshot WS events).
	// Panel stays visible as long as any task exists in the conversation —
	// completed and failed tasks remain on screen forever, never auto-hidden.
	let taskSnapshot = $derived(getTaskSnapshot(convId));
	let hasAnyTasks = $derived(!!taskSnapshot && taskSnapshot.tasks.length > 0);

	// Load persisted task snapshot on conversation change or WS reconnect.
	// Re-fetches on reconnect to pick up assignment status changes (e.g. "running")
	// that may have been missed during the brief WS disconnect window.
	$effect(() => {
		const cid = convId;
		const _reconnect = getWsReconnectCount(); // reactive dependency — re-fetch on WS reconnect
		if (!cid) return;
		// Throttled: even if the WS flaps 20x in a row, at most one /tasks
		// call per 5s lands. Mirrors the semantic-key throttle used for the
		// other conversation endpoints (see web/src/lib/utils/fetch-policy.ts).
		backgroundFetch(`tasks:${cid}`, `/api/conversations/${cid}/tasks`, {}, { minIntervalMs: 5000 })
			.then((r) => (r && r.ok ? r.json() : null))
			.then((data) => {
				if (data && Array.isArray(data.tasks) && data.tasks.length > 0) {
					setTaskSnapshot(data);
				}
			})
			.catch(() => {});
	});

	// Persist last-opened chat per project so /chat can restore it
	$effect(() => {
		if (projectId && convId) {
			localStorage.setItem(`ezcorp-last-chat:${projectId}`, convId);
		}
	});

	// ── Select Mode ──
	// All select-mode state and handlers live in the rune-host
	// `$lib/chat/page-handlers/useSelectMode.svelte.ts`. The page accesses
	// the slots via `selectMode.state.*` / `selectMode.derived.*` and the
	// handlers directly off `selectMode`. Conversation-switch reset is
	// invoked from the panel-persistence `onConvSwitch` hook below.
	const selectMode = useSelectMode({
		convId: () => convId,
		projectId: () => projectId,
		allMessages: { get: () => allMessages, set: (v) => { allMessages = v; } },
		visibleMessages: () => visibleMessages,
		savedMemories: { get: () => savedMemories, set: (v) => { savedMemories = v; } },
		isStreaming: () => isStreaming,
		getHistoricalToolCalls: (id) => getHistoricalToolCalls(id),
	});

	// ── Side-panel state persistence ──
	// Three reactive effects (restore on convId change / resolve pending
	// agent / persist on slot change) live in the rune-host module so the
	// page only owns the `$state` slots and a single attach call. See
	// `$lib/chat/page-handlers/panel-persistence.svelte.ts`.
	let pendingSelectedAgentSubConvId = $state<string | null>(null);
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
		subConversations: () => subConversations,
		assignmentForSubConvo: (id) => assignmentBySubConvo.get(id),
		streamingAgentCalls: () => store.streamingAgentCalls,
		onConvSwitch: () => {
			// Selection is per-conversation by definition — never carries across switches.
			selectMode.resetForConvSwitch();
		},
	});

	// Branch-aware state
	let allMessages = $state<Message[]>([]);
	let activeLeafId = $state<string | null>(null);
	let editingMessageId = $state<string | null>(null);
	let editContent = $state("");

	let selectedModel = $state<{ provider: string; model: string } | null>(null);
	let thinkingLevel = $state<string>(
		typeof localStorage !== "undefined" ? (localStorage.getItem("ezcorp-thinking-level") ?? "medium") : "medium",
	);
	let modelSupportsReasoning = $state(false);
	let selectedModelContextWindow = $state<number | null>(null);
	let availableModes = $state<Mode[]>([]);
	let selectedMode = $state<Mode | null>(null);
	let showCreateModeModal = $state(false);
	let activeRunId = $state<string | null>(null);
	// Server-reported wall-clock start of the active run. Populated by checkActiveRun / handleSend
	// and used to drive elapsed counters (in ChatMessage) and the StuckRunBanner.
	let activeRunStartedAt = $state<number | null>(null);
	// Server-reported staleness in ms (time since last heartbeat write). Refreshed by the
	// zombieTimer on each /active-run poll. null when there's no active run.
	let serverStalenessMs = $state<number | null>(null);
	let error = $state<string | null>(null);
	let convList: ConversationList | undefined = $state();
	let chatInput: ChatInput | undefined = $state();

	// Auto-scroll
	let container: HTMLDivElement | undefined = $state();
	let sentinel: HTMLDivElement | undefined = $state();
	let checkingActiveRun = $state(false);
	let initialLoadDone = $state(false);
	// Generation counter: incremented on each convId change to discard stale async callbacks
	let loadGeneration = $state(0);
	// True when streaming was resumed via checkActiveRun (vs started fresh via handleSend)
	let resumedRun = $state(false);
	let userScrolledUp = $state(false);
	let observer: IntersectionObserver | undefined;

	let isStreaming = $derived(activeRunId !== null && (store.streamingMessages[activeRunId] !== undefined || store.streamingStatus[activeRunId] !== undefined));

	let currentStreamingText = $derived(
		activeRunId ? store.streamingMessages[activeRunId] : undefined,
	);

	let currentStreamingStatus = $derived(
		activeRunId ? store.streamingStatus[activeRunId] : undefined,
	);


	// Derive sibling map: parentMessageId -> children sorted by createdAt
	let siblingMap = $derived.by(() => {
		const map = new Map<string, { id: string; createdAt: string }[]>();
		for (const msg of allMessages) {
			const parentKey = msg.parentMessageId ?? "__root__";
			const list = map.get(parentKey) ?? [];
			list.push({ id: msg.id, createdAt: msg.createdAt });
			map.set(parentKey, list);
		}
		// Sort each group by createdAt
		for (const list of map.values()) {
			list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		}
		return map;
	});

	// Derive displayed messages by walking from activeLeafId to root
	let messages = $derived.by(() => {
		if (!activeLeafId) return [];
		const msgMap = new Map(allMessages.map((m) => [m.id, m]));
		const path: Message[] = [];
		let current = msgMap.get(activeLeafId);
		const visited = new Set<string>();
		while (current && !visited.has(current.id)) {
			visited.add(current.id);
			path.unshift(current);
			current = current.parentMessageId ? msgMap.get(current.parentMessageId) : undefined;
		}
		return path;
	});

	// Message-window pagination: render only the last `visibleMessageCount`
	// messages of the active path, with a sentinel at the top to load older
	// ones on scroll-up. Branching + tool-call hydration still operate on the
	// full `allMessages` tree, so sibling nav / historical tool cards keep
	// working for messages that aren't yet in the window.
	let visibleMessageCount = $state(INITIAL_MESSAGE_WINDOW);
	let topSentinel = $state<HTMLDivElement | undefined>();
	let loadingOlder = $state(false);

	let visibleMessages = $derived(computeVisibleMessages(messages, visibleMessageCount));
	let hasOlderMessages = $derived(computeHasOlder(messages.length, visibleMessageCount));

	const PROVIDER_DISPLAY: Record<string, string> = {
		openai: "OpenAI",
		google: "Google Gemini",
		anthropic: "Anthropic",
	};

	/**
	 * Build a client-side `Message` object for optimistic UI updates and
	 * streaming placeholders. Centralizing the defaults here means new fields
	 * on the `Message` interface only need a single update — call sites stay
	 * focused on what's *different* about each message they're constructing.
	 *
	 * `conversationId` is required via overrides because every call site has
	 * a non-null `convId` in scope; threading it through the helper would
	 * either capture a stale value (if convId becomes reactive later) or
	 * force every call site to handle the `convId ?? ""` fallback.
	 */
	function makeOptimisticMessage(
		overrides: Partial<Message> & Pick<Message, "conversationId">,
	): Message {
		return {
			id: "",
			role: "user",
			content: "",
			thinkingContent: null,
			model: null,
			provider: null,
			usage: null,
			runId: null,
			parentMessageId: null,
			excluded: false,
			createdAt: new Date().toISOString(),
			...overrides,
		};
	}

	function addSystemMessage(content: string): void {
		localSystemMessages = [
			...localSystemMessages,
			makeOptimisticMessage({
				id: `system-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				conversationId: convId,
				role: "system",
				content,
				parentMessageId: activeLeafId,
			}),
		];
	}

	let lastMessageIsUser = $derived(messages.length > 0 && messages[messages.length - 1]?.role === "user");

	// Context usage: input tokens from the most recent assistant message on the active branch.
	// Represents what fit in the prompt last turn — null until the first assistant reply lands.
	let lastTurnUsage = $derived(pickLastTurnUsage(messages));
	let lastTurnInputTokens = $derived(lastTurnUsage?.inputTokens ?? null);
	let contextBreakdown = $derived(
		computeBreakdown(
			lastTurnUsage?.inputTokens ?? null,
			lastTurnUsage?.outputTokens ?? null,
			estimateToolCallTokens(inlineCalls),
		),
	);
	let contextToolBreakdown = $derived(
		computeToolBreakdown(inlineCalls, contextBreakdown?.totalTokens ?? 0),
	);


	// Memory injection dedup: the backend re-runs hybrid search every turn, so `memoriesUsed`
	// gets populated on every assistant message even when the retrieved set didn't change.
	// To mirror how memories are actually injected (once, then held in context until the set
	// changes), we only surface the MemoriesCard on assistant messages whose memory-id set
	// *differs* from the previous assistant message's set. An empty/absent set resets the
	// comparison — a later turn that retrieves memories again counts as a fresh injection.
	let memoryCardVisibleMessageIds = $derived.by(() => {
		const visible = new Set<string>();
		let prevKey: string | null = null;
		for (const msg of messages) {
			if (msg.role !== "assistant") continue;
			const mems = msg.memoriesUsed;
			if (!mems || mems.length === 0) {
				prevKey = null;
				continue;
			}
			const key = mems.map(m => m.id).sort().join(",");
			if (key !== prevKey) {
				visible.add(msg.id);
				prevKey = key;
			}
		}
		return visible;
	});

	// Stream-resume orchestration (checkActiveRun, WS-reconnect resume effect,
	// zombie/staleness watchdog) lives in
	// $lib/chat/page-handlers/stream-resume.svelte.ts (W9). The page provides
	// the host below; the module owns the timer effects and the module-scoped
	// reconnect cooldown timestamp. The `checkActiveRun` returned here is
	// called from the convId-change effect AFTER loadMessages settles so
	// the resumed stream attaches at the correct leaf.
	const streamResumeApi = attachStreamResume({
		convId: () => convId,
		loadGeneration: () => loadGeneration,
		initialLoadDone: () => initialLoadDone,
		selectedModel: () => selectedModel,
		activeRunId: { get: () => activeRunId, set: (v) => { activeRunId = v; } },
		activeRunStartedAt: { get: () => activeRunStartedAt, set: (v) => { activeRunStartedAt = v; } },
		serverStalenessMs: { get: () => serverStalenessMs, set: (v) => { serverStalenessMs = v; } },
		resumedRun: { get: () => resumedRun, set: (v) => { resumedRun = v; } },
		checkingActiveRun: { get: () => checkingActiveRun, set: (v) => { checkingActiveRun = v; } },
		allMessages: { get: () => allMessages, set: (v) => { allMessages = v; } },
		activeLeafId: { get: () => activeLeafId, set: (v) => { activeLeafId = v; } },
		loadMessages: () => loadMessages(),
		makeOptimisticMessage,
		currentStreamingText: () => currentStreamingText,
		isStreaming: () => isStreaming,
	});
	const checkActiveRun = streamResumeApi.checkActiveRun;

	let pendingInitial = $state<string | null>(null);
	let initialApplied = false;

	$effect(() => {
		if (!pendingInitial || initialApplied) return;
		if (!convId) return;
		if (!selectedModel) return;
		if (isStreaming) return;
		const text = pendingInitial;
		initialApplied = true;
		pendingInitial = null;
		handleSend(text);
	});

	onMount(() => {
		const initialParam = page.url.searchParams.get("initial");
		if (initialParam && initialParam.length > 0) {
			pendingInitial = initialParam;
			goto(page.url.pathname, { replaceState: true, noScroll: true });
		}

		checkObsEnabled();
		fetch('/api/tools').then(r => r.ok ? r.json() : null).then(d => { if (d) loadedTools = d.tools; });
		fetchModes().then(m => { availableModes = m; }).catch(() => {});

		const cleanupOAuth = listenForOAuthResult((result) => {
			if (result.success) {
				addSystemMessage(`${PROVIDER_DISPLAY[result.provider] ?? result.provider} connected successfully!`);
			} else {
				addSystemMessage(`Failed to connect ${PROVIDER_DISPLAY[result.provider] ?? result.provider}: ${result.error ?? "unknown error"}`);
			}
		});

		// Pre-warm embedding model on page load so it's ready when user sends a message
		fetch('/api/warmup', { method: 'POST' }).catch(() => {});

		// Per-turn streaming: swap streaming placeholder with persisted turn message
		const handleTurnSaved = (e: Event) => {
			const { runId, conversationId: evtConvId, messageId, parentMessageId, content } = (e as CustomEvent).detail;
			if (evtConvId !== convId || runId !== activeRunId) return;

			// Replace streaming placeholder with the real persisted message
			const realMsg = makeOptimisticMessage({
				id: messageId,
				conversationId: convId,
				role: "assistant",
				content,
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				runId,
				parentMessageId,
			});
			allMessages = allMessages.filter(m => m.id !== `streaming-${runId}`);
			allMessages = [...allMessages, realMsg];

			// Create new streaming placeholder for the next turn, chained to this one
			const nextPlaceholder = makeOptimisticMessage({
				id: `streaming-${runId}`,
				conversationId: convId,
				role: "assistant",
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				runId,
				parentMessageId: messageId,
			});
			allMessages = [...allMessages, nextPlaceholder];
			activeLeafId = nextPlaceholder.id;

			// NOTE: we intentionally do NOT re-hydrate on every turn_saved event.
			// Before the push-path refactor we had to refetch here to pick up
			// newly persisted tool calls. Now `tool:complete` events upsert into
			// `inlineToolStore` in real time (see stores.svelte.ts), so a per-turn
			// refetch is redundant AND damaging — during a long orchestrator run
			// with many turns, it was spamming `GET /api/conversations/:id/messages?withToolCalls=true`
			// (which now also carries all sub-conversation tool calls, i.e. a big
			// payload) once per turn and freezing the UI / scroll.
			// Hydration still runs on initial page load (loadMessages) and on
			// run completion (reconcileAfterStream) — both infrequent.
		};
		window.addEventListener("ez:turn_saved", handleTurnSaved);

		// Live updates from sub-agent edits flow through the push-based
		// tool:complete → inlineToolStore.upsertStreaming path in
		// stores.svelte.ts — the Diff Summary panel re-renders via the
		// `diffPanelToolCalls` derived whenever the store changes. No
		// custom DOM-event subscription needed here.

		// Re-hydrate when a sub-agent completes (e.g. after user chats
		// with an agent via the team panel). The fetch-policy throttles
		// background reads to a 5s minimum interval, so we MUST invalidate
		// the relevant cooldown keys first — otherwise a private chat that
		// completes within 5s of page load gets silently throttled and the
		// main thread never picks up the new sub-conversation messages.
		const handleAgentComplete = (e: Event) => {
			const { parentConversationId } = (e as CustomEvent).detail;
			if (parentConversationId !== convId) return;
			invalidateFetchPolicy(`messages-all:${convId}`);
			invalidateFetchPolicy(`messages-tools:${convId}`);
			loadMessages();
			hydrateToolCallsFromApi();
		};
		window.addEventListener("ez:agent_complete", handleAgentComplete);

		if (container && sentinel) {
			observer = new IntersectionObserver(
				([entry]) => {
					userScrolledUp = !entry!.isIntersecting;
				},
				{ root: container, threshold: 0.1 },
			);
			observer.observe(sentinel);
		}

		return () => {
			observer?.disconnect();
			cleanupOAuth();
			window.removeEventListener("ez:turn_saved", handleTurnSaved);
			window.removeEventListener("ez:agent_complete", handleAgentComplete);
			// Zombie/staleness timers are owned by attachStreamResume and torn
			// down via its $effect cleanup — nothing to clear here.
		};
	});

	// Auto-scroll on new tokens
	$effect(() => {
		void currentStreamingText;
		if (!userScrolledUp && sentinel) {
			sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
		}
	});

	// Persist scroll position per-conv as the user scrolls so we can restore
	// it on re-entry when nothing new arrived while they were away.
	$effect(() => {
		if (!container) return;
		const el = container;
		const cid = convId;
		const onScroll = () => updateCachedScrollState(cid, { scrollTop: el.scrollTop });
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	});

	// Initial mount scroll: once the sentinel is in the DOM and messages are
	// present, decide whether to jump to bottom (active stream / first visit)
	// or restore the user's saved scroll position. See decideOpenScroll() in
	// $lib/chat-scroll-restore. By the time this fires, the convId-reset
	// effect below has already restored the cached `visibleMessageCount`, so
	// the DOM has the same number of messages rendered as when the user left
	// — that's what makes the restored scrollTop land on the same message.
	let initialScrollDone = $state(false);
	$effect(() => {
		if (initialScrollDone) return;
		if (!sentinel || !container) return;
		if (messages.length === 0) return;
		if (userScrolledUp) { initialScrollDone = true; return; }

		const cached = getCachedScrollState(convId);
		const decision = decideOpenScroll({
			convId,
			streamingRunToConversation: store.streamingRunToConversation,
			cachedScrollTop: cached?.scrollTop,
		});

		if (decision.kind === "scroll-to-bottom") {
			sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
		} else {
			container.scrollTop = decision.scrollTop;
		}
		initialScrollDone = true;
	});
	// Reset the gate on conversation switch so the decision logic runs
	// again for the newly-opened conversation. Restore the cached
	// pagination window so the restored scrollTop lines up with the same
	// messages the user was reading.
	$effect(() => {
		void convId;
		initialScrollDone = false;
		const cached = getCachedScrollState(convId);
		visibleMessageCount = cached?.windowSize ?? INITIAL_MESSAGE_WINDOW;
	});

	async function loadOlderMessages(): Promise<void> {
		if (loadingOlder || !hasOlderMessages) return;
		loadingOlder = true;
		// Capture scroll offset so the viewport stays anchored on whatever the
		// user was reading — without this, prepending DOM nodes visually shifts
		// the content down and the user loses their place.
		const el = container;
		const beforeHeight = el?.scrollHeight ?? 0;
		const beforeTop = el?.scrollTop ?? 0;
		visibleMessageCount = nextWindowSize(visibleMessageCount, messages.length, MESSAGE_LOAD_STEP);
		updateCachedScrollState(convId, { windowSize: visibleMessageCount });
		await tick();
		if (el) {
			el.scrollTop = anchorScrollTop(beforeTop, beforeHeight, el.scrollHeight);
		}
		loadingOlder = false;
	}

	// IntersectionObserver on the "load older" sentinel at the top of the
	// message list. Only attach after the initial scroll-to-bottom has run,
	// otherwise the observer would fire immediately on mount (the sentinel is
	// scrolled into view at the top before we land the viewport on the latest
	// message) and we'd eagerly expand the window.
	$effect(() => {
		if (!topSentinel) return;
		if (!initialScrollDone) return;
		if (!hasOlderMessages) return;
		const obs = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) void loadOlderMessages();
				}
			},
			{ root: container ?? null, rootMargin: "200px" },
		);
		obs.observe(topSentinel);
		return () => obs.disconnect();
	});

	// Reload messages when convId changes (also runs on initial mount)
	$effect(() => {
		void convId;
		const gen = untrack(() => ++loadGeneration);
		unreadStore.markRead(convId);
		activeRunId = null;
		activeRunStartedAt = null;
		serverStalenessMs = null;
		resumedRun = false;
		localSystemMessages = [];
		subConversations = [];
		selectedAgent = null;
		checkingActiveRun = true;
		initialLoadDone = false;
		// Drop fetch-policy cooldowns so the new conversation's first fetches
		// aren't blocked by the previous conversation's 5s throttle window.
		// Safe even on very first mount — invalidate is a no-op for empty maps.
		invalidateFetchPolicy('messages-all:');
		invalidateFetchPolicy('messages-tools:');
		invalidateFetchPolicy('conv:');
		invalidateFetchPolicy('active-run:');
		invalidateFetchPolicy('tasks:');
		loadMessages()
			.then(() => { if (gen === loadGeneration) return checkActiveRun(gen); })
			.catch(() => { if (gen === loadGeneration) checkingActiveRun = false; })
			.finally(() => { if (gen === loadGeneration) initialLoadDone = true; });
	});

	// Detect external stream completion (run:complete/error cleaned up streaming state)
	$effect(() => {
		if (activeRunId && !isStreaming) {
			reconcileAfterStream();
		}
	});

	// Zombie/staleness watchdog and WS-reconnect resume effects are owned by
	// `attachStreamResume` (W9, called above). Both effects fire automatically
	// — the WS-reconnect throttle's `lastReconnectCheckAt` lives at module
	// scope inside `stream-resume.svelte.ts` so it persists across re-mounts
	// (per-page-instance scope would let the cooldown reset on every convId
	// change, defeating the throttle).

	// Tree-walking helpers + the dedup'd loadMessages / hydrateToolCallsFromApi
	// pair are extracted to $lib/chat/page-handlers/load-messages.ts (W5).
	// findLeafByMessageId / computeLatestLeaf are pure and imported directly.
	// loadMessages + hydrateToolCallsFromApi are stateful — both close over
	// per-convId in-flight Maps inside the factory, so each call site here
	// shares one set of dedup slots.
	const loadMessagesApi = makeLoadMessages({
		convId: () => convId,
		allMessages: { get: () => allMessages, set: (v) => { allMessages = v; } },
		activeLeafId: { get: () => activeLeafId, set: (v) => { activeLeafId = v; } },
		editingMessageId: { get: () => editingMessageId, set: (v) => { editingMessageId = v; } },
		error: { get: () => error, set: (v) => { error = v; } },
		currentConversation: { get: () => currentConversation, set: (v) => { currentConversation = v; } },
		selectedModel: { get: () => selectedModel, set: (v) => { selectedModel = v; } },
		selectedMode: { get: () => selectedMode, set: (v) => { selectedMode = v; } },
		availableModes: () => availableModes,
		historicalToolCalls: { get: () => historicalToolCalls, set: (v) => { historicalToolCalls = v; } },
		subConversations: { get: () => subConversations, set: (v) => { subConversations = v; } },
		localStorage: () => (typeof localStorage !== "undefined" ? localStorage : null),
	});
	const loadMessages = loadMessagesApi.loadMessages;
	const hydrateToolCallsFromApi = loadMessagesApi.hydrateToolCallsFromApi;

	// ── Send-message handler family ──
	// All of `handleSend`, edit/regenerate, retry/fallback, save-memory,
	// branch-nav, and the sub-conversation cluster live in
	// `$lib/chat/page-handlers/send-message.ts` (W7). Slots flow through
	// the host below; the page stays the source of truth for every piece
	// of reactive state. `messages()` reads the active-path derived;
	// `sentinel()` is read fresh inside `requestAnimationFrame` so the
	// optimistic-scroll lands after the just-pushed user bubble renders.
	const sendApi = makeSendMessage({
		convId: () => convId,
		projectId: () => projectId,
		selectedModel: { get: () => selectedModel, set: (v) => { selectedModel = v; } },
		permissionModeOverride: { get: () => permissionModeOverride, set: (v) => { permissionModeOverride = v; } },
		thinkingLevel: { get: () => thinkingLevel, set: (v) => { thinkingLevel = v; } },
		modelSupportsReasoning: () => modelSupportsReasoning,
		allMessages: { get: () => allMessages, set: (v) => { allMessages = v; } },
		activeLeafId: { get: () => activeLeafId, set: (v) => { activeLeafId = v; } },
		messages: () => messages,
		editingMessageId: { get: () => editingMessageId, set: (v) => { editingMessageId = v; } },
		editContent: { get: () => editContent, set: (v) => { editContent = v; } },
		activeRunId: { get: () => activeRunId, set: (v) => { activeRunId = v; } },
		activeRunStartedAt: { get: () => activeRunStartedAt, set: (v) => { activeRunStartedAt = v; } },
		serverStalenessMs: { get: () => serverStalenessMs, set: (v) => { serverStalenessMs = v; } },
		resumedRun: { get: () => resumedRun, set: (v) => { resumedRun = v; } },
		error: { get: () => error, set: (v) => { error = v; } },
		chatOAuthPending: { get: () => chatOAuthPending, set: (v) => { chatOAuthPending = v; } },
		userScrolledUp: { get: () => userScrolledUp, set: (v) => { userScrolledUp = v; } },
		settingsOpen: { get: () => settingsOpen, set: (v) => { settingsOpen = v; } },
		obsOpen: { get: () => obsOpen, set: (v) => { obsOpen = v; } },
		editRetryCall: { get: () => editRetryCall, set: (v) => { editRetryCall = v; } },
		editRetryTool: {
			get: () => editRetryTool as unknown,
			set: (v) => { editRetryTool = v as ToolDefinition | null; },
		},
		savedMemories: { get: () => savedMemories, set: (v) => { savedMemories = v; } },
		subConversations: { get: () => subConversations, set: (v) => { subConversations = v; } },
		sentinel: () => sentinel ?? null,
		convList: () => convList ?? null,
		addSystemMessage,
		loadMessages,
		makeOptimisticMessage,
		handleModelChange,
		computeLatestLeaf,
		findLeafByMessageId,
	});
	const handleSend = sendApi.handleSend;
	const handleRegenerate = (msg: Message) => sendApi.handleRegenerate(msg);
	const handleBranchNavigate = sendApi.handleBranchNavigate;
	const handleSaveMemory = (msg: Message) => sendApi.handleSaveMemory(msg);
	const handleRetry = (msg: Message) => sendApi.handleRetry(msg);
	const handleFallback = (msg: Message, provider: string, model: string) =>
		sendApi.handleFallback(msg, provider, model);
	const handleSubConvoSend = sendApi.handleSubConvoSend;
	const handleSubConvoReturn = sendApi.handleSubConvoReturn;

	function handleEdit(msg: Message) {
		editingMessageId = msg.id;
		editContent = msg.content;
	}

	const submitEdit = (msg: Message) => sendApi.handleEditConfirm(msg);

	function cancelEdit() {
		editingMessageId = null;
		editContent = "";
	}

	function handleBranch(msg: Message) {
		// Branch from this message: set it as the active leaf and focus input
		activeLeafId = msg.id;
		requestAnimationFrame(() => chatInput?.focus());
	}

	async function handleRemoveMemory(msg: Message) {
		const memoryId = savedMemories.get(msg.id);
		if (!memoryId) return;
		try {
			await userFetch(`/api/memories/${memoryId}`, { method: "DELETE" });
			const next = new Map(savedMemories);
			next.delete(msg.id);
			savedMemories = next;
		} catch {
			// silent
		}
	}

	async function handleStop() {
		if (!activeRunId) return;
		const runId = activeRunId;
		try {
			await userFetch(`/api/conversations/${convId}/active-run`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "cancel" }),
			});
		} catch {
			// Run may have already completed or errored — still clean up
		}
		const streamedText = store.streamingMessages[runId];
		if (streamedText) {
			allMessages = allMessages.map((m) =>
				m.runId === runId ? { ...m, content: streamedText } : m,
			);
		}
		stopStreaming(runId);
		activeRunId = null;
		activeRunStartedAt = null;
		serverStalenessMs = null;
		// Fetch fresh messages to pick up any server-side error/completion
		try {
			const freshMessages = await fetchAllMessages(convId);
			allMessages = freshMessages;
			if (activeLeafId && !freshMessages.find((m) => m.id === activeLeafId)) {
				activeLeafId = computeLatestLeaf(freshMessages);
			}
		} catch {
			// Keep optimistic state if fetch fails
		}
	}

	async function reconcileAfterStream() {
		const runId = activeRunId;
		activeRunId = null;
		activeRunStartedAt = null;
		serverStalenessMs = null;
		try {
			const freshMessages = await fetchAllMessages(convId);
			allMessages = freshMessages;
			// Keep the active leaf pointing to the same branch
			if (activeLeafId) {
				// Verify the leaf still exists, otherwise recompute
				if (!freshMessages.find((m) => m.id === activeLeafId)) {
					activeLeafId = computeLatestLeaf(freshMessages);
				}
			} else {
				activeLeafId = computeLatestLeaf(freshMessages);
			}

			// Re-hydrate tool calls so diff panel picks up newly persisted built-in tool calls
			await hydrateToolCallsFromApi();
		} catch {
			if (runId) {
				const streamedText = store.streamingMessages[runId];
				if (streamedText) {
					allMessages = allMessages.map((m) =>
						m.runId === runId ? { ...m, content: streamedText } : m,
					);
				}
			}
		}
	}

	function handleModelChange(provider: string, model: string) {
		selectedModel = { provider, model };
		persistLastModel(typeof localStorage !== "undefined" ? localStorage : null, { provider, model });
		if (convId) {
			updateConversation(convId, { model, provider }).catch(() => {});
		}
	}

	function handleModelAutoSelect(provider: string, model: string) {
		if (selectedModel) return;
		selectedModel = { provider, model };
		// Only persist to the conversation row once we've confirmed it has
		// no stored model — otherwise a fast /api/models response during the
		// initial load race would clobber the user's actual saved pick.
		if (convId && currentConversation && !currentConversation.model) {
			updateConversation(convId, { model, provider }).catch(() => {});
		}
	}

	function handleThinkingLevelChange(level: string) {
		thinkingLevel = level;
		localStorage.setItem("ezcorp-thinking-level", level);
	}

	function handleReasoningChange(reasoning: boolean) {
		modelSupportsReasoning = reasoning;
	}

	function handleContextWindowChange(contextWindow: number | null) {
		selectedModelContextWindow = contextWindow;
	}

	function handleModeChange(mode: Mode | null) {
		selectedMode = mode;
		updateConversation(convId, { modeId: mode?.id ?? null }).catch(() => {});
		// Apply mode's preferred thinking level if set
		if (mode?.preferredThinkingLevel && modelSupportsReasoning) {
			thinkingLevel = mode.preferredThinkingLevel;
			localStorage.setItem("ezcorp-thinking-level", mode.preferredThinkingLevel);
		}
	}

	async function handleCreate() {
		try {
			const conv = await createConversation({ projectId });
			goto(`/project/${projectId}/chat/${conv.id}`);
		} catch (err) {
			console.error("Failed to create conversation:", err);
		}
	}

	// ── Inline "Edit text" for seeded assistant turns ────────────────────

	function handleEditText(msg: Message) {
		editTextMessageId = msg.id;
		editTextDraft = msg.content;
	}

	function cancelEditText() {
		editTextMessageId = null;
		editTextDraft = "";
	}

	async function submitEditText() {
		if (!editTextMessageId || !convId) return;
		const targetId = editTextMessageId;
		const draft = editTextDraft;
		editTextSaving = true;
		try {
			const updated = await patchMessageContent(convId, targetId, draft);
			allMessages = allMessages.map((m) => (m.id === targetId ? { ...m, content: updated.content } : m));
			cancelEditText();
		} catch (err) {
			console.error("Failed to edit text:", err);
		} finally {
			editTextSaving = false;
		}
	}

	async function handleToggleExclude(msg: Message) {
		if (!convId) return;
		const next = !msg.excluded;
		// Optimistic flip; the success path reconciles against the server's
		// returned row. We do NOT roll back on error — by the time the catch
		// fires the user may have re-clicked, or `allMessages` may have been
		// rebuilt by a streaming chunk, so reverting from the captured
		// `msg.excluded` would clobber newer state. Mirrors `submitEditText`
		// above. Instead, surface the failure via the page-level `error`
		// banner so the user knows the optimistic flip didn't persist —
		// silent failure here is privacy-shaped (user thinks a sensitive
		// turn is excluded when the server still has it included).
		allMessages = allMessages.map((m) => (m.id === msg.id ? { ...m, excluded: next } : m));
		try {
			const updated = await setMessageExcluded(convId, msg.id, next);
			allMessages = allMessages.map((m) => (m.id === msg.id ? { ...m, excluded: updated.excluded } : m));
		} catch (err) {
			console.error("Failed to toggle excluded:", err);
			error = next
				? "Couldn't exclude that message from context. Try again."
				: "Couldn't re-include that message. Try again.";
		}
	}

	function handleSelect(id: string) {
		goto(`/project/${projectId}/chat/${id}`);
	}

	async function handleSaveSystemPrompt(systemPrompt: string) {
		if (!convId) return;
		try {
			currentConversation = await updateConversation(convId, { systemPrompt });
			settingsOpen = false;
		} catch (err) {
			console.error("Failed to save system prompt:", err);
		}
	}

	/** Get siblings for a message from the sibling map */
	function getSiblings(msg: Message): { id: string; createdAt: string }[] {
		const parentKey = msg.parentMessageId ?? "__root__";
		return siblingMap.get(parentKey) ?? [];
	}

	/** Convert hydrated InlineToolCalls to ToolCallState[] for ChatMessage rendering */
	function getHistoricalToolCalls(messageId: string): import("$lib/stores.svelte.js").ToolCallState[] {
		const calls = inlineToolStore.getByMessage(messageId);
		if (calls.length === 0) return [];
		return calls.map((c, i) => ({
			id: c.id,
			toolName: c.toolName,
			status: c.status === 'complete' ? 'complete' as const
				: c.status === 'error' ? 'error' as const
				: 'running' as const,
			input: c.input,
			output: c.output,
			error: c.error,
			startedAt: c.startedAt ?? i, // Use index as fallback to avoid key collisions
			duration: c.duration,
			extensionId: c.extensionName,
			cardType: c.cardType,
		}));
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
		width="w-[85vw]"
		maxWidth="max-w-[320px]"
		onclose={() => (mobileConvListOpen = false)}
		ariaLabel="Conversation list"
	>
		<ConversationList
			{projectId}
			activeConversationId={convId}
			oncreate={() => { mobileConvListOpen = false; handleCreate(); }}
			onselect={(id) => { mobileConvListOpen = false; handleSelect(id); }}
		/>
	</SwipeDrawer>

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="flex flex-1 flex-col min-w-0"
		data-testid="chat-column"
		ondragover={(e) => {
			if (shouldHandleChatWindowDragOver(e.dataTransfer, !!chatInput)) e.preventDefault();
		}}
		ondrop={(e) => {
			const files = filesFromChatWindowDrop(e.dataTransfer, !!chatInput);
			if (!files) return;
			e.preventDefault();
			chatInput?.stageFiles(files);
		}}
	>
		<ChatHeader
			{projectId}
			{convId}
			{currentConversation}
			{lastTurnInputTokens}
			{selectedModelContextWindow}
			{contextBreakdown}
			{contextToolBreakdown}
			{loadedTools}
			{toolsByExtension}
			{extensionTypeMap}
			{toolsOpen}
			{diffPanelOpen}
			{diffFileCount}
			{activeLeafId}
			{showObsButton}
			{obsOpen}
			selectMode={selectMode.state.selectMode}
			{isStreaming}
			onmobilemenu={() => (mobileConvListOpen = true)}
			ontoolstoggle={(next) => (toolsOpen = next)}
			ondifftoggle={() => (diffPanelOpen = !diffPanelOpen)}
			onobstoggle={() => (obsOpen = !obsOpen)}
			onselecttoggle={selectMode.toggleSelectMode}
			onsettingstoggle={() => (settingsOpen = true)}
			onpermissionmodechange={(mode) => { permissionModeOverride = mode; }}
			oncallclick={scrollToToolCall}
		/>

		<!-- Messages -->
		<div bind:this={container} class="relative flex-1 overflow-y-auto" data-testid="chat-messages-container">
			<div class="mx-auto max-w-3xl space-y-1 py-4" aria-live="polite" aria-relevant="additions">
				{#if messages.length === 0 && !error}
					<div class="flex items-center justify-center py-20">
						<p class="text-sm text-[var(--color-text-muted)]">Send a message to start the conversation</p>
					</div>
				{/if}

				{#if error}
					<div class="mx-4 rounded-md border border-red-800 bg-red-900/30 p-3 text-sm text-red-300" role="alert">
						{error}
					</div>
				{/if}

				{#if hasOlderMessages}
					<div bind:this={topSentinel} class="flex items-center justify-center py-2 text-[10px] text-[var(--color-text-muted)]">
						<button
							type="button"
							class="rounded px-2 py-1 hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-60"
							onclick={loadOlderMessages}
							disabled={loadingOlder}
						>
							{loadingOlder ? "Loading older messages..." : "Load older messages"}
						</button>
					</div>
				{/if}

				{#each visibleMessages as msg (msg.id)}
					{@const isStreamingMsg = msg.id.startsWith('streaming-') && isStreaming}
					{@const streamingTools = isStreamingMsg && activeRunId ? getStreamingToolCalls(activeRunId) : undefined}
					{@const historicalTools = !isStreamingMsg && msg.role === 'assistant' ? getHistoricalToolCalls(msg.id) : undefined}
					{@const msgToolCalls = streamingTools ?? (historicalTools && historicalTools.length > 0 ? historicalTools : undefined)}
					{@const streamingAgents = isStreamingMsg && activeRunId ? getStreamingAgentCalls(activeRunId) : undefined}
					{@const historicalAgents = !isStreamingMsg && msg.role === 'assistant' ? getHistoricalAgentCalls(msg.id) : undefined}
					{@const msgAgentCalls = streamingAgents ?? historicalAgents}
					{@const msgContentBlocks = isStreamingMsg && activeRunId
						? getStreamingContentBlocks(activeRunId)
						: ((historicalTools && historicalTools.length > 0) || (historicalAgents && historicalAgents.length > 0) || msg.thinkingContent
							? buildHistoricalBlocks(msg.content, historicalTools?.length ?? 0, historicalAgents?.length ?? 0, msg.thinkingContent)
							: undefined)}
					{@const msgSiblings = getSiblings(msg)}
					{#if editingMessageId === msg.id}
						<!-- Inline edit UI -->
						<div class="flex gap-3 px-4 py-3 bg-[var(--color-surface-secondary)] rounded-lg">
							<div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-tertiary)]">
								<span class="text-xs font-medium text-[var(--color-text-primary)]">U</span>
							</div>
							<div class="min-w-0 flex-1">
								<textarea
									bind:value={editContent}
									class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] p-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none resize-y"
									rows="3"
									onkeydown={(e) => {
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											submitEdit(msg);
										}
										if (e.key === "Escape") cancelEdit();
									}}
								></textarea>
								<div class="mt-2 flex gap-2">
									<button
										onclick={() => submitEdit(msg)}
										class="rounded-md bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500"
									>
										Save & Submit
									</button>
									<button
										onclick={cancelEdit}
										class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-border)]"
									>
										Cancel
									</button>
								</div>
							</div>
						</div>
					{:else if editTextMessageId === msg.id}
						<!-- Content-only edit UI for seeded assistant turns (no regen). -->
						<div class="flex gap-3 px-4 py-3 bg-[var(--color-surface-secondary)] rounded-lg" data-testid="edit-text-form-{msg.id}">
							<div class="min-w-0 flex-1">
								<textarea
									bind:value={editTextDraft}
									class="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] p-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none resize-y"
									rows="4"
									onkeydown={(e) => {
										if (e.key === "Escape") cancelEditText();
									}}
								></textarea>
								<div class="mt-2 flex gap-2">
									<button
										onclick={submitEditText}
										disabled={editTextSaving}
										class="rounded-md bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
										data-testid="edit-text-save"
									>
										{editTextSaving ? "Saving…" : "Save"}
									</button>
									<button
										onclick={cancelEditText}
										class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-border)]"
									>
										Cancel
									</button>
								</div>
							</div>
						</div>
					{:else}
						<ChatMessage
							message={msg}
							streamingText={isStreamingMsg ? currentStreamingText : undefined}
							streamingStatus={isStreamingMsg ? currentStreamingStatus : undefined}
							streamingStartedAt={isStreamingMsg && activeRunStartedAt != null ? activeRunStartedAt : undefined}
							memoriesUsed={memoryCardVisibleMessageIds.has(msg.id) ? msg.memoriesUsed : undefined}
							toolCalls={msgToolCalls}
							agentCalls={msgAgentCalls}
							contentBlocks={msgContentBlocks}
							conversationId={convId}
							onretry={() => handleRetry(msg)}
							onedit={msg.role === "user" ? handleEdit : undefined}
							onregenerate={msg.role === "assistant" ? handleRegenerate : undefined}
							onfallback={msg.role === "assistant" ? (p, m) => handleFallback(msg, p, m) : undefined}
							onbranch={handleBranch}
							onsavememory={handleSaveMemory}
							onremovememory={handleRemoveMemory}
							savedAsMemory={savedMemories.has(msg.id)}
							siblings={msgSiblings.length > 1 ? msgSiblings : undefined}
							onnavigate={msgSiblings.length > 1 ? handleBranchNavigate : undefined}
							inlineToolCalls={msg.role === 'user' ? inlineToolStore.getByMessage(msg.id).map(c => ({ extensionName: c.extensionName, toolName: c.toolName, input: c.input })) : undefined}
							onagentclick={(agent) => { selectedAgent = agent; }}
							onsendmessage={handleSend}
							onopenobservability={() => { obsOpen = true; }}
							selectable={selectMode.state.selectMode}
							selected={selectMode.state.selectedIds.has(msg.id)}
							onselectionchange={selectMode.toggleSelectedMessage}
							onedittext={msg.role === 'assistant' ? handleEditText : undefined}
							onexclude={handleToggleExclude}
						/>
					{/if}

					<!-- Sub-conversation block after triggering message (user-initiated only; agent sub-convos render as chips) -->
					{#if userSubConvoByMessage.has(msg.id)}
						<div class="ml-4 mb-1 flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
							Sub-conversation <InfoTooltip key="chat.sub-conversations" />
						</div>
						{@const subConvo = userSubConvoByMessage.get(msg.id)!}
						{@const isActiveSubConvo = subConversationStore.activeSubConversationId === subConvo.id}
						<SubConversationBlock
							conversation={subConvo}
							messages={isActiveSubConvo ? subConversationStore.subConvoMessages : []}
							isActive={isActiveSubConvo}
							onreturn={handleSubConvoReturn}
							onsend={handleSubConvoSend}
						/>
					{/if}

					<!-- Inline tool cards anchored to this message (skip assistant msgs — those render inside ChatMessage) -->
					{#if msg.role !== 'assistant'}
						{#each inlineToolStore.getByMessage(msg.id) as call (call.id)}
							<InlineToolCard
								{call}
								onretry={handleInlineRetry}
								oneditretry={handleInlineEditRetry}
								oncancel={handleInlineCancel}
								onsendmessage={handleSend}
							/>
						{/each}
					{/if}

					<!-- Edit-retry form anchored to this message -->
					{#if editRetryCall?.messageId === msg.id && editRetryTool}
						<div class="mx-4">
							<InlineToolForm
								tool={editRetryTool}
								extensionName={editRetryCall.extensionName}
								initialValues={editRetryCall.input}
								{sharedValues}
								onconfirm={handleEditRetryConfirm}
								onclose={() => { editRetryCall = null; editRetryTool = null; }}
							/>
						</div>
					{/if}
				{/each}

				<!-- Fallback: unanchored CLIENT-INITIATED tool calls (no messageId).
				     Excludes entries sourced from agent-run events — those are already
				     rendered inside their streaming message bubble (via streamingToolCalls)
				     and contribute to the Diff Summary panel via their conversationId
				     bucket. Rendering them here too would duplicate the card AND spawn
				     redundant setInterval timers during busy agent runs. -->
				{#each inlineCalls.filter(c => !c.messageId && c.source !== 'agent-run') as call (call.id)}
					<div id={`tool-call-${call.id}`}>
						<InlineToolCard
							{call}
							onretry={handleInlineRetry}
							oneditretry={handleInlineEditRetry}
							oncancel={handleInlineCancel}
							onsendmessage={handleSend}
						/>
					</div>
				{/each}

				<!-- Fallback: unanchored edit-retry form -->
				{#if editRetryCall && editRetryTool && !editRetryCall.messageId}
					<div class="mx-4">
						<InlineToolForm
							tool={editRetryTool}
							extensionName={editRetryCall.extensionName}
							initialValues={editRetryCall.input}
							{sharedValues}
							onconfirm={handleEditRetryConfirm}
							onclose={() => { editRetryCall = null; editRetryTool = null; }}
						/>
					</div>
				{/if}

				{#each localSystemMessages as sysMsg (sysMsg.id)}
					<div class="mx-4 my-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-4 py-2 text-xs text-[var(--color-text-secondary)] italic">
						{sysMsg.content}
					</div>
				{/each}

				{#if checkingActiveRun && lastMessageIsUser}
					<div class="group relative flex gap-3 px-4 py-3" role="status" aria-live="polite">
						<div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-tertiary)]">
							<span class="text-xs font-medium text-[var(--color-text-primary)]">AI</span>
						</div>
						<div class="min-w-0 flex-1">
							<SkeletonLoader statusText="Resuming..." />
						</div>
					</div>
				{/if}

				<div bind:this={sentinel} class="h-1"></div>
			</div>

			{#if userScrolledUp}
				<button
					class="jump-to-bottom"
					onclick={() => {
						userScrolledUp = false;
						sentinel?.scrollIntoView({ behavior: 'smooth' });
					}}
					aria-label="Jump to bottom"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
					</svg>
				</button>
			{/if}
		</div>

		<!-- Persistent task tracking panel (shows when tasks exist for this conversation) -->
		{#if hasAnyTasks && taskSnapshot}
			<TaskPanel
				snapshot={taskSnapshot}
				conversationId={convId}
				{selectedModel}
				onsendmessage={handleSend}
				ontaskclick={(task) => { taskLogsTask = task; taskLogsOpen = true; }}
				onteamclick={(id, name) => openTeamPanel(convId, id, name)}
			/>
		{/if}

		<!-- Extension panels (rendered from sandboxed extension state updates) -->
		{#each Object.entries(store.extensionPanelStates) as [extId, panelData] (extId)}
			<ExtensionPanel extensionId={extId} extensionName={panelData.extensionName} conversationId={convId} state={panelData.state} />
		{/each}

		<!-- Stuck-run banner: appears when the active run has gone silent for ≥30s. Gives the
		     user an escape hatch (Cancel / View details) so they're never trapped with a
		     silent spinner. Mounts directly above the input so it's always visible. -->
		{#if isStreaming && serverStalenessMs != null && serverStalenessMs >= 30_000 && activeRunStartedAt != null}
			<StuckRunBanner
				stalenessMs={serverStalenessMs}
				startedAt={activeRunStartedAt}
				onCancel={handleStop}
				onOpenObservability={() => { obsOpen = true; }}
			/>
		{/if}

		{#if selectMode.state.selectMode}
			<SelectModeActionBar
				selectedCount={selectMode.derived.selectedCount}
				{isStreaming}
				selectCloning={selectMode.state.selectCloning}
				bulkBusy={selectMode.state.bulkBusy}
				allSelectedExcluded={selectMode.derived.allSelectedExcluded}
				bulkCopyContent={selectMode.derived.bulkCopyContent}
				selectError={selectMode.state.selectError}
				bulkStatus={selectMode.state.bulkStatus}
				oncancel={selectMode.toggleSelectMode}
				onfork={selectMode.handleForkSelection}
				oncopy={selectMode.handleBulkCopied}
				onexclude={selectMode.handleBulkExclude}
				onsavememory={selectMode.handleBulkSaveMemory}
			/>
		{:else}
			<!-- Input -->
			<ChatInput
				bind:this={chatInput}
				onsubmit={handleSend}
				onstop={handleStop}
				streaming={isStreaming}
				autofocus={shouldAutofocusComposer({
					loaded: initialLoadDone,
					messageCount: allMessages.length,
					disabled: isStreaming,
				})}
				{selectedModel}
				onmodelchange={handleModelChange}
				onautoselect={handleModelAutoSelect}
				{thinkingLevel}
				onthinkinglevelchange={handleThinkingLevelChange}
				{modelSupportsReasoning}
				onreasoningchange={handleReasoningChange}
				oncontextwindowchange={handleContextWindowChange}
				conversationId={convId}
				{projectId}
				ontoolinvoke={handleToolInvoke}
				{sharedValues}
				{selectedMode}
				modes={availableModes}
				onmodechange={handleModeChange}
				onmodecreate={() => { showCreateModeModal = true; }}
			/>
		{/if}
	</div>

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

	<DiffSummaryPanel
		messages={messages}
		toolCalls={diffPanelToolCalls}
		open={diffPanelOpen}
		onclose={() => (diffPanelOpen = false)}
		streaming={isStreaming}
	/>

	{#if selectedAgent}
		<AgentDetailPanel
			agent={selectedAgent}
			open={!!selectedAgent}
			onclose={() => { selectedAgent = null; }}
		/>
	{/if}

	{#if taskLogsTask}
		<TaskLogsPanel
			task={taskLogsTask}
			conversationId={convId}
			open={taskLogsOpen}
			onclose={() => { taskLogsOpen = false; taskLogsTask = null; }}
		/>
	{/if}

	<ModeFormModal
		open={showCreateModeModal}
		onclose={() => { showCreateModeModal = false; }}
		onsaved={(mode) => {
			availableModes = [...availableModes, mode];
			selectedMode = mode;
			showCreateModeModal = false;
			updateConversation(convId, { modeId: mode.id }).catch(() => {});
		}}
	/>
</div>

<style>
.jump-to-bottom {
		position: sticky;
		bottom: 1rem;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 9999px;
		background: var(--color-surface-tertiary);
		border: 1px solid var(--color-border);
		color: var(--color-text-muted);
		cursor: pointer;
		z-index: 10;
		transition: opacity 0.2s;
		box-shadow: 0 2px 8px rgba(0,0,0,0.3);
	}
	.jump-to-bottom:hover {
		color: var(--color-text-primary);
		background: var(--color-border);
	}
</style>
