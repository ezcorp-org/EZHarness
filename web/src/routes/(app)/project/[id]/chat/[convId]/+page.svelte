<script lang="ts">
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import { onMount, untrack, tick } from "svelte";
	import {
		fetchAllMessages,
		fetchModes,
		sendMessage,
		createConversation,
		createSubConversation,
		updateConversation,
		cloneTurns,
		patchMessageContent,
		type Message,
		type Conversation,
		type Mode,
	} from "$lib/api.js";
	import {
		toggleSelection,
		clearSelection,
		orderedSelection,
	} from "$lib/select-mode.js";
	import {
		store,
		startStreaming,
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
	import { startOAuthFlow, completeOAuthWithCode, listenForOAuthResult, isLoginCommand, type OAuthPending } from "$lib/oauth.js";
	import { isModelCommand } from "$lib/commands.js";
	import { restoreLastModel, persistLastModel } from "$lib/last-model.js";
	import { readChatPanels, writeChatPanels } from "$lib/panel-persistence.js";
	import {
		INITIAL_MESSAGE_WINDOW,
		MESSAGE_LOAD_STEP,
		computeVisibleMessages,
		hasOlderMessages as computeHasOlder,
		nextWindowSize,
		anchorScrollTop,
	} from "$lib/message-window.js";
	import { unreadStore } from "$lib/unread.js";
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
	import { pickLastTurnInputTokens } from "$lib/context-usage-logic";
	import ModeFormModal from "$lib/components/ModeFormModal.svelte";
	import SkeletonLoader from "$lib/components/SkeletonLoader.svelte";
	import Tooltip from "$lib/components/Tooltip.svelte";
	import { inlineToolStore, type InlineToolCall } from "$lib/inline-tool-store.svelte.js";
	import { invokeInlineTool } from "$lib/invoke-inline-tool.js";
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
	import { parseMentions } from "$lib/mention-logic.js";
	import { shouldAutofocusComposer } from "$lib/chat-input-logic.js";
	import {
		backgroundFetch,
		userFetch,
		invalidate as invalidateFetchPolicy,
	} from "$lib/utils/fetch-policy.js";
	import type { ToolDefinition } from '../../../../../../src/extensions/types';

	// Historical tool call tracking
	interface HistoricalToolCall {
		id: string;
		messageId: string;
		extensionId: string;
		toolName: string;
		status: "success" | "error" | "interrupted";
		source?: "user" | "agent";
	}
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
	// Select Mode — lets users tick specific turns and fork them into a new chat.
	// `selectedIds` is a fresh Set each toggle so Svelte's reactivity picks up changes.
	let selectMode = $state(false);
	let selectedIds = $state<Set<string>>(new Set());
	let selectCloning = $state(false);
	let selectError = $state<string | null>(null);
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

	function generateId(): string {
		return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
	}

	function handleToolInvoke(calls: { extensionName: string; toolName: string; input: Record<string, unknown> }[]) {
		// Anchor to current leaf message (skip streaming placeholders — they're not real messages)
		const leafId = activeLeafId?.startsWith('streaming-') ? undefined : activeLeafId;
		for (const call of calls) {
			invokeInlineTool({
				conversationId: convId,
				extensionName: call.extensionName,
				toolName: call.toolName,
				input: call.input,
				messageId: leafId ?? undefined,
			});
		}
	}

	function handleInlineRetry(call: InlineToolCall) {
		invokeInlineTool({
			conversationId: call.conversationId,
			extensionName: call.extensionName,
			toolName: call.toolName,
			input: call.input,
			messageId: call.messageId,
		});
	}

	async function handleInlineEditRetry(call: InlineToolCall) {
		try {
			const res = await userFetch(`/api/extensions/${encodeURIComponent(call.extensionName)}/tools`);
			if (!res.ok) return;
			const { tools }: { tools: ToolDefinition[] } = await res.json();
			const tool = tools.find(t => t.name === call.toolName);
			if (tool) {
				editRetryCall = call;
				editRetryTool = tool;
			}
		} catch {
			// silent
		}
	}

	function handleEditRetryConfirm(input: Record<string, unknown>) {
		if (!editRetryCall) return;
		const invocationId = generateId();
		inlineToolStore.add({
			id: invocationId,
			extensionName: editRetryCall.extensionName,
			toolName: editRetryCall.toolName,
			input,
			conversationId: editRetryCall.conversationId,
			messageId: editRetryCall.messageId,
		});
		userFetch('/api/tool-invoke', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				extensionName: editRetryCall.extensionName,
				toolName: editRetryCall.toolName,
				input,
				conversationId: editRetryCall.conversationId,
				invocationId,
			}),
		}).catch(err => console.error('Edit retry failed:', err));
		editRetryCall = null;
		editRetryTool = null;
	}

	function handleInlineCancel(call: InlineToolCall) {
		// Mark as error in store (cancellation)
		inlineToolStore.updateFromEvent(call.id, 'tool:error', {
			error: 'Cancelled by user',
			duration: call.startedAt ? Date.now() - call.startedAt : 0,
		});
	}

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

	// ── Side-panel state persistence ──
	// Restore which side panels were open for THIS conversation, then
	// persist any change. The `panelRestoredFor` flag prevents the persist
	// effect from clobbering storage with default values before restore runs.
	let panelRestoredFor = $state<string | null>(null);
	let pendingSelectedAgentSubConvId = $state<string | null>(null);

	$effect(() => {
		const cid = convId;
		if (!cid || panelRestoredFor === cid) return;
		const saved = readChatPanels(cid);
		if (saved) {
			obsOpen = saved.obsOpen;
			diffPanelOpen = saved.diffPanelOpen;
			toolsOpen = saved.toolsOpen;
			settingsOpen = saved.settingsOpen;
			// taskLogs is restored once we have a matching task in scope
			if (saved.taskLogsOpen && saved.taskLogsTaskId) {
				const found = taskSnapshot?.tasks.find(t => t.id === saved.taskLogsTaskId) ?? null;
				if (found) {
					taskLogsTask = found;
					taskLogsOpen = true;
				}
			}
			pendingSelectedAgentSubConvId = saved.selectedAgentSubConvId;
		} else {
			// New conversation — clear any leaked state from prior conv
			obsOpen = false;
			diffPanelOpen = false;
			toolsOpen = false;
			settingsOpen = false;
			taskLogsOpen = false;
			taskLogsTask = null;
			selectedAgent = null;
			pendingSelectedAgentSubConvId = null;
		}
		// ?agent=<subConversationId> overrides localStorage — set by the
		// Active Agents list when opening a sub-agent from its parent chat.
		const urlAgent = page.url.searchParams.get("agent");
		if (urlAgent) pendingSelectedAgentSubConvId = urlAgent;
		panelRestoredFor = cid;
	});

	// Resolve pending selectedAgent once the streaming agent calls hydrate.
	// The user may have had the AgentDetailPanel open on a sub-agent; we
	// rebind it from store.streamingAgentCalls when the matching entry shows up,
	// or synthesize one from the DB-loaded subConversations when arriving via
	// a ?agent= deep link (no live streaming state yet).
	$effect(() => {
		if (!pendingSelectedAgentSubConvId) return;
		const target = pendingSelectedAgentSubConvId;
		for (const calls of Object.values(store.streamingAgentCalls)) {
			const found = calls.find(c => c.subConversationId === target);
			if (found) {
				selectedAgent = found;
				pendingSelectedAgentSubConvId = null;
				return;
			}
		}
		const sc = subConversations.find(s => s.id === target);
		if (sc) {
			selectedAgent = subConvoToAgentCallState(sc, assignmentBySubConvo.get(sc.id));
			pendingSelectedAgentSubConvId = null;
		}
	});

	// Persist whenever any tracked panel state changes (only after restore).
	$effect(() => {
		const cid = convId;
		if (!cid || panelRestoredFor !== cid) return;
		writeChatPanels(cid, {
			obsOpen,
			diffPanelOpen,
			taskLogsOpen,
			taskLogsTaskId: taskLogsTask?.id ?? null,
			toolsOpen,
			settingsOpen,
			selectedAgentSubConvId: selectedAgent?.subConversationId ?? null,
		});
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

	function addSystemMessage(content: string): void {
		localSystemMessages = [...localSystemMessages, {
			id: `system-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			conversationId: convId,
			role: "system",
			content,
			thinkingContent: null,
			model: null,
			provider: null,
			usage: null,
			runId: null,
			parentMessageId: activeLeafId,
			createdAt: new Date().toISOString(),
		}];
	}

	let lastMessageIsUser = $derived(messages.length > 0 && messages[messages.length - 1]?.role === "user");

	// Context usage: input tokens from the most recent assistant message on the active branch.
	// Represents what fit in the prompt last turn — null until the first assistant reply lands.
	let lastTurnInputTokens = $derived(pickLastTurnInputTokens(messages));

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

	async function checkActiveRun(gen: number) {
		try {
			// Throttled + deduped by fetch-policy: all three active-run call sites
			// (this one, the staleness poll, and the zombie re-check) share the
			// same semantic key, so concurrent callers collapse to a single
			// in-flight GET instead of racing each other.
			const res = await backgroundFetch(
				`active-run:${convId}`,
				`/api/conversations/${convId}/active-run`,
				{},
				{ minIntervalMs: 4000 },
			);
			if (!res || !res.ok || gen !== loadGeneration) return;
			const data = await res.json();
			if (!data.runId || gen !== loadGeneration) return;

			// If the run is not actively running, just reload messages
			if (data.status && data.status !== "running") {
				if (gen === loadGeneration) await loadMessages();
				return;
			}

			if (gen !== loadGeneration) return;
			const started = startStreaming(data.runId, convId);
			if (!started) {
				await loadMessages();
				return;
			}
			activeRunId = data.runId;
			resumedRun = true;
			// Capture server-side run metadata for the elapsed counter + stuck-run banner.
			activeRunStartedAt = data.startedAt ? new Date(data.startedAt).getTime() : Date.now();
			serverStalenessMs = typeof data.stalenessMs === 'number' ? data.stalenessMs : null;

			// Restore pending permission gates from server state
			if (data.pendingPermissions?.length) {
				for (const perm of data.pendingPermissions) {
					store.streamingToolCalls = {
						...store.streamingToolCalls,
						[data.runId]: [
							...(store.streamingToolCalls[data.runId] ?? []),
							{
								id: perm.toolCallId,
								toolName: perm.toolName,
								status: 'running' as const,
								input: perm.input,
								startedAt: Date.now(),
								permissionPending: true,
								cardType: perm.cardType,
								category: perm.category,
							},
						],
					};
				}
			}

			// Add placeholder assistant message with partial response if available
			const lastMsg = allMessages[allMessages.length - 1];
			const assistantPlaceholder: Message = {
				id: `streaming-${data.runId}`,
				conversationId: convId,
				role: "assistant",
				content: data.partialResponse ?? "",
				thinkingContent: null,
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				usage: null,
				runId: data.runId,
				parentMessageId: lastMsg?.id ?? null,
				createdAt: new Date().toISOString(),
			};
			allMessages = [...allMessages, assistantPlaceholder];
			activeLeafId = assistantPlaceholder.id;
		} catch {
			// Non-fatal — page works normally without resume
		} finally {
			checkingActiveRun = false;
		}
	}

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
			const realMsg: Message = {
				id: messageId,
				conversationId: convId,
				role: "assistant",
				content,
				thinkingContent: null,
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				usage: null,
				runId,
				parentMessageId,
				createdAt: new Date().toISOString(),
			};
			allMessages = allMessages.filter(m => m.id !== `streaming-${runId}`);
			allMessages = [...allMessages, realMsg];

			// Create new streaming placeholder for the next turn, chained to this one
			const nextPlaceholder: Message = {
				id: `streaming-${runId}`,
				conversationId: convId,
				role: "assistant",
				content: "",
				thinkingContent: null,
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				usage: null,
				runId,
				parentMessageId: messageId,
				createdAt: new Date().toISOString(),
			};
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
			if (zombieTimer) { clearTimeout(zombieTimer); zombieTimer = null; }
		};
	});

	// Auto-scroll on new tokens
	$effect(() => {
		void currentStreamingText;
		if (!userScrolledUp && sentinel) {
			sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
		}
	});

	// Initial mount scroll-to-bottom: once the sentinel is in the DOM and
	// messages are present, jump to the bottom once. Replaces the old
	// pattern where loadMessages() fired scrollIntoView before the DOM was
	// ready — that "worked" by luck because every SSE reconnect re-fired
	// loadMessages (and with it, the scroll), which was also the user-
	// reported bug of "page jumps to the bottom while I'm scrolling".
	let initialScrollDone = $state(false);
	$effect(() => {
		if (initialScrollDone) return;
		if (!sentinel) return;
		if (messages.length === 0) return;
		if (userScrolledUp) { initialScrollDone = true; return; }
		sentinel.scrollIntoView({ behavior: "instant" as ScrollBehavior });
		initialScrollDone = true;
	});
	// Reset the gate on conversation switch so the new conversation lands
	// at the bottom too.
	$effect(() => {
		void convId;
		initialScrollDone = false;
		visibleMessageCount = INITIAL_MESSAGE_WINDOW;
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

	// Zombie run detection: if streaming but no tokens arrive, re-check with server.
	// Resumed runs use a shorter timeout (5s) since they're more likely stale.
	// Also refreshes serverStalenessMs on every poll so the StuckRunBanner reflects the
	// most recent server-side heartbeat gap even when the user is passively watching.
	let zombieTimer: ReturnType<typeof setTimeout> | null = null;
	let stalenessPollTimer: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		if (zombieTimer) { clearTimeout(zombieTimer); zombieTimer = null; }
		if (stalenessPollTimer) { clearInterval(stalenessPollTimer); stalenessPollTimer = null; }
		if (!activeRunId || !isStreaming) {
			serverStalenessMs = null;
			activeRunStartedAt = null;
			return;
		}
		const snapshot = currentStreamingText ?? "";
		const timeout = resumedRun ? 5_000 : 30_000;

		// Lightweight staleness poll every 10s — only reads metadata, doesn't touch streaming
		// state. Keeps the StuckRunBanner timer fresh without depending on zombie-check firing.
		stalenessPollTimer = setInterval(async () => {
			if (!activeRunId) return;
			try {
				const res = await backgroundFetch(
					`active-run:${convId}`,
					`/api/conversations/${convId}/active-run`,
					{},
					{ minIntervalMs: 4000 },
				);
				if (!res || !res.ok) return;
				const data = await res.json();
				if (!data.runId || data.runId !== activeRunId) return;
				if (typeof data.stalenessMs === 'number') serverStalenessMs = data.stalenessMs;
				if (data.startedAt && activeRunStartedAt == null) {
					activeRunStartedAt = new Date(data.startedAt).getTime();
				}
			} catch { /* non-fatal */ }
		}, 10_000);

		zombieTimer = setTimeout(async () => {
			if (activeRunId && currentStreamingText === snapshot) {
				try {
					const res = await backgroundFetch(
						`active-run:${convId}`,
						`/api/conversations/${convId}/active-run`,
						{},
						{ minIntervalMs: 4000 },
					);
					if (!res || !res.ok) return;
					const data = await res.json();
					if (!data.runId || data.runId !== activeRunId || (data.status && data.status !== "running")) {
						stopStreaming(activeRunId);
					} else if (typeof data.stalenessMs === 'number') {
						serverStalenessMs = data.stalenessMs;
					}
				} catch { /* non-fatal */ }
			}
		}, timeout);
	});

	// On WS reconnect, check for active run and resume.
	//
	// Important: this must NOT fire on every reconnect. On a flaky network
	// (Tailscale, captive-portal handoff, mobile), the EventSource at
	// /api/runtime-events can drop and re-connect every second or two. Each
	// reconnect that called `checkActiveRun` used to cascade into
	// `loadMessages()` (which fires GET /:id, GET /:id/messages?all=true,
	// GET /:id/messages?withToolCalls=true) — visibly spamming the server
	// and freezing the UI. The server's answer to "is there an active run"
	// does not meaningfully change between reconnects that happen seconds
	// apart, so we throttle to at most one check per RECONNECT_CHECK_COOLDOWN_MS.
	const RECONNECT_CHECK_COOLDOWN_MS = 10_000;
	let wasConnected = $state(false);
	let lastReconnectCheckAt = 0;
	$effect(() => {
		const connected = store.connected;
		if (connected && !wasConnected && !activeRunId && initialLoadDone) {
			const now = Date.now();
			if (now - lastReconnectCheckAt >= RECONNECT_CHECK_COOLDOWN_MS) {
				lastReconnectCheckAt = now;
				checkingActiveRun = true;
				checkActiveRun(loadGeneration);
			}
		}
		wasConnected = connected;
	});

	/** Find the latest leaf starting from a given message, walking forward through children */
	function findLeafFrom(messageId: string): string {
		const children = siblingMap.get(messageId);
		if (!children || children.length === 0) return messageId;
		// Pick the latest child (last in sorted list)
		return findLeafFromAll(children[children.length - 1]!.id);
	}

	/** Same as findLeafFrom but uses allMessages directly for freshness */
	function findLeafFromAll(messageId: string): string {
		const msgMap = new Map(allMessages.map((m) => [m.id, m]));
		let current = messageId;
		while (true) {
			const children = allMessages.filter((m) => m.parentMessageId === current);
			if (children.length === 0) return current;
			// Pick latest child
			children.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
			current = children[children.length - 1]!.id;
		}
	}

	/** Compute the latest leaf from all messages */
	function computeLatestLeaf(msgs: Message[]): string | null {
		if (msgs.length === 0) return null;
		const parentIds = new Set(msgs.map((m) => m.parentMessageId).filter(Boolean));
		const leaves = msgs.filter((m) => !parentIds.has(m.id));
		if (leaves.length === 0) return msgs[msgs.length - 1]?.id ?? null;
		// Most recent leaf
		return leaves.reduce((latest, m) =>
			m.createdAt.localeCompare(latest.createdAt) > 0 ? m : latest,
		).id;
	}

	// Belt-and-suspenders: if hydrateToolCallsFromApi is called while a
	// previous call is still in flight for the same conversation, reuse the
	// pending promise instead of firing a parallel request. Prevents any
	// remaining call-site from accidentally spamming the endpoint.
	let hydratePending: { convId: string; promise: Promise<void> } | null = null;

	async function hydrateToolCallsFromApi(): Promise<void> {
		if (hydratePending && hydratePending.convId === convId) {
			return hydratePending.promise;
		}
		const run = (async () => {
			try {
				await doHydrate();
			} finally {
				hydratePending = null;
			}
		})();
		hydratePending = { convId, promise: run };
		return run;
	}

	async function doHydrate() {
		try {
			// Throttled + deduped by fetch-policy. Key is semantic (messages-tools:<cid>)
			// so querystring reshuffles or new callers still collapse to one request.
			const res = await backgroundFetch(
				`messages-tools:${convId}`,
				`/api/conversations/${convId}/messages?withToolCalls=true`,
				{},
				{ minIntervalMs: 5000 },
			);
			if (!res || !res.ok) return;
			const data = await res.json();
			const allTc: HistoricalToolCall[] = [];
			const hydrateInput: Array<{ id: string; extensionId: string; toolName: string; input: Record<string, unknown> | null; outputSummary: string | null; fullOutput?: string | null; success: boolean; durationMs: number; status: "success" | "error" | "interrupted"; messageId?: string; cardType?: string | null }> = [];
			for (const msg of data.messages ?? []) {
				for (const tc of msg.toolCalls ?? []) {
					allTc.push({ id: tc.id, messageId: msg.id, extensionId: tc.extensionId, toolName: tc.toolName, status: tc.status });
					hydrateInput.push({ ...tc, messageId: msg.id });
				}
			}
			// Also hydrate orphaned tool calls (from card action buttons / inline invocations)
			for (const tc of data.orphanedToolCalls ?? []) {
				hydrateInput.push({ ...tc, messageId: tc.messageId ?? undefined });
			}

			historicalToolCalls = allTc;
			inlineToolStore.hydrateToolCalls(convId, hydrateInput);

			if (data.subConversations?.length) {
				subConversations = data.subConversations.map((sc: any) => ({
					id: sc.id,
					agentName: sc.agentName ?? "Agent",
					agentConfigId: sc.agentConfigId ?? "",
					parentMessageId: sc.parentMessageId ?? "",
					messageCount: sc.messageCount ?? 0,
					lastMessagePreview: sc.lastMessagePreview ?? null,
				}));
			}

			// Hydrate sub-conversation tool calls so the Diff Summary panel
			// can show edits made by team members / invoked agents alongside
			// the parent's edits. Keyed by sub id — each call to
			// hydrateToolCalls(subId, …) replaces only that sub's entries.
			const subToolCalls = (data.subConversationToolCalls ?? {}) as Record<string, Array<{ id: string; extensionId: string; toolName: string; input: Record<string, unknown> | null; outputSummary: string | null; fullOutput?: string | null; success: boolean; durationMs: number; status: "success" | "error" | "interrupted"; messageId?: string | null; cardType?: string | null }>>;
			for (const [subId, calls] of Object.entries(subToolCalls)) {
				const subHydrateInput = calls.map((tc) => ({ ...tc, messageId: tc.messageId ?? undefined }));
				inlineToolStore.hydrateToolCalls(subId, subHydrateInput);
			}
		} catch { /* non-critical */ }
	}

	// Function-level dedup: if two callers (initial load + reconnect re-sync)
	// hit loadMessages() at the same moment, the second call gets the first
	// call's in-flight promise instead of launching a parallel three-fetch
	// cascade. Belt to the URL-level throttle's suspenders.
	let loadMessagesPending: { convId: string; promise: Promise<void> } | null = null;

	async function loadMessages() {
		if (!convId) return;
		if (loadMessagesPending && loadMessagesPending.convId === convId) {
			return loadMessagesPending.promise;
		}
		const capturedConvId = convId;
		const run = (async () => {
			try {
				await doLoadMessages();
			} finally {
				if (loadMessagesPending?.convId === capturedConvId) loadMessagesPending = null;
			}
		})();
		loadMessagesPending = { convId: capturedConvId, promise: run };
		return run;
	}

	async function doLoadMessages() {
		if (!convId) return;

		// Synchronously preload the user's last-used model from localStorage
		// BEFORE any await, so ModelSelector's parallel /api/models fetch doesn't
		// race in and fire onautoselect (which would persist models[0] to the DB
		// and clobber the conversation's actual stored model on next refresh).
		if (!selectedModel) {
			const preload = restoreLastModel(typeof localStorage !== "undefined" ? localStorage : null);
			if (preload) selectedModel = preload;
		}

		try {
			// Route both reads through the fetch-policy. A flaky SSE that
			// triggers N reconnect re-syncs in quick succession collapses to
			// a single actual pair of GETs, eliminating the visible spam of
			//   GET /api/conversations/:id
			//   GET /api/conversations/:id/messages?all=true
			// that used to appear once per reconnect cycle.
			const msgsRes = await backgroundFetch(
				`messages-all:${convId}`,
				`/api/conversations/${convId}/messages?all=true`,
				{},
				{ minIntervalMs: 5000 },
			);
			if (msgsRes && msgsRes.ok) {
				allMessages = await msgsRes.json();
			} else if (msgsRes === null) {
				// Throttled; skip this refresh. Existing allMessages stays current
				// because the WS push path has kept it live.
			}
			activeLeafId = computeLatestLeaf(allMessages);
			const convRes = await backgroundFetch(
				`conv:${convId}`,
				`/api/conversations/${convId}`,
				{},
				{ minIntervalMs: 5000 },
			);
			if (convRes && convRes.ok) {
				currentConversation = await convRes.json();
			}

			// Hydrate historical tool calls + sub-conversations from API
			await hydrateToolCallsFromApi();

			// The conversation's stored model (if any) wins over localStorage —
			// it represents a deliberate per-conversation override.
			if (currentConversation?.provider && currentConversation?.model) {
				selectedModel = { provider: currentConversation.provider, model: currentConversation.model };
			}
			// Restore mode from conversation
			const conv = currentConversation;
			if (conv?.modeId) {
				selectedMode = availableModes.find(m => m.id === conv.modeId) ?? null;
			} else {
				selectedMode = null;
			}
			editingMessageId = null;
			error = null;
			// Initial scroll-to-bottom is handled by the dedicated `initialScrollDone`
			// effect — it waits for the sentinel to exist in the DOM, so it's
			// reliable regardless of race conditions between fetchAllMessages
			// resolving and Svelte flushing the DOM. Crucially: it does NOT
			// re-fire on every loadMessages() call, so a reconnect-driven
			// re-sync cannot scrub the user's scroll position.
		} catch (err) {
			error = "Failed to load messages";
			console.error(err);
		}
	}

	async function handleSubConvoSend(text: string) {
		const active = subConversationStore.activeSubConversation;
		if (!active) return;
		subConversationStore.addMessage({
			id: `user-${Date.now()}`,
			role: "user",
			content: text,
			createdAt: new Date(),
		});
		// Send to sub-conversation's agent
		try {
			subConversationStore.setStreaming(true);
			const result = await sendMessage(active.id, {
				content: text,
				parentMessageId: undefined,
			});
			startStreaming(result.runId, active.id);
		} catch (err) {
			console.error("Sub-convo send failed:", err);
			subConversationStore.setStreaming(false);
		}
	}

	async function handleSubConvoReturn() {
		const msgs = subConversationStore.endSubConversation();
		// Insert last agent message as summary in parent conversation
		const lastAgentMsg = [...msgs].reverse().find(m => m.role === "assistant");
		if (lastAgentMsg && convId) {
			try {
				await sendMessage(convId, {
					content: `[Sub-conversation summary]: ${lastAgentMsg.content}`,
					parentMessageId: activeLeafId ?? undefined,
				});
				await loadMessages();
			} catch (err) {
				console.error("Failed to insert sub-convo summary:", err);
			}
		}
	}

	async function startSubConvo(agentMention: { name: string }, parentMessageId: string) {
		if (subConversationStore.isInSubConversation) return; // One at a time

		try {
			const subConv = await createSubConversation(convId, {
				parentMessageId,
				agentConfigId: "", // Will be resolved server-side by agent name
				title: `Sub-conversation with ${agentMention.name}`,
				projectId,
			});
			const record: SubConvoRecord = {
				id: subConv.id,
				agentName: agentMention.name,
				agentConfigId: subConv.agentConfigId ?? "",
				parentMessageId,
			};
			subConversations = [...subConversations, record];
			subConversationStore.startSubConversation({
				id: subConv.id,
				agentConfigId: record.agentConfigId,
				agentName: agentMention.name,
				parentConversationId: convId,
				parentMessageId,
			});
		} catch (err) {
			console.error("Failed to start sub-conversation:", err);
		}
	}

	async function handleSend(content: string, attachments?: File[]) {
		if (!convId) return;

		// Close all page-level panels and forms
		settingsOpen = false;
		obsOpen = false;
		editRetryCall = null;
		editRetryTool = null;

		// Handle OAuth code paste (if pending)
		if (chatOAuthPending) {
			const result = await completeOAuthWithCode(chatOAuthPending, content);
			chatOAuthPending = null;
			if (result.success) {
				addSystemMessage(`${PROVIDER_DISPLAY[result.provider] ?? result.provider} connected successfully!`);
			} else {
				addSystemMessage(`OAuth failed: ${result.error}`);
			}
			return;
		}

		// Handle /login commands before sending to API
		const loginCmd = isLoginCommand(content);
		if (loginCmd !== null) {
			const { provider } = loginCmd;
			if (!provider) {
				addSystemMessage("Usage: /login openai or /login google");
				return;
			}
			if (provider === "anthropic") {
				addSystemMessage("OAuth is not available for Anthropic. Please add your API key in Settings or use /config.");
				return;
			}
			if (provider === "openai" || provider === "google") {
				try {
					const pending = await startOAuthFlow(provider);
					chatOAuthPending = pending;
					window.open(pending.authUrl, "_blank");
					addSystemMessage(`Opening ${PROVIDER_DISPLAY[provider] ?? provider} login... Authentication should complete automatically. If it doesn't, paste the callback URL here.`);
				} catch (err) {
					addSystemMessage(`Failed to start OAuth: ${err instanceof Error ? err.message : "unknown error"}`);
				}
				return;
			}
			// Unknown provider
			addSystemMessage("Usage: /login openai or /login google");
			return;
		}

		// Handle /model commands
		const modelCmd = isModelCommand(content);
		if (modelCmd !== null) {
			if (modelCmd.type === "list") {
				try {
					const res = await fetch("/api/models");
					if (!res.ok) throw new Error("Failed to fetch models");
					const data: Array<{ provider: string; model: string; displayName?: string; available: boolean }> = await res.json();
					const available = data.filter((m) => m.available);
					if (available.length === 0) {
						addSystemMessage("No models available. Add API keys in Settings.");
					} else {
						const lines = available.map((m) => `  ${m.provider}/${m.model}${m.displayName ? ` (${m.displayName})` : ""}`);
						const current = selectedModel ? `Current: ${selectedModel.provider}/${selectedModel.model}` : "No model selected";
						addSystemMessage(`Available models:\n${lines.join("\n")}\n\n${current}\n\nUsage: /model provider/model-name`);
					}
				} catch {
					addSystemMessage("Failed to fetch available models.");
				}
				return;
			}

			// type === "switch"
			try {
				const res = await fetch("/api/models");
				if (!res.ok) throw new Error("Failed to fetch models");
				const data: Array<{ provider: string; model: string; available: boolean }> = await res.json();
				const available = data.filter((m) => m.available);

				let found: { provider: string; model: string } | null = null;

				if (modelCmd.provider) {
					found = available.find((m) => m.provider === modelCmd.provider && m.model === modelCmd.model) ?? null;
				} else {
					const matches = available.filter((m) => m.model === modelCmd.model);
					if (matches.length === 1) {
						found = matches[0]!;
					} else if (matches.length > 1) {
						const opts = matches.map((m) => `  ${m.provider}/${m.model}`).join("\n");
						addSystemMessage(`Multiple models match "${modelCmd.model}":\n${opts}\n\nSpecify the provider: /model provider/${modelCmd.model}`);
						return;
					}
				}

				if (found) {
					handleModelChange(found.provider, found.model);
					addSystemMessage(`Switched to ${found.provider}/${found.model}`);
				} else {
					addSystemMessage(`Model not found: ${modelCmd.provider ? modelCmd.provider + "/" : ""}${modelCmd.model}\n\nType /model to see available models.`);
				}
			} catch {
				addSystemMessage("Failed to fetch models for validation.");
			}
			return;
		}

		// Resolve activeLeafId — if it's a streaming placeholder, use its real parent instead
		let resolvedParentId = activeLeafId;
		if (resolvedParentId?.startsWith("streaming-")) {
			const placeholder = allMessages.find((m) => m.id === resolvedParentId);
			resolvedParentId = placeholder?.parentMessageId ?? null;
		}

		// Optimistic user message linked to current leaf
		const optimisticUserMsg: Message = {
			id: `temp-${Date.now()}`,
			conversationId: convId,
			role: "user",
			content,
			thinkingContent: null,
			model: null,
			provider: null,
			usage: null,
			runId: null,
			parentMessageId: resolvedParentId,
			createdAt: new Date().toISOString(),
		};
		allMessages = [...allMessages, optimisticUserMsg];
		activeLeafId = optimisticUserMsg.id;
		error = null;
		userScrolledUp = false;
		requestAnimationFrame(() => {
			sentinel?.scrollIntoView({ behavior: "instant" as ScrollBehavior });
		});

		try {
			const result = await sendMessage(convId, {
				content,
				provider: selectedModel?.provider,
				model: selectedModel?.model,
				parentMessageId: optimisticUserMsg.parentMessageId ?? undefined,
				permissionMode: permissionModeOverride,
				thinkingLevel: modelSupportsReasoning ? thinkingLevel : undefined,
				attachments,
			});

			// Replace optimistic user message with real one.
			// Merge attachments from the top-level response field so the card
			// renders immediately even if the server skipped embedding them on
			// userMessage.
			const realUserMsg: Message = result.attachments && result.attachments.length > 0
				? { ...result.userMessage, attachments: result.attachments }
				: result.userMessage;
			allMessages = allMessages.map((m) =>
				m.id === optimisticUserMsg.id ? realUserMsg : m,
			);

			// Start streaming (returns false if run already errored)
			const started = startStreaming(result.runId, convId);
			if (!started) {
				// Run completed/errored before POST returned — reconcile
				activeRunId = null;
				activeRunStartedAt = null;
				serverStalenessMs = null;
				await loadMessages();
				return;
			}
			activeRunId = result.runId;
			activeRunStartedAt = Date.now();
			serverStalenessMs = 0;
			resumedRun = false;

			// Add placeholder assistant message
			const assistantPlaceholder: Message = {
				id: `streaming-${result.runId}`,
				conversationId: convId,
				role: "assistant",
				content: "",
				thinkingContent: null,
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				usage: null,
				runId: result.runId,
				parentMessageId: result.userMessage.id,
				createdAt: new Date().toISOString(),
			};
			allMessages = [...allMessages, assistantPlaceholder];
			activeLeafId = assistantPlaceholder.id;

			// Auto-set title from first user message
			if (allMessages.filter((m) => m.role === "user").length === 1) {
				const title = content.substring(0, 50) + (content.length > 50 ? "..." : "");
				updateConversation(convId, { title }).then(() => convList?.refresh()).catch(() => {});
			}

			// Detect @agent mentions and start sub-conversation
			const mentions = parseMentions(content);
			const agentMention = mentions.find(m => m.kind === "agent");
			if (agentMention) {
				startSubConvo({ name: agentMention.name }, result.userMessage.id);
			}
		} catch (err) {
			error = "Failed to send message";
			console.error(err);
			allMessages = allMessages.filter((m) => m.id !== optimisticUserMsg.id);
			// Restore previous leaf
			activeLeafId = computeLatestLeaf(allMessages);
		}
	}

	function handleEdit(msg: Message) {
		editingMessageId = msg.id;
		editContent = msg.content;
	}

	async function submitEdit(msg: Message) {
		if (!convId || !editContent.trim()) return;
		editingMessageId = null;

		try {
			const result = await sendMessage(convId, {
				content: editContent,
				provider: selectedModel?.provider,
				model: selectedModel?.model,
				editOf: msg.id,
				thinkingLevel: modelSupportsReasoning ? thinkingLevel : undefined,
			});

			// Add the new user message to allMessages
			allMessages = [...allMessages, result.userMessage];

			// Start streaming for the AI response
			activeRunId = result.runId;
			activeRunStartedAt = Date.now();
			serverStalenessMs = 0;
			startStreaming(result.runId, convId);

			// Add placeholder assistant message
			const assistantPlaceholder: Message = {
				id: `streaming-${result.runId}`,
				conversationId: convId,
				role: "assistant",
				content: "",
				thinkingContent: null,
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				usage: null,
				runId: result.runId,
				parentMessageId: result.userMessage.id,
				createdAt: new Date().toISOString(),
			};
			allMessages = [...allMessages, assistantPlaceholder];
			activeLeafId = assistantPlaceholder.id;
		} catch (err) {
			error = "Failed to edit message";
			console.error(err);
		}
	}

	function cancelEdit() {
		editingMessageId = null;
		editContent = "";
	}

	async function handleRegenerate(msg: Message) {
		if (!convId) return;

		// Find the user message that preceded this assistant message in the current path
		const msgIndex = messages.findIndex((m) => m.id === msg.id);
		if (msgIndex <= 0) return;
		const precedingUserMsg = messages[msgIndex - 1];
		if (!precedingUserMsg || precedingUserMsg.role !== "user") return;

		try {
			// Re-send the user message content with editOf pointing to the assistant message
			const result = await sendMessage(convId, {
				content: precedingUserMsg.content,
				provider: selectedModel?.provider,
				model: selectedModel?.model,
				editOf: msg.id,
				thinkingLevel: modelSupportsReasoning ? thinkingLevel : undefined,
			});

			// Add the new user message (sibling of the original)
			allMessages = [...allMessages, result.userMessage];

			// Start streaming
			activeRunId = result.runId;
			activeRunStartedAt = Date.now();
			serverStalenessMs = 0;
			startStreaming(result.runId, convId);

			// Add placeholder assistant
			const assistantPlaceholder: Message = {
				id: `streaming-${result.runId}`,
				conversationId: convId,
				role: "assistant",
				content: "",
				thinkingContent: null,
				model: selectedModel?.model ?? null,
				provider: selectedModel?.provider ?? null,
				usage: null,
				runId: result.runId,
				parentMessageId: result.userMessage.id,
				createdAt: new Date().toISOString(),
			};
			allMessages = [...allMessages, assistantPlaceholder];
			activeLeafId = assistantPlaceholder.id;
		} catch (err) {
			error = "Failed to regenerate response";
			console.error(err);
		}
	}

	function handleBranchNavigate(messageId: string) {
		// Navigate to the branch containing this message by finding its leaf
		activeLeafId = findLeafFromAll(messageId);
	}

	function handleBranch(msg: Message) {
		// Branch from this message: set it as the active leaf and focus input
		activeLeafId = msg.id;
		requestAnimationFrame(() => chatInput?.focus());
	}

	async function handleSaveMemory(msg: Message) {
		try {
			const res = await userFetch("/api/memories", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: msg.content,
					category: "preferences",
					confidence: "medium",
				}),
			});
			if (res.status === 201) {
				const memory = await res.json();
				savedMemories = new Map(savedMemories).set(msg.id, memory.id);
			}
		} catch {
			// silent
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

	async function handleRetry(msg: Message) {
		// Find by ID first, fall back to content match (handles stale closure after reconcile)
		let idx = messages.findIndex((m) => m.id === msg.id);
		if (idx < 0) {
			idx = messages.findIndex((m) => m.role === msg.role && m.content === msg.content);
		}
		if (idx < 0) return;

		// Walk backwards to find the nearest user message
		let userMsg: Message | undefined;
		for (let i = idx - 1; i >= 0; i--) {
			if (messages[i]!.role === "user") {
				userMsg = messages[i];
				break;
			}
		}
		if (!userMsg) return;

		allMessages = allMessages.filter((m) => m.id !== messages[idx]!.id);
		activeLeafId = computeLatestLeaf(allMessages);
		await handleSend(userMsg.content);
	}

	async function handleFallback(msg: Message, provider: string, model: string) {
		const idx = messages.findIndex((m) => m.id === msg.id);
		if (idx <= 0) return;
		const userMsg = messages[idx - 1];
		if (!userMsg || userMsg.role !== "user") return;

		// Remove the error message, then re-send with suggested provider/model
		allMessages = allMessages.filter((m) => m.id !== msg.id);
		activeLeafId = computeLatestLeaf(allMessages);

		// Temporarily override selected model for this send
		const prevModel = selectedModel;
		selectedModel = { provider, model };
		await handleSend(userMsg.content);
		selectedModel = prevModel;
	}

	async function handleCreate() {
		try {
			const conv = await createConversation({ projectId });
			goto(`/project/${projectId}/chat/${conv.id}`);
		} catch (err) {
			console.error("Failed to create conversation:", err);
		}
	}

	// ── Select Mode handlers ─────────────────────────────────────────────

	function toggleSelectMode() {
		selectMode = !selectMode;
		if (!selectMode) {
			selectedIds = clearSelection();
			selectError = null;
		}
	}

	function toggleSelectedMessage(id: string) {
		selectedIds = toggleSelection(selectedIds, id);
	}

	async function handleForkSelection() {
		if (selectedIds.size === 0 || selectCloning) return;
		const orderedIds = orderedSelection(selectedIds, allMessages.map((m) => m.id));
		selectCloning = true;
		selectError = null;
		try {
			const newConv = await cloneTurns(convId, { messageIds: orderedIds });
			selectedIds = clearSelection();
			selectMode = false;
			goto(`/project/${projectId}/chat/${newConv.id}`);
		} catch (err) {
			selectError = err instanceof Error ? err.message : "Failed to fork selected turns";
			console.error("Failed to fork turns:", err);
		} finally {
			selectCloning = false;
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
		<!-- Chat Header -->
		<div class="flex items-center justify-between border-b border-[var(--color-border)] px-2 md:px-4 py-2 gap-1">
			<!-- Mobile menu button -->
			<button
				onclick={() => (mobileConvListOpen = true)}
				class="md:hidden flex items-center justify-center rounded-md p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)]"
				aria-label="Open conversations"
				style="min-width: 44px; min-height: 44px;"
			>
				<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
				</svg>
			</button>
			<span class="truncate text-sm font-medium text-[var(--color-text-secondary)] flex-1 min-w-0">
				<MentionText text={currentConversation?.title ?? "Chat"} />
			</span>
			<div class="flex items-center gap-1 shrink-0">
				<!-- Context usage -->
				<ContextUsageIndicator usedTokens={lastTurnInputTokens} contextWindow={selectedModelContextWindow} />
				<!-- Permission mode indicator -->
				<Tooltip position="bottom" text="How tool-use permission is granted for this project (ask / auto / deny)">
					<PermissionModeIndicator {projectId} conversationId={convId} onmodechange={(mode) => { permissionModeOverride = mode; }} />
				</Tooltip>
				<!-- Tool count indicator -->
				<Tooltip position="bottom" text="Tools loaded in this chat ({loadedTools.length}) — click to inspect names and token cost">
				<div class="relative">
					<button
						onclick={() => (toolsOpen = !toolsOpen)}
						class="flex items-center rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors {toolsOpen ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : ''}"
						aria-label="Loaded tools ({loadedTools.length})"
					>
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21.75 6.75a4.5 4.5 0 01-4.884 4.484c-1.076-.091-2.264.071-2.95.904l-7.152 8.684a2.548 2.548 0 11-3.586-3.586l8.684-7.152c.833-.686.995-1.874.904-2.95a4.5 4.5 0 016.336-4.486l-3.276 3.276a3.004 3.004 0 002.25 2.25l3.276-3.276c.256.565.398 1.192.398 1.852z" />
						</svg>
						<span class="text-[10px] ml-0.5">{loadedTools.length}</span>
					</button>
					{#if toolsOpen}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div data-testid="tools-backdrop" class="fixed inset-0 z-40" onclick={() => (toolsOpen = false)} onkeydown={() => {}}></div>
						<div data-testid="tools-popover" class="absolute right-0 top-full z-50 mt-1 w-[calc(100vw-2rem)] md:w-64 max-w-64 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-secondary)] shadow-lg max-h-72 overflow-y-auto">
							{#if loadedTools.length === 0}
								<p class="px-3 py-2 text-xs text-[var(--color-text-muted)]">No tools loaded</p>
							{:else}
								{#each [...toolsByExtension] as [ext, tools]}
									{@const extType = extensionTypeMap.get(ext) ?? "extension"}
									{@const groupTokens = tools.reduce((sum, t) => sum + (t.tokenEstimate ?? 0), 0)}
									<div class="px-3 py-2">
									<p class="text-xs font-bold text-[var(--color-text-secondary)] flex items-center gap-1.5">{ext}
											<span data-testid="type-badge" class="uppercase text-[9px] font-semibold px-1 py-0.5 rounded {extType === 'agent' ? 'bg-purple-900/50 text-purple-300' : extType === 'mcp' ? 'bg-blue-900/50 text-blue-300' : 'bg-green-900/50 text-green-300'}">{extType}</span>
											<span class="text-[var(--color-text-muted)] text-[9px] ml-auto inline-flex items-center gap-0.5">{groupTokens}<svg class="inline h-2.5 w-2.5" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/><text x="8" y="11.5" text-anchor="middle" font-size="9" font-weight="bold" fill="currentColor">T</text></svg></span>
										</p>
										{#each tools as tool}
											<p class="text-xs text-[var(--color-text-secondary)] pl-2 py-0.5" title={tool.description}>{tool.name}{#if tool.tokenEstimate}<span class="text-[var(--color-text-muted)] ml-1 inline-flex items-center gap-0.5">~{tool.tokenEstimate}<svg class="inline h-2.5 w-2.5" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/><text x="8" y="11.5" text-anchor="middle" font-size="9" font-weight="bold" fill="currentColor">T</text></svg></span>{/if}</p>
										{/each}
									</div>
								{/each}
								<div class="border-t border-[var(--color-border)] px-3 py-2 flex items-center justify-between">
									<span class="text-xs font-bold text-[var(--color-text-secondary)]">Total</span>
									<span class="text-[var(--color-text-secondary)] text-[9px] inline-flex items-center gap-0.5">{loadedTools.reduce((sum, t) => sum + (t.tokenEstimate ?? 0), 0)}<svg class="inline h-2.5 w-2.5" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/><text x="8" y="11.5" text-anchor="middle" font-size="9" font-weight="bold" fill="currentColor">T</text></svg></span>
								</div>
							{/if}
						</div>
					{/if}
				</div>
				</Tooltip>
				<Tooltip position="bottom" text="Review files changed by tool calls in this conversation">
				<button
						data-testid="diff-panel-btn"
						onclick={() => (diffPanelOpen = !diffPanelOpen)}
						class="relative rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors {diffPanelOpen ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : ''}"
						aria-label="Diff summary"
					>
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5.586a1 1 0 01.293-.707l5.414-5.414A1 1 0 0115.414 0H17a2 2 0 012 2v17a2 2 0 01-2 2z" />
						</svg>
						{#if diffFileCount > 0}
							<span data-testid="diff-badge" class="absolute -bottom-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold leading-none text-white">{diffFileCount}</span>
						{/if}
					</button>
				</Tooltip>
				<Tooltip position="bottom" text="Export this conversation as Markdown or JSON">
					<ExportMenu conversationId={convId} leafMessageId={activeLeafId ?? undefined} />
				</Tooltip>
				{#if showObsButton}
					<Tooltip position="bottom" text="Inspect tool-call traces and LLM request logs">
					<button
						onclick={() => (obsOpen = !obsOpen)}
						class="rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors {obsOpen ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : ''}"
						aria-label="Inspect observability"
					>
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
						</svg>
					</button>
					</Tooltip>
				{/if}
				<Tooltip position="bottom" text={isStreaming ? "Finish streaming turn before selecting" : selectMode ? "Exit select mode" : "Select turns to fork into a new chat"}>
				<button
					onclick={toggleSelectMode}
					disabled={isStreaming}
					class="rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed {selectMode ? 'bg-[var(--color-surface-tertiary)] text-[var(--color-text-primary)]' : ''}"
					aria-label={selectMode ? "Exit select mode" : "Select turns to fork into a new chat"}
					data-testid="select-mode-toggle"
					aria-pressed={selectMode}
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
					</svg>
				</button>
				</Tooltip>
				<Tooltip position="bottom" text="Configure this conversation (model, system prompt, extensions)">
				<button
					onclick={() => (settingsOpen = true)}
					class="rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
					aria-label="Conversation settings"
				>
					<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
							d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
					</svg>
				</button>
				</Tooltip>
			</div>
		</div>

		<!-- Messages -->
		<div bind:this={container} class="relative flex-1 overflow-y-auto">
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
							selectable={selectMode}
							selected={selectedIds.has(msg.id)}
							onselectionchange={toggleSelectedMessage}
							onedittext={msg.role === 'assistant' ? handleEditText : undefined}
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
					<InlineToolCard
						{call}
						onretry={handleInlineRetry}
						oneditretry={handleInlineEditRetry}
						oncancel={handleInlineCancel}
						onsendmessage={handleSend}
					/>
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

		{#if selectMode}
			<!-- Select-mode action bar replaces the composer so the fork action
			     stays visible and un-confused with a normal send. -->
			<div class="border-t border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-4 py-3" data-testid="select-action-bar">
				<div class="mx-auto flex max-w-3xl flex-col gap-2">
					<div class="flex items-center justify-between gap-3">
						<div class="text-sm text-[var(--color-text-primary)]">
							<span data-testid="selected-count" class="font-medium">{selectedIds.size}</span>
							{selectedIds.size === 1 ? 'turn' : 'turns'} selected
						</div>
						<div class="flex items-center gap-2">
							<button
								onclick={toggleSelectMode}
								disabled={selectCloning}
								class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-primary)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-tertiary)] disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								onclick={handleForkSelection}
								disabled={selectedIds.size === 0 || selectCloning}
								class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
								data-testid="new-chat-from-selection"
							>
								{selectCloning ? "Creating…" : "New Chat"}
							</button>
						</div>
					</div>
					{#if selectError}
						<div class="text-xs text-red-400" role="alert">{selectError}</div>
					{/if}
				</div>
			</div>
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
