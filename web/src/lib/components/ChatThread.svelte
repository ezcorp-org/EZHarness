<script lang="ts">
	/**
	 * `<ChatThread>` — the shared chat thread (message tree + composer +
	 * handlers + streaming + branch nav), extracted from the main chat
	 * page so the page and the agent sub-chat panel render ONE
	 * implementation (DRY; the user explicitly disallowed parallel code).
	 *
	 * # Design (mirrors tasks/chatthread-parity.md §A)
	 *
	 * Every reactive slot is an instance-local `$state` wrapped in a
	 * `{get,set}` Slot; `convId()`/`projectId()` are prop closures. All
	 * six page-handler factories (`makeSendMessage`, `makeLoadMessages`,
	 * `makeInlineToolHandlers`, `useSelectMode`, `attachStreamResume`,
	 * `handleExtensionTurnSaved`) are instantiated verbatim from the
	 * page. The branch-aware `{#each}` of `ChatMessage` (+
	 * `SubConversationBlock`, `InlineToolCard`) and `ChatInput` render
	 * here. Streaming `$derived` mirrors are runId-keyed off the global
	 * store (the EzPanel pattern) so two mounted instances (page + panel)
	 * never collide and never share state — all state is instance-local.
	 *
	 * `variant='panel'` swaps the page chrome for a 44px-touch + onclose
	 * header (the panel already gets 44px-min targets free via
	 * `MessageToolbar`'s `btnClass`). `persistModel` is injected so the
	 * page passes its `handleModelChange` and the panel passes
	 * `updateConversation`.
	 *
	 * # Phase-0 DRY pin
	 *
	 * `siblingMap` / `messages` are copied BYTE-IDENTICAL from
	 * `+page.svelte` (≈ L538 / L553). `ChatThread.behavior.component.test.ts`
	 * (re-pointed in Phase 4) drives the same factories and asserts the
	 * same 8 behaviours with zero assertion churn — that unchanged-green
	 * state is the DRY proof.
	 */
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import { onMount, untrack, tick } from "svelte";
	import {
		fetchAllMessages,
		updateConversation,
		patchMessageContent,
		setMessageExcluded,
		cloneTurns,
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
		getWsReconnectCount,
		type AgentCallState,
		type AssignmentStatus,
	} from "$lib/stores.svelte.js";
	import { aggregateToolCallDiffs } from "$lib/diff-aggregator.js";
	import {
		computeBreakdown,
		computeToolBreakdown,
		estimateToolCallTokens,
		pickLastTurnUsage,
	} from "$lib/context-usage-logic";
	import { buildHistoricalBlocks } from "$lib/content-blocks.js";
	import { recordSnapshot, type StreamSnapshot } from "$lib/chat/reconcile-stream.js";
	import { runReconcileAfterStream } from "$lib/chat/reconcile-after-stream.js";
	import { filterEmptyAssistantTurns } from "$lib/chat/filter-empty-turns.js";
	import { shouldShowPill } from "$lib/ez/pill-visibility";
	import { parseCapabilityEventContent } from "$lib/components/CapabilityEventPill.svelte";
	import { getHistoricalToolCalls as mapHistoricalToolCalls } from "$lib/chat/historical-tool-calls.js";
	import {
		subConvoToAgentCallState,
		type SubConvoRecord,
	} from "$lib/sub-convo-agent-state.js";
	import { listenForOAuthResult, type OAuthPending } from "$lib/oauth.js";
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
		computeAnchor,
		scrollTopForAnchor,
	} from "$lib/chat-scroll-restore.js";
	import ChatMessage from "$lib/components/ChatMessage.svelte";
	import ChatInput from "$lib/components/ChatInput.svelte";
	import InlineToolCard from "$lib/components/InlineToolCard.svelte";
	import InlineToolForm from "$lib/components/InlineToolForm.svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import InfoTooltip from "$lib/components/InfoTooltip.svelte";
	import SubConversationBlock from "$lib/components/SubConversationBlock.svelte";
	import SelectModeActionBar from "$lib/components/chat/SelectModeActionBar.svelte";
	import StuckRunBanner from "$lib/components/StuckRunBanner.svelte";
	import { inlineToolStore, type InlineToolCall } from "$lib/inline-tool-store.svelte.js";
	import type { PermissionMode } from "$lib/permission-mode.js";
	import { subConversationStore } from "$lib/sub-conversation-store.svelte.js";
	import { extensionToolbarStore } from "$lib/stores/extension-toolbar.svelte.js";
	import {
		buildExtensionBulkEventPayload,
		buildExtensionEventUrl,
		postExtensionEvent,
		selectBulkApplicableContributions,
		type ExtensionAction,
	} from "$lib/chat/extension-toolbar-action.js";
	import { addToast } from "$lib/toast.svelte.js";
	import { makeInlineToolHandlers } from "$lib/chat/page-handlers/inline-tool-handlers.js";
	import {
		makeLoadMessages,
		findLeafByMessageId,
		computeLatestLeaf,
		pathToRoot,
		type HistoricalToolCall,
	} from "$lib/chat/page-handlers/load-messages.js";
	import { handleExtensionTurnSaved } from "$lib/chat/page-handlers/handle-extension-turn.js";
	import { useSelectMode } from "$lib/chat/page-handlers/useSelectMode.svelte.js";
	import { makeSendMessage } from "$lib/chat/page-handlers/send-message.js";
	import { attachStreamResume } from "$lib/chat/page-handlers/stream-resume.svelte.js";
	import { shouldAutofocusComposer } from "$lib/chat-input-logic.js";
	import {
		backgroundFetch,
		userFetch,
		invalidate as invalidateFetchPolicy,
	} from "$lib/utils/fetch-policy.js";
	import type { ToolDefinition } from "$server/extensions/types";

	// ── Props ─────────────────────────────────────────────────────────
	interface Props {
		conversationId: string;
		projectId: string;
		variant?: "page" | "panel";
		onclose?: () => void;
		/**
		 * window-event name to listen on for an external "this thread's
		 * data changed, reload" signal (the panel passes `agent:complete`;
		 * the page wires its own `ez:turn_saved`/`ez:agent_complete`).
		 */
		refreshEventName?: string;
		/** Persist a model pick. Page → handleModelChange; panel →
		 *  updateConversation. */
		persistModel?: (provider: string, model: string) => void;
		/** Route-level helpers the page owns and the thread calls. */
		currentConversation?: Conversation | null;
		availableModes?: Mode[];
		selectedMode?: Mode | null;
		onmodechange?: (mode: Mode | null) => void;
		onmodecreate?: () => void;
		onagentclick?: (agent: AgentCallState) => void;
		onopenobservability?: () => void;
		convListRefresh?: () => void;
		/** Header slot — page passes its <ChatHeader>; panel passes its
		 *  own compact header. The snippet receives the live chrome state
		 *  so the page's <ChatHeader> can read isStreaming / activeLeafId
		 *  / context-usage without re-deriving them. */
		header?: import("svelte").Snippet<[ChatThreadChrome]>;
		/** Footer/side-panel slot — receives the same chrome state so the
		 *  page can render DiffSummaryPanel / ObservabilityPanel /
		 *  AgentDetailPanel against the thread's live derived values. */
		chrome_panels?: import("svelte").Snippet<[ChatThreadChrome]>;
		/**
		 * Optional synchronous pre-seed of the message tree. When provided,
		 * `allMessages`/`activeLeafId` are populated at construction so the
		 * thread renders immediately (no flash-of-empty before the async
		 * `loadMessages` settles). `undefined` in the page/panel — they
		 * rely on the normal async load. Also the seam the Phase-0 DRY pin
		 * uses to project state synchronously.
		 */
		seedMessages?: Message[];
		seedLeafId?: string | null;
		/**
		 * Two-way live mirror of the chrome state. Page/panel leave it
		 * unbound; the Phase-0 DRY-pin harness binds it to project the
		 * thread's reactive state onto its testid contract synchronously
		 * (so the byte-identical Phase-0 assertions stay green against the
		 * real component).
		 */
		live?: ChatThreadChrome;
	}

	/** Chrome-relevant derived state surfaced to the page's route shell
	 *  via the `header` / `chrome_panels` snippets so the page never
	 *  re-derives thread internals (single source of truth). */
	export interface ChatThreadChrome {
		messages: Message[];
		activeLeafId: string | null;
		isStreaming: boolean;
		selectMode: boolean;
		selectedModel: { provider: string; model: string } | null;
		selectedModelContextWindow: number | null;
		lastTurnInputTokens: number | null;
		contextBreakdown: ReturnType<typeof computeBreakdown>;
		contextToolBreakdown: ReturnType<typeof computeToolBreakdown>;
		diffPanelToolCalls: InlineToolCall[];
		diffFileCount: number;
		taskSnapshot: (typeof store.taskSnapshots)[string] | null;
		toggleSelectMode: () => void;
		/** Header's permission-mode chooser writes through this so the
		 *  thread's send-message factory picks it up. */
		setPermissionMode: (mode: PermissionMode | undefined) => void;
		// Extra fields the Phase-0 DRY-pin harness mirrors (page chrome
		// ignores these).
		allMessages: Message[];
		activeRunId: string | null;
		error: string | null;
		streamingText: string;
	}

	let {
		conversationId,
		projectId,
		variant = "page",
		onclose,
		refreshEventName,
		persistModel,
		currentConversation = null,
		availableModes = [],
		selectedMode = null,
		onmodechange,
		onmodecreate,
		onagentclick,
		onopenobservability,
		convListRefresh,
		header,
		chrome_panels,
		seedMessages,
		seedLeafId,
		live = $bindable(),
	}: Props = $props();

	// `loadedTools` is fetched route-side and threaded in so the header
	// snippet has the tool-count badge data without a duplicate fetch.
	let loadedTools = $state<
		Array<{
			name: string;
			description: string;
			extension: string;
			extensionType?: string;
			tokenEstimate?: number;
		}>
	>([]);
	onMount(() => {
		fetch("/api/tools")
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (d) loadedTools = d.tools;
			})
			.catch(() => {});
	});

	// Prop closures — the factories read `convId()`/`projectId()` fresh.
	const convId = () => conversationId;
	const projId = () => projectId;

	// ── Instance-local thread state (every Slot is local $state) ───────
	// `seedMessages` provided ⇒ "seeded mode": render synchronously from
	// the seed and honour `seedLeafId` LITERALLY (incl. an explicit
	// null → empty path). The page/panel never pass it and use the
	// normal async load. `__seeded` also gates the async loader so the
	// seed isn't clobbered by a `computeLatestLeaf` overwrite.
	const __seeded = seedMessages !== undefined;
	// svelte-ignore state_referenced_locally
	let allMessages = $state<Message[]>(
		seedMessages ? [...seedMessages] : [],
	);
	// svelte-ignore state_referenced_locally
	let activeLeafId = $state<string | null>(
		__seeded ? (seedLeafId ?? null) : null,
	);
	let editingMessageId = $state<string | null>(null);
	let editContent = $state("");
	let historicalToolCalls = $state<HistoricalToolCall[]>([]);
	let savedMemories = $state(new Map<string, string>());
	let subConversations = $state<SubConvoRecord[]>([]);
	let localSystemMessages = $state<Message[]>([]);
	let chatOAuthPending = $state<OAuthPending | null>(null);
	let permissionModeOverride = $state<PermissionMode | undefined>(undefined);
	let editRetryCall = $state<InlineToolCall | null>(null);
	let editRetryTool = $state<ToolDefinition | null>(null);
	let editTextMessageId = $state<string | null>(null);
	let editTextDraft = $state("");
	let editTextSaving = $state(false);
	let selectedModel = $state<{ provider: string; model: string } | null>(null);
	let thinkingLevel = $state<string>(
		typeof localStorage !== "undefined"
			? (localStorage.getItem("ezcorp-thinking-level") ?? "medium")
			: "medium",
	);
	let modelSupportsReasoning = $state(false);
	let selectedModelContextWindow = $state<number | null>(null);
	let activeRunId = $state<string | null>(null);
	let activeRunStartedAt = $state<number | null>(null);
	let serverStalenessMs = $state<number | null>(null);
	let error = $state<string | null>(null);
	let chatInput: ChatInput | undefined = $state();
	let container: HTMLDivElement | undefined = $state();
	let sentinel: HTMLDivElement | undefined = $state();
	let checkingActiveRun = $state(false);
	let initialLoadDone = $state(false);
	let loadGeneration = $state(0);
	let resumedRun = $state(false);
	let userScrolledUp = $state(false);
	let observer: IntersectionObserver | undefined;
	let streamedSnapshot = $state<StreamSnapshot>({});
	let visibleMessageCount = $state(INITIAL_MESSAGE_WINDOW);
	let topSentinel = $state<HTMLDivElement | undefined>();
	let loadingOlder = $state(false);

	// ── Sub-conversation / agent derivations (verbatim) ───────────────
	let subConvoByMessage = $derived(
		new Map(subConversations.map((sc) => [sc.parentMessageId, sc])),
	);
	let userSubConvoByMessage = $derived(
		new Map([...subConvoByMessage].filter(([, sc]) => !sc.agentConfigId)),
	);
	let agentSubConvos = $derived(
		subConversations.filter((sc) => sc.agentConfigId),
	);
	let taskSnapshot = $derived(store.taskSnapshots[conversationId] ?? null);
	let assignmentBySubConvo = $derived.by(() => {
		const map = new Map<
			string,
			{ status: AssignmentStatus; resultPreview?: string }
		>();
		if (!taskSnapshot) return map;
		for (const task of taskSnapshot.tasks) {
			for (const a of task.assignments ?? []) {
				if (a.subConversationId) {
					map.set(a.subConversationId, {
						status: a.status,
						resultPreview: a.resultPreview,
					});
				}
			}
		}
		return map;
	});

	function getHistoricalAgentCalls(
		messageId: string,
	): AgentCallState[] | undefined {
		if (agentSubConvos.length === 0) return undefined;
		const msg = allMessages.find((m) => m.id === messageId);
		const parentMsgId = msg?.parentMessageId;
		const matched = agentSubConvos.filter(
			(sc) =>
				sc.parentMessageId === messageId ||
				(parentMsgId && sc.parentMessageId === parentMsgId),
		);
		if (matched.length === 0) return undefined;
		return matched.map((sc) =>
			subConvoToAgentCallState(sc, assignmentBySubConvo.get(sc.id)),
		);
	}

	let inlineCalls = $derived(
		inlineToolStore.calls.filter((c) => c.conversationId === conversationId),
	);

	// ── Streaming mirrors — runId-keyed (EzPanel pattern) ─────────────
	let isStreaming = $derived(
		activeRunId !== null &&
			(store.streamingMessages[activeRunId] !== undefined ||
				store.streamingStatus[activeRunId] !== undefined),
	);
	let currentStreamingText = $derived(
		activeRunId ? store.streamingMessages[activeRunId] : undefined,
	);
	let currentStreamingStatus = $derived(
		activeRunId ? store.streamingStatus[activeRunId] : undefined,
	);

	// ── siblingMap — copied verbatim from +page.svelte ≈ L538 ─────────
	let siblingMap = $derived.by(() => {
		const map = new Map<string, { id: string; createdAt: string }[]>();
		for (const msg of allMessages) {
			const parentKey = msg.parentMessageId ?? "__root__";
			const list = map.get(parentKey) ?? [];
			list.push({ id: msg.id, createdAt: msg.createdAt });
			map.set(parentKey, list);
		}
		for (const list of map.values()) {
			list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		}
		return map;
	});

	// ── messages path walk — copied verbatim from +page.svelte ≈ L553 ─
	let messages = $derived.by(() =>
		activeLeafId ? pathToRoot(allMessages, activeLeafId) : [],
	);

	// Memory-card dedup + empty-turn filter (verbatim from page).
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
			const key = mems
				.map((m) => m.id)
				.sort()
				.join(",");
			if (key !== prevKey) {
				visible.add(msg.id);
				prevKey = key;
			}
		}
		return visible;
	});

	let pillSettings = $state<Record<string, unknown>>({});
	let extensionsByName = $state<Map<string, { isBundled: boolean }>>(
		new Map(),
	);

	let renderableMessages = $derived.by(() => {
		const filtered = filterEmptyAssistantTurns(messages, {
			hasHistoricalToolCalls: (id) =>
				getHistoricalToolCalls(id).length > 0,
			hasHistoricalAgentCalls: (id) => {
				const agents = getHistoricalAgentCalls(id);
				return !!agents && agents.length > 0;
			},
			isMemoryCardVisible: (id) => memoryCardVisibleMessageIds.has(id),
		});
		return filtered.filter((m) => {
			if (m.role !== "capability-event") return true;
			const payload = parseCapabilityEventContent(m.content);
			const extensionName = payload?.extensionName ?? null;
			const ext = extensionName
				? (extensionsByName.get(extensionName) ?? null)
				: null;
			return shouldShowPill(m, ext, pillSettings);
		});
	});

	let visibleMessages = $derived(
		computeVisibleMessages(renderableMessages, visibleMessageCount),
	);
	let hasOlderMessages = $derived(
		computeHasOlder(renderableMessages.length, visibleMessageCount),
	);
	let lastMessageIsUser = $derived(
		messages.length > 0 &&
			messages[messages.length - 1]?.role === "user",
	);

	// ── Chrome-relevant derivations (surfaced to the page shell) ──────
	// Context usage — verbatim from +page.svelte.
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
	// Diff panel — union of parent + sub-conversation tool calls.
	let diffPanelToolCalls = $derived.by(() => {
		const ids = [conversationId, ...subConversations.map((sc) => sc.id)];
		return ids.flatMap((id) => inlineToolStore.getByConversation(id));
	});
	let diffFileCount = $derived.by(() => {
		const completed = diffPanelToolCalls.filter(
			(tc) => tc.status === "complete",
		);
		return aggregateToolCallDiffs(
			completed.map((tc) => ({
				toolName: tc.toolName,
				input: tc.input,
				output: tc.output,
			})),
		).length;
	});
	// `chromeState` is declared AFTER `selectMode` (it reads it) — see
	// just below the useSelectMode() instantiation.

	const PROVIDER_DISPLAY: Record<string, string> = {
		openai: "OpenAI",
		google: "Google Gemini",
		anthropic: "Anthropic",
	};

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
				conversationId,
				role: "system",
				content,
				parentMessageId: activeLeafId,
			}),
		];
	}

	// ── Factory: load-messages (W5) ───────────────────────────────────
	// svelte-ignore state_referenced_locally
	let currentConv = $state<Conversation | null>(
		currentConversation ?? null,
	);
	$effect(() => {
		currentConv = currentConversation;
	});
	const loadMessagesApi = makeLoadMessages({
		convId,
		allMessages: { get: () => allMessages, set: (v) => { allMessages = v; } },
		activeLeafId: { get: () => activeLeafId, set: (v) => { activeLeafId = v; } },
		editingMessageId: { get: () => editingMessageId, set: (v) => { editingMessageId = v; } },
		error: { get: () => error, set: (v) => { error = v; } },
		currentConversation: { get: () => currentConv, set: (v) => { currentConv = v; } },
		selectedModel: { get: () => selectedModel, set: (v) => { selectedModel = v; } },
		selectedMode: { get: () => selectedMode ?? null, set: () => {} },
		availableModes: () => availableModes,
		historicalToolCalls: { get: () => historicalToolCalls, set: (v) => { historicalToolCalls = v; } },
		subConversations: { get: () => subConversations, set: (v) => { subConversations = v; } },
		localStorage: () => (typeof localStorage !== "undefined" ? localStorage : null),
	});
	const loadMessages = loadMessagesApi.loadMessages;
	const hydrateToolCallsFromApi = loadMessagesApi.hydrateToolCallsFromApi;

	// ── Factory: inline-tool handlers ─────────────────────────────────
	const inlineToolHandlers = makeInlineToolHandlers({
		convId,
		activeLeafId: () => activeLeafId,
		getEditRetry: () => ({ call: editRetryCall, tool: editRetryTool }),
		setEditRetry: (call, tool) => {
			editRetryCall = call;
			editRetryTool = tool;
		},
	});
	const handleInlineRetry = inlineToolHandlers.handleInlineRetry;
	const handleInlineEditRetry = inlineToolHandlers.handleInlineEditRetry;
	const handleEditRetryConfirm = inlineToolHandlers.handleEditRetryConfirm;
	const handleInlineCancel = inlineToolHandlers.handleInlineCancel;
	const handleToolInvoke = inlineToolHandlers.handleToolInvoke;

	function handleModelChange(provider: string, model: string) {
		selectedModel = { provider, model };
		persistModel?.(provider, model);
	}
	function handleModelAutoSelect(provider: string, model: string) {
		if (selectedModel) return;
		selectedModel = { provider, model };
	}
	function handleThinkingLevelChange(level: string) {
		thinkingLevel = level;
		if (typeof localStorage !== "undefined")
			localStorage.setItem("ezcorp-thinking-level", level);
	}
	function handleReasoningChange(reasoning: boolean) {
		modelSupportsReasoning = reasoning;
	}
	function handleContextWindowChange(cw: number | null) {
		selectedModelContextWindow = cw;
	}

	// ── Factory: send-message family (W7) ─────────────────────────────
	const sendApi = makeSendMessage({
		convId,
		projectId: projId,
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
		settingsOpen: { get: () => false, set: () => {} },
		obsOpen: { get: () => false, set: () => {} },
		editRetryCall: { get: () => editRetryCall, set: (v) => { editRetryCall = v; } },
		editRetryTool: { get: () => editRetryTool, set: (v) => { editRetryTool = v; } },
		savedMemories: { get: () => savedMemories, set: (v) => { savedMemories = v; } },
		subConversations: { get: () => subConversations, set: (v) => { subConversations = v; } },
		sentinel: () => sentinel ?? null,
		convList: () => (convListRefresh ? { refresh: convListRefresh } : null),
		addSystemMessage,
		loadMessages,
		makeOptimisticMessage,
		handleModelChange,
		computeLatestLeaf,
		findLeafByMessageId,
	});
	const handleSend = sendApi.handleSend;
	const handleRegenerate = (msg: Message) => sendApi.handleRegenerate(msg);
	const handleRerun = (msg: Message) => sendApi.handleRerun(msg);
	const handleBranchNavigate = sendApi.handleBranchNavigate;
	const handleSaveMemory = (msg: Message) => sendApi.handleSaveMemory(msg);
	const handleRetry = (msg: Message) => sendApi.handleRetry(msg);
	const handleFallback = (msg: Message, provider: string, model: string) =>
		sendApi.handleFallback(msg, provider, model);
	const handleSubConvoSend = sendApi.handleSubConvoSend;
	const handleSubConvoReturn = sendApi.handleSubConvoReturn;
	const submitEdit = (msg: Message) => sendApi.handleEditConfirm(msg);

	function handleEdit(msg: Message) {
		editingMessageId = msg.id;
		editContent = msg.content;
	}
	function cancelEdit() {
		editingMessageId = null;
		editContent = "";
	}
	let branching = $state(false);
	async function handleBranch(msg: Message) {
		if (branching) return;
		// Fork the conversation up to and including this message into a
		// fresh conversation, then navigate there. The original is left
		// untouched. Path is root → msg so the new chat reproduces the
		// turns the user branched from.
		const messageIds = pathToRoot(allMessages, msg.id).map((m) => m.id);
		if (messageIds.length === 0) return;
		branching = true;
		try {
			const newConv = await cloneTurns(conversationId, { messageIds });
			// Refresh the sidebar BEFORE navigating so the new fork (and
			// the chevron on its source) exist by the time the new chat
			// page renders — mirrors the bulk Fork-Chat flow.
			convListRefresh?.();
			await goto(`/project/${projectId}/chat/${newConv.id}`);
		} catch (err) {
			addToast({
				type: "error",
				message:
					err instanceof Error
						? err.message
						: "Failed to branch conversation",
			});
		} finally {
			branching = false;
		}
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
			await userFetch(`/api/conversations/${conversationId}/active-run`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "cancel" }),
			});
		} catch {
			// already completed/errored — still clean up
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
		try {
			const fresh = await fetchAllMessages(conversationId);
			allMessages = fresh;
			if (activeLeafId && !fresh.find((m) => m.id === activeLeafId)) {
				activeLeafId = computeLatestLeaf(fresh);
			}
		} catch {
			// keep optimistic state
		}
	}
	async function reconcileAfterStream() {
		await runReconcileAfterStream({
			convId,
			activeRunId: { get: () => activeRunId, set: (v) => { activeRunId = v; } },
			activeRunStartedAt: { set: (v) => { activeRunStartedAt = v; } },
			serverStalenessMs: { set: (v) => { serverStalenessMs = v; } },
			allMessages: { get: () => allMessages, set: (v) => { allMessages = v; } },
			activeLeafId: { get: () => activeLeafId, set: (v) => { activeLeafId = v; } },
			streamedSnapshot: { get: () => streamedSnapshot, set: (v) => { streamedSnapshot = v; } },
			fetchAllMessages,
			computeLatestLeaf,
			hydrateToolCallsFromApi,
		});
	}

	// ── Inline "edit text" (seeded assistant turns) ───────────────────
	function handleEditText(msg: Message) {
		editTextMessageId = msg.id;
		editTextDraft = msg.content;
	}
	function cancelEditText() {
		editTextMessageId = null;
		editTextDraft = "";
	}
	async function submitEditText() {
		if (!editTextMessageId) return;
		const targetId = editTextMessageId;
		const draft = editTextDraft;
		editTextSaving = true;
		try {
			const updated = await patchMessageContent(
				conversationId,
				targetId,
				draft,
			);
			allMessages = allMessages.map((m) =>
				m.id === targetId ? { ...m, content: updated.content } : m,
			);
			cancelEditText();
		} catch (err) {
			console.error("Failed to edit text:", err);
		} finally {
			editTextSaving = false;
		}
	}
	async function handleToggleExclude(msg: Message) {
		const next = !msg.excluded;
		allMessages = allMessages.map((m) =>
			m.id === msg.id ? { ...m, excluded: next } : m,
		);
		try {
			const updated = await setMessageExcluded(
				conversationId,
				msg.id,
				next,
			);
			allMessages = allMessages.map((m) =>
				m.id === msg.id ? { ...m, excluded: updated.excluded } : m,
			);
		} catch (err) {
			console.error("Failed to toggle excluded:", err);
			error = next
				? "Couldn't exclude that message from context. Try again."
				: "Couldn't re-include that message. Try again.";
		}
	}

	function getSiblings(msg: Message): { id: string; createdAt: string }[] {
		const parentKey = msg.parentMessageId ?? "__root__";
		return siblingMap.get(parentKey) ?? [];
	}
	function getHistoricalToolCalls(
		messageId: string,
	): import("$lib/stores.svelte.js").ToolCallState[] {
		return mapHistoricalToolCalls(messageId);
	}

	// ── Select mode (W rune host) ─────────────────────────────────────
	const selectMode = useSelectMode({
		convId,
		projectId: projId,
		allMessages: { get: () => allMessages, set: (v) => { allMessages = v; } },
		visibleMessages: () => visibleMessages,
		savedMemories: { get: () => savedMemories, set: (v) => { savedMemories = v; } },
		isStreaming: () => isStreaming,
		getHistoricalToolCalls: (id) => getHistoricalToolCalls(id),
		convList: () => (convListRefresh ? { refresh: convListRefresh } : null),
	});

	// Single chrome-state object handed to the page's header/panel
	// snippets so the route shell never re-derives thread internals.
	// Declared here (after `selectMode`) because it reads it.
	let chromeState = $derived<ChatThreadChrome>({
		messages,
		activeLeafId,
		isStreaming,
		selectMode: selectMode.state.selectMode,
		selectedModel,
		selectedModelContextWindow,
		lastTurnInputTokens,
		contextBreakdown,
		contextToolBreakdown,
		diffPanelToolCalls,
		diffFileCount,
		taskSnapshot,
		toggleSelectMode: () => selectMode.toggleSelectMode(),
		setPermissionMode: (mode) => {
			permissionModeOverride = mode;
		},
		allMessages,
		activeRunId,
		error,
		streamingText: currentStreamingText ?? "",
	});

	// Keep the optional two-way `live` mirror in lock-step with the
	// derived chrome state (the DRY-pin harness binds this).
	$effect(() => {
		live = chromeState;
	});

	$effect(() => {
		if (conversationId) void extensionToolbarStore.ensure(conversationId);
	});
	let bulkToolbarItems = $derived(
		conversationId ? extensionToolbarStore.get(conversationId) : [],
	);
	let bulkExtensionActions = $derived.by((): ExtensionAction[] => {
		const applicable = selectBulkApplicableContributions(bulkToolbarItems);
		if (applicable.length === 0) return [];
		return applicable.map((item) => ({
			extName: item.extName,
			id: item.id,
			icon: item.icon,
			tooltip: item.tooltip,
			onclick: async () => {
				const messageIds = Array.from(selectMode.state.selectedIds);
				if (messageIds.length === 0) return;
				const idSet = new Set(messageIds);
				const ordered = allMessages
					.filter((m) => idSet.has(m.id))
					.map((m) => m.content ?? "")
					.filter((c) => c.length > 0);
				const content =
					ordered.length === messageIds.length
						? ordered.join("\n\n")
						: selectMode.derived.bulkCopyContent;
				const orderedMessageIds = allMessages
					.filter((m) => idSet.has(m.id))
					.map((m) => m.id);
				const payload = buildExtensionBulkEventPayload({
					messageIds:
						orderedMessageIds.length > 0
							? orderedMessageIds
							: messageIds,
					conversationId,
					content,
				});
				addToast({ type: "info", message: `${item.tooltip}…` }, 2500);
				const url = buildExtensionEventUrl(item.extName, item.event);
				await postExtensionEvent(url, payload, item.tooltip, {
					fetcher: userFetch,
					addToast,
				});
			},
		}));
	});
	const handleBulkRerun = async () => {
		const idSet = new Set(selectMode.state.selectedIds);
		const lastUserMsg = [...allMessages]
			.reverse()
			.find((m) => idSet.has(m.id) && m.role === "user");
		if (!lastUserMsg) return;
		selectMode.toggleSelectMode();
		await sendApi.handleRerun(lastUserMsg);
	};

	// ── Stream-resume orchestration (W9) ──────────────────────────────
	const streamResumeApi = attachStreamResume({
		convId,
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

	// ── Queued first message (`?initial`) — verbatim from +page.svelte ─
	let pendingInitial = $state<string | null>(null);
	let initialApplied = false;
	$effect(() => {
		if (!pendingInitial || initialApplied) return;
		if (!conversationId) return;
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
			// Strip the param so a refresh doesn't re-send it.
			goto(page.url.pathname, { replaceState: true, noScroll: true });
		}
	});

	// ── Mount: window events + observers (verbatim from page) ─────────
	onMount(() => {
		const cleanupOAuth = listenForOAuthResult((result) => {
			if (result.success) {
				addSystemMessage(
					`${PROVIDER_DISPLAY[result.provider] ?? result.provider} connected successfully!`,
				);
			} else {
				addSystemMessage(
					`Failed to connect ${PROVIDER_DISPLAY[result.provider] ?? result.provider}: ${result.error ?? "unknown error"}`,
				);
			}
		});

		const handleTurnSaved = (e: Event) => {
			const {
				runId,
				conversationId: evtConvId,
				messageId,
				parentMessageId,
				content,
				thinkingContent,
				final,
			} = (e as CustomEvent).detail;
			if (evtConvId !== conversationId) return;

			if (typeof runId === "string" && runId.startsWith("ext:")) {
				const knownIds = new Set(allMessages.map((m) => m.id));
				handleExtensionTurnSaved(
					{
						invalidateFetchPolicy,
						loadMessages,
						hydrateToolCallsFromApi,
					},
					{
						convId: conversationId,
						messageId,
						knownMessageIds: knownIds,
					},
				);
				return;
			}

			if (runId !== activeRunId) return;

			const realMsg = makeOptimisticMessage({
				id: messageId,
				conversationId,
				role: "assistant",
				content,
				thinkingContent: thinkingContent ?? null,
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				runId,
				parentMessageId,
			});
			allMessages = allMessages.filter(
				(m) => m.id !== `streaming-${runId}`,
			);
			allMessages = [...allMessages, realMsg];

			if (final === true) {
				// Terminal turn: no follow-up turn will stream. Make the
				// just-saved row the active leaf and create NO placeholder —
				// an empty streaming-${runId} row here would trip the skeleton
				// (ChatMessage.svelte) and paint over the thinking card until
				// run:complete. The persisted row already carries
				// thinking+text; the run:complete reconcile settles it from
				// the DB.
				activeLeafId = messageId;
				return;
			}

			const nextPlaceholder = makeOptimisticMessage({
				id: `streaming-${runId}`,
				conversationId,
				role: "assistant",
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				runId,
				parentMessageId: messageId,
			});
			allMessages = [...allMessages, nextPlaceholder];
			activeLeafId = nextPlaceholder.id;
		};
		window.addEventListener("ez:turn_saved", handleTurnSaved);

		const handleAgentComplete = (e: Event) => {
			const { parentConversationId } = (e as CustomEvent).detail;
			if (parentConversationId !== conversationId) return;
			invalidateFetchPolicy(`messages-all:${conversationId}`);
			invalidateFetchPolicy(`messages-tools:${conversationId}`);
			loadMessages();
			hydrateToolCallsFromApi();
		};
		window.addEventListener("ez:agent_complete", handleAgentComplete);

		// Optional caller-supplied refresh event (panel passes
		// `agent:complete`). status:'queued' / external completion ⇒
		// reload the thread.
		const handleExternalRefresh = () => {
			invalidateFetchPolicy(`messages-all:${conversationId}`);
			invalidateFetchPolicy(`messages-tools:${conversationId}`);
			loadMessages();
			hydrateToolCallsFromApi();
		};
		if (refreshEventName) {
			window.addEventListener(refreshEventName, handleExternalRefresh);
		}

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
			window.removeEventListener(
				"ez:agent_complete",
				handleAgentComplete,
			);
			if (refreshEventName) {
				window.removeEventListener(
					refreshEventName,
					handleExternalRefresh,
				);
			}
		};
	});

	// Auto-scroll on new tokens.
	$effect(() => {
		void currentStreamingText;
		if (!userScrolledUp && sentinel) {
			sentinel.scrollIntoView({
				behavior: "instant" as ScrollBehavior,
			});
		}
	});

	// Persist scroll position per-conv.
	$effect(() => {
		if (!container) return;
		const el = container;
		const cid = conversationId;
		const onScroll = () => {
			const anchor = computeAnchor(el);
			const partial: Parameters<typeof updateCachedScrollState>[1] = {
				scrollTop: el.scrollTop,
			};
			if (anchor) {
				partial.anchorMessageId = anchor.messageId;
				partial.anchorOffset = anchor.offset;
			}
			updateCachedScrollState(cid, partial);
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	});

	let initialScrollDone = $state(false);
	$effect(() => {
		if (initialScrollDone) return;
		if (!sentinel || !container) return;
		if (messages.length === 0) return;
		const cached = getCachedScrollState(conversationId);
		const decision = decideOpenScroll({
			convId: conversationId,
			streamingRunToConversation: store.streamingRunToConversation,
			cachedScrollTop: cached?.scrollTop,
		});
		// An active stream forces bottom and intentionally overrides BOTH
		// the cached position and a `userScrolledUp` that's stale from the
		// remount race (the bottom-sentinel observer fires before this
		// effect when we remount onto a non-bottom leftover scroll). Only
		// the active-stream case overrides; first-visit / restore still
		// yield to a user who scrolled during the initial load.
		const forceBottom =
			decision.kind === "scroll-to-bottom" &&
			decision.reason === "active-stream";
		if (userScrolledUp && !forceBottom) {
			initialScrollDone = true;
			return;
		}
		if (decision.kind === "scroll-to-bottom") {
			sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
		} else {
			const anchorTop =
				cached?.anchorMessageId !== undefined &&
				cached?.anchorOffset !== undefined
					? scrollTopForAnchor(
							container,
							cached.anchorMessageId,
							cached.anchorOffset,
						)
					: null;
			container.scrollTop = anchorTop ?? decision.scrollTop;
			startAnchorReapplyWatch(
				container,
				cached?.anchorMessageId,
				cached?.anchorOffset,
			);
		}
		initialScrollDone = true;
	});

	// Active-stream-on-open override. The active-run check runs *after*
	// loadMessages(), so the restore effect above decides before
	// `streamingRunToConversation` is populated and wrongly restores the
	// cached scrolled-up position. The reload effect resets
	// `resumedRun = false` on every conv change; the first false→true
	// transition after that means "an active run was resumed as part of
	// opening this conversation" — mirror decideOpenScroll's active-stream
	// rule and jump to bottom. A later WS-reconnect re-check keeps
	// `resumedRun` already-true (no transition), so a user who scrolled up
	// to read mid-stream is NOT yanked.
	let sawResumedRunForOpen = false;
	$effect(() => {
		if (!resumedRun) {
			sawResumedRunForOpen = false;
			return;
		}
		if (sawResumedRunForOpen) return;
		sawResumedRunForOpen = true;
		if (!sentinel) return;
		userScrolledUp = false;
		sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
	});

	let stopAnchorWatch: (() => void) | null = null;
	function startAnchorReapplyWatch(
		el: HTMLElement,
		messageId: string | undefined,
		offset: number | undefined,
	): void {
		stopAnchorWatch?.();
		stopAnchorWatch = null;
		if (messageId === undefined || offset === undefined) return;
		if (typeof ResizeObserver === "undefined") return;
		let disposed = false;
		let lastProgrammaticTop = el.scrollTop;
		const reapply = () => {
			if (disposed) return;
			const target = scrollTopForAnchor(el, messageId, offset);
			if (target !== null && Math.abs(target - el.scrollTop) > 1) {
				lastProgrammaticTop = target;
				el.scrollTop = target;
			}
		};
		const obs = new ResizeObserver(reapply);
		obs.observe(el);
		const inner = el.firstElementChild;
		if (inner) obs.observe(inner);
		const onScroll = () => {
			if (Math.abs(el.scrollTop - lastProgrammaticTop) > 2) stop();
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		const timer = setTimeout(stop, 3000);
		function stop(): void {
			if (disposed) return;
			disposed = true;
			obs.disconnect();
			el.removeEventListener("scroll", onScroll);
			clearTimeout(timer);
			stopAnchorWatch = null;
		}
		stopAnchorWatch = stop;
	}

	$effect(() => {
		void conversationId;
		initialScrollDone = false;
		stopAnchorWatch?.();
		stopAnchorWatch = null;
		const cached = getCachedScrollState(conversationId);
		visibleMessageCount = cached?.windowSize ?? INITIAL_MESSAGE_WINDOW;
	});

	async function loadOlderMessages(): Promise<void> {
		if (loadingOlder || !hasOlderMessages) return;
		loadingOlder = true;
		const el = container;
		const beforeHeight = el?.scrollHeight ?? 0;
		const beforeTop = el?.scrollTop ?? 0;
		visibleMessageCount = nextWindowSize(
			visibleMessageCount,
			messages.length,
			MESSAGE_LOAD_STEP,
		);
		updateCachedScrollState(conversationId, {
			windowSize: visibleMessageCount,
		});
		await tick();
		if (el) {
			el.scrollTop = anchorScrollTop(
				beforeTop,
				beforeHeight,
				el.scrollHeight,
			);
		}
		loadingOlder = false;
	}

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

	// Reload on convId change (also initial mount). Skipped entirely in
	// seeded mode — the synchronous seed IS the message tree (the
	// Phase-0 DRY-pin harness drives mutations through the factories
	// afterwards; a normal async load would clobber the seed).
	$effect(() => {
		void conversationId;
		if (__seeded) {
			initialLoadDone = true;
			checkingActiveRun = false;
			return;
		}
		const gen = untrack(() => ++loadGeneration);
		unreadStore.markRead(conversationId);
		activeRunId = null;
		activeRunStartedAt = null;
		serverStalenessMs = null;
		resumedRun = false;
		localSystemMessages = [];
		subConversations = [];
		checkingActiveRun = true;
		initialLoadDone = false;
		invalidateFetchPolicy("messages-all:");
		invalidateFetchPolicy("messages-tools:");
		invalidateFetchPolicy("conv:");
		invalidateFetchPolicy("active-run:");
		invalidateFetchPolicy("tasks:");
		selectMode.resetForConvSwitch();
		loadMessages()
			.then(() => {
				if (gen === loadGeneration) return checkActiveRun(gen);
			})
			.catch(() => {
				if (gen === loadGeneration) checkingActiveRun = false;
			})
			.finally(() => {
				if (gen === loadGeneration) initialLoadDone = true;
			});
	});

	$effect(() => {
		const runId = activeRunId;
		if (!runId) return;
		const text = store.streamingMessages[runId];
		const thinking = store.streamingThinking[runId];
		streamedSnapshot = recordSnapshot(
			streamedSnapshot,
			runId,
			text,
			thinking,
		);
	});

	$effect(() => {
		if (activeRunId && !isStreaming) {
			reconcileAfterStream();
		}
	});

	// WS-reconnect dependency (page kept this reactive read).
	$effect(() => {
		void getWsReconnectCount();
		void backgroundFetch;
	});

	// ── Test/host imperative API (Phase-0 pin re-point hooks) ─────────
	export function getThreadState() {
		return {
			messages,
			allMessages,
			activeLeafId,
			activeRunId,
			error,
			isStreaming,
			streamingText: currentStreamingText ?? "",
		};
	}
	export async function doRegenerate(msg: Message) {
		await sendApi.handleRegenerate(msg);
		await tick();
	}
	export async function doRetry(msg: Message) {
		await sendApi.handleRetry(msg);
		await tick();
	}
	export function startRunStream(runId: string) {
		activeRunId = runId;
	}
	export function navigateBranch(messageId: string) {
		handleBranchNavigate(messageId);
	}
	export function toggleSelectMode() {
		selectMode.toggleSelectMode();
	}
	export function toggleSelectedMessage(id: string) {
		selectMode.toggleSelectedMessage(id);
	}
	export function fireExtensionTurn(messageId: string): boolean {
		return handleExtensionTurnSaved(
			{ invalidateFetchPolicy, loadMessages, hydrateToolCallsFromApi },
			{
				convId: conversationId,
				messageId,
				knownMessageIds: new Set(allMessages.map((m) => m.id)),
			},
		);
	}
	/**
	 * Test-only handle bundle (mirrors the existing imperative test
	 * hooks above). Lets the coverage suite drive every handler /
	 * UI-state path that has no other reachable trigger in jsdom (the
	 * page/panel never call this). Kept here for parity with
	 * doRegenerate/startRunStream/navigateBranch which are the same
	 * test-seam pattern.
	 */
	export const __test = {
		handleModelChange,
		handleModelAutoSelect,
		handleThinkingLevelChange,
		handleReasoningChange,
		handleContextWindowChange,
		handleEdit,
		cancelEdit,
		handleBranch,
		handleRemoveMemory,
		handleStop,
		handleEditText,
		cancelEditText,
		submitEditText,
		handleToggleExclude,
		handleBulkRerun,
		handleRerun: (m: Message) => sendApi.handleRerun(m),
		handleFallback: (m: Message, p: string, mo: string) =>
			sendApi.handleFallback(m, p, mo),
		handleSaveMemory: (m: Message) => sendApi.handleSaveMemory(m),
		handleSubConvoSend,
		handleSubConvoReturn,
		setEditing: (id: string | null) => {
			editingMessageId = id;
		},
		setEditText: (id: string | null, draft = "") => {
			editTextMessageId = id;
			editTextDraft = draft;
		},
		setEditRetry: (
			call: InlineToolCall | null,
			tool: ToolDefinition | null,
		) => {
			editRetryCall = call;
			editRetryTool = tool;
		},
		pushSystem: (t: string) => addSystemMessage(t),
		reload: () => loadMessages(),
		setActiveRun: (id: string | null) => {
			activeRunId = id;
		},
		setStaleness: (ms: number | null, startedAt: number | null) => {
			serverStalenessMs = ms;
			activeRunStartedAt = startedAt;
		},
		// Read-only observers (test-only) so coverage assertions can
		// pin edit-text / memory / run-clear side effects WITHOUT a
		// no-op `expect(true).toBe(true)`.
		getEditTextState: () => ({
			id: editTextMessageId,
			draft: editTextDraft,
			saving: editTextSaving,
		}),
		hasSavedMemory: (msgId: string) => savedMemories.has(msgId),
	};

	let sharedValues = $derived<Record<string, string>>({
		"project.cwd":
			store.projects.find((p) => p.id === projectId)?.path ?? "",
		"project.name":
			store.projects.find((p) => p.id === projectId)?.name ?? "",
	});
	void page;
</script>

<div
	class="flex flex-1 flex-col min-w-0"
	data-testid="chat-thread"
	data-variant={variant}
>
	{#if header}
		{@render header(chromeState)}
	{:else if variant === "panel" && onclose}
		<div
			class="flex items-center justify-end border-b border-[var(--color-border)] px-3 py-2"
		>
			<button
				type="button"
				onclick={onclose}
				aria-label="Close"
				class="rounded p-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
			>
				<svg
					class="h-4 w-4"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M6 18L18 6M6 6l12 12"
					/>
				</svg>
			</button>
		</div>
	{/if}

	<div
		bind:this={container}
		class="relative flex-1 overflow-y-auto"
		data-testid="chat-messages-container"
	>
		<div
			class="mx-auto max-w-3xl space-y-1 py-4"
			aria-live="polite"
			aria-relevant="additions"
		>
			{#if messages.length === 0 && !error}
				<div class="flex items-center justify-center py-20">
					<p class="text-sm text-[var(--color-text-muted)]">
						Send a message to start the conversation
					</p>
				</div>
			{/if}

			{#if error}
				<div
					class="mx-4 rounded-md border border-red-800 bg-red-900/30 p-3 text-sm text-red-300"
					role="alert"
				>
					{error}
				</div>
			{/if}

			{#if hasOlderMessages}
				<div
					bind:this={topSentinel}
					class="flex items-center justify-center py-2 text-[10px] text-[var(--color-text-muted)]"
				>
					<button
						type="button"
						class="rounded px-2 py-1 hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-60"
						onclick={loadOlderMessages}
						disabled={loadingOlder}
					>
						{loadingOlder
							? "Loading older messages..."
							: "Load older messages"}
					</button>
				</div>
			{/if}

			{#each visibleMessages as msg (msg.id)}
				{@const isStreamingMsg =
					msg.id.startsWith("streaming-") && isStreaming}
				{@const streamingTools =
					isStreamingMsg && activeRunId
						? getStreamingToolCalls(activeRunId)
						: undefined}
				{@const historicalTools =
					!isStreamingMsg && msg.role === "assistant"
						? getHistoricalToolCalls(msg.id)
						: undefined}
				{@const msgToolCalls =
					streamingTools ??
					(historicalTools && historicalTools.length > 0
						? historicalTools
						: undefined)}
				{@const streamingAgents =
					isStreamingMsg && activeRunId
						? getStreamingAgentCalls(activeRunId)
						: undefined}
				{@const historicalAgents =
					!isStreamingMsg && msg.role === "assistant"
						? getHistoricalAgentCalls(msg.id)
						: undefined}
				{@const msgAgentCalls = streamingAgents ?? historicalAgents}
				{@const msgContentBlocks =
					isStreamingMsg && activeRunId
						? getStreamingContentBlocks(activeRunId)
						: (historicalTools && historicalTools.length > 0) ||
							  (historicalAgents &&
									historicalAgents.length > 0) ||
							  msg.thinkingContent
							? buildHistoricalBlocks(
									msg.content,
									historicalTools?.length ?? 0,
									historicalAgents?.length ?? 0,
									msg.thinkingContent,
								)
							: undefined}
				{@const msgSiblings = getSiblings(msg)}
				{#if editingMessageId === msg.id}
					<div
						class="flex gap-3 px-4 py-3 bg-[var(--color-surface-secondary)] rounded-lg"
					>
						<div
							class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-tertiary)]"
						>
							<span
								class="text-xs font-medium text-[var(--color-text-primary)]"
								>U</span
							>
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
									>Save & Submit</button
								>
								<button
									onclick={cancelEdit}
									class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-border)]"
									>Cancel</button
								>
							</div>
						</div>
					</div>
				{:else if editTextMessageId === msg.id}
					<div
						class="flex gap-3 px-4 py-3 bg-[var(--color-surface-secondary)] rounded-lg"
						data-testid="edit-text-form-{msg.id}"
					>
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
									>{editTextSaving ? "Saving…" : "Save"}</button
								>
								<button
									onclick={cancelEditText}
									class="rounded-md bg-[var(--color-surface-tertiary)] px-3 py-1 text-xs text-[var(--color-text-primary)] hover:bg-[var(--color-border)]"
									>Cancel</button
								>
							</div>
						</div>
					</div>
				{:else}
					<ChatMessage
						message={msg}
						streamingText={isStreamingMsg
							? currentStreamingText
							: undefined}
						streamingStatus={isStreamingMsg
							? currentStreamingStatus
							: undefined}
						streamingStartedAt={isStreamingMsg &&
						activeRunStartedAt != null
							? activeRunStartedAt
							: undefined}
						memoriesUsed={memoryCardVisibleMessageIds.has(msg.id)
							? msg.memoriesUsed
							: undefined}
						toolCalls={msgToolCalls}
						agentCalls={msgAgentCalls}
						contentBlocks={msgContentBlocks}
						conversationId={conversationId}
						onretry={() => handleRetry(msg)}
						onedit={msg.role === "user" ? handleEdit : undefined}
						onrerun={msg.role === "user" ? handleRerun : undefined}
						onregenerate={msg.role === "assistant"
							? handleRegenerate
							: undefined}
						onfallback={msg.role === "assistant"
							? (p, m) => handleFallback(msg, p, m)
							: undefined}
						onbranch={handleBranch}
						onsavememory={handleSaveMemory}
						onremovememory={handleRemoveMemory}
						savedAsMemory={savedMemories.has(msg.id)}
						siblings={msgSiblings.length > 1 ? msgSiblings : undefined}
						onnavigate={msgSiblings.length > 1
							? handleBranchNavigate
							: undefined}
						inlineToolCalls={msg.role === "user"
							? inlineToolStore
									.getByMessage(msg.id)
									.map((c) => ({
										extensionName: c.extensionName,
										toolName: c.toolName,
										input: c.input,
									}))
							: undefined}
						onagentclick={(agent) => onagentclick?.(agent)}
						onsendmessage={handleSend}
						onopenobservability={() => onopenobservability?.()}
						selectable={selectMode.state.selectMode}
						selected={selectMode.state.selectedIds.has(msg.id)}
						onselectionchange={selectMode.toggleSelectedMessage}
						onedittext={msg.role === "assistant"
							? handleEditText
							: undefined}
						onexclude={handleToggleExclude}
					/>
				{/if}

				{#if userSubConvoByMessage.has(msg.id)}
					<div
						class="ml-4 mb-1 flex items-center gap-1 text-xs text-[var(--color-text-muted)]"
					>
						Sub-conversation <InfoTooltip
							key="chat.sub-conversations"
						/>
					</div>
					{@const subConvo = userSubConvoByMessage.get(msg.id)!}
					{@const isActiveSubConvo =
						subConversationStore.activeSubConversationId ===
						subConvo.id}
					<SubConversationBlock
						conversation={subConvo}
						messages={isActiveSubConvo
							? subConversationStore.subConvoMessages
							: []}
						isActive={isActiveSubConvo}
						onreturn={handleSubConvoReturn}
						onsend={handleSubConvoSend}
					/>
				{/if}

				{#if msg.role !== "assistant"}
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

				{#if editRetryCall?.messageId === msg.id && editRetryTool}
					<div class="mx-4">
						<InlineToolForm
							tool={editRetryTool}
							extensionName={editRetryCall.extensionName}
							initialValues={editRetryCall.input}
							{sharedValues}
							onconfirm={handleEditRetryConfirm}
							onclose={() => {
								editRetryCall = null;
								editRetryTool = null;
							}}
						/>
					</div>
				{/if}
			{/each}

			{#each inlineCalls.filter((c) => !c.messageId && c.source !== "agent-run") as call (call.id)}
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

			{#if editRetryCall && editRetryTool && !editRetryCall.messageId}
				<div class="mx-4">
					<InlineToolForm
						tool={editRetryTool}
						extensionName={editRetryCall.extensionName}
						initialValues={editRetryCall.input}
						{sharedValues}
						onconfirm={handleEditRetryConfirm}
						onclose={() => {
							editRetryCall = null;
							editRetryTool = null;
						}}
					/>
				</div>
			{/if}

			{#each localSystemMessages as sysMsg (sysMsg.id)}
				<div
					class="mx-4 my-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-4 py-2 text-xs text-[var(--color-text-secondary)] italic"
				>
					{sysMsg.content}
				</div>
			{/each}

			{#if checkingActiveRun && lastMessageIsUser}
				<div
					class="group relative flex gap-3 px-4 py-3"
					role="status"
					aria-live="polite"
				>
					<div
						class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-tertiary)]"
					>
						<span
							class="text-xs font-medium text-[var(--color-text-primary)]"
							>AI</span
						>
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
					sentinel?.scrollIntoView({ behavior: "smooth" });
				}}
				aria-label="Jump to bottom"
			>
				<svg
					class="h-4 w-4"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M19 14l-7 7m0 0l-7-7m7 7V3"
					/>
				</svg>
			</button>
		{/if}
	</div>

	{#if isStreaming && serverStalenessMs != null && serverStalenessMs >= 30_000 && activeRunStartedAt != null}
		<StuckRunBanner
			stalenessMs={serverStalenessMs}
			startedAt={activeRunStartedAt}
			onCancel={handleStop}
			onOpenObservability={() => onopenobservability?.()}
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
			onrerun={handleBulkRerun}
			extensionActions={bulkExtensionActions}
		/>
	{:else}
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
			conversationId={conversationId}
			{projectId}
			ontoolinvoke={handleToolInvoke}
			{sharedValues}
			selectedMode={selectedMode ?? null}
			modes={availableModes}
			onmodechange={(m) => onmodechange?.(m)}
			onmodecreate={() => onmodecreate?.()}
		/>
	{/if}

	{#if chrome_panels}
		{@render chrome_panels(chromeState)}
	{/if}
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
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
	}
	.jump-to-bottom:hover {
		color: var(--color-text-primary);
		background: var(--color-border);
	}
</style>
