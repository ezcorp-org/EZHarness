import {
	fetchAgents,
	fetchRuns,
	fetchProjects,
	fetchSettings,
	fetchAgentConfigs,
	fetchPipelines,
	type Agent,
	type Run,
	type Project,
	type Settings,
	type AgentConfig,
	type Pipeline,
	type PipelineRun,
} from "./api.js";
import { createWSClient, type WSEvent } from "./ws.js";
import { addToast } from "./toast.svelte.js";
import { inlineToolStore } from "./inline-tool-store.svelte.js";
import { unreadStore } from "./unread.js";
import { ContentBlockBuilder, type ContentBlock } from "./content-blocks.js";
export type { ContentBlock } from "./content-blocks.js";
import {
	registerSpawn as routingRegisterSpawn,
	unregisterSpawn as routingUnregisterSpawn,
	resolveRunForConversation as routingResolveRunForConversation,
	getActiveRunIdForConversation as routingGetActiveRunIdForConversation,
	type RoutingState,
} from "./sub-agent-routing.js";
import { readTeamPanel, writeTeamPanel } from "./panel-persistence.js";

let _wsManualRetry: (() => void) | null = null;
export function wsManualRetry() { _wsManualRetry?.(); }

/** Extract text from a ToolCallResult-shaped object, or return the value as-is if not recognized. */
function extractToolOutput(value: unknown): unknown {
	if (value == null || typeof value !== 'object') return value;
	const obj = value as Record<string, unknown>;
	if (Array.isArray(obj.content)) {
		const texts = (obj.content as any[])
			.filter((c: any) => c.type === 'text' && typeof c.text === 'string')
			.map((c: any) => c.text);
		if (texts.length > 0) return texts.join('\n');
	}
	return value;
}

export interface ToolCallState {
	id?: string;
	toolName: string;
	status: 'running' | 'complete' | 'error';
	input?: unknown;
	output?: unknown;
	error?: string;
	startedAt: number;
	duration?: number;
	extensionId?: string;
	cardType?: string;
	category?: string;
	permissionPending?: boolean;
}

export interface AgentCallState {
	subConversationId: string;
	agentName: string;
	agentConfigId: string;
	task: string;
	status: 'running' | 'complete' | 'error';
	statusText?: string;
	resultPreview?: string;
	agentRunId?: string;
	startedAt: number;
}

// ── Task tracking panel ──

export interface TaskPanelSubtask {
	id: string;
	title: string;
	completed: boolean;
	position: number;
}

export type AssignmentStatus = "assigned" | "running" | "completed" | "failed";

export interface TaskAssignment {
	id: string;
	agentConfigId: string;
	agentName: string;
	isTeam: boolean;
	status: AssignmentStatus;
	assignedAt: string;
	startedAt?: string;
	completedAt?: string;
	failedAt?: string;
	subConversationId?: string;
	agentRunId?: string;
	resultPreview?: string;
}

export interface TaskPanelTask {
	id: string;
	title: string;
	description: string;
	status: "pending" | "active" | "completed" | "failed";
	agentId?: string;
	agentName?: string;
	subtasks: TaskPanelSubtask[];
	assignments: TaskAssignment[];
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	failedAt?: string;
	failureReason?: string;
	completionSummary?: string;
	priority: number;
	/**
	 * Prerequisite task IDs. When any entry refers to a task that isn't
	 * `completed`, this task is "blocked" — the TaskPanel shows a "Waiting
	 * for: X, Y" badge and the AssignmentPill start button is disabled.
	 * See backend `TrackedTask.dependsOn` for the contract.
	 */
	dependsOn?: string[];
}

export interface TaskSnapshot {
	conversationId: string;
	tasks: TaskPanelTask[];
	activeTaskId?: string;
}

class AppStore {
	agents = $state<Agent[]>([]);
	runs = $state<Run[]>([]);
	connected = $state(false);
	projects = $state<Project[]>([]);
	activeProjectId = $state<string>(
		typeof localStorage !== "undefined" ? (localStorage.getItem("activeProjectId") ?? "global") : "global",
	);
	settings = $state<Settings>({});
	agentConfigs = $state<AgentConfig[]>([]);
	pipelines = $state<Pipeline[]>([]);
	pipelineRuns = $state<PipelineRun[]>([]);

	// Theme and layout state
	theme = $state<"dark" | "light" | "system">(
		typeof localStorage !== "undefined"
			? ((localStorage.getItem("ezcorp-theme") as "dark" | "light") ?? "system")
			: "system",
	);
	sidebarCollapsed = $state<boolean>(
		typeof localStorage !== "undefined" ? localStorage.getItem("pi-sidebar-collapsed") === "true" : false,
	);

	// Chat streaming state
	streamingMessages = $state<Record<string, string>>({});
	streamingThinking = $state<Record<string, string>>({});
	streamingRunToConversation = $state<Record<string, string>>({});
	streamingUsage = $state<Record<string, { inputTokens: number; outputTokens: number }>>({});
	streamingStatus = $state<Record<string, string>>({});
	// Tool call progress per run: runId -> array of tool calls
	streamingToolCalls = $state<Record<string, ToolCallState[]>>({});
	// Ordered content blocks per run for interleaved text/tool rendering
	streamingContentBlocks = $state<Record<string, ContentBlock[]>>({});
	// Agent sub-conversation tracking per run
	streamingAgentCalls = $state<Record<string, AgentCallState[]>>({});
	// Maps sub-conversation IDs and agent runIds to their root (user-visible)
	// runId so that events fired on sub-conversations (tool permissions etc.)
	// can be routed back to the parent conversation the user is watching.
	subConvToRootRun = $state<Record<string, string>>({});
	agentRunToRootRun = $state<Record<string, string>>({});
	// Orchestration: pending human input requests
	pendingHumanInputs = $state<Record<string, { runId: string; conversationId: string; question: string; requestId: string }>>({});
	// Tracks the run ID that triggered a memory_unavailable event (null = recovered)
	memoryUnavailableRunId = $state<string | null>(null);
	// Track runs that completed before startStreaming was called (race condition)
	completedBeforeStream = $state<Set<string>>(new Set());
	// Task panel snapshots per conversation (updated via task:snapshot WS events)
	taskSnapshots = $state<Record<string, TaskSnapshot>>({});
	// Bumped on each WS reconnect so $effects can re-fetch stale state
	wsReconnectCount = $state(0);
	// Server-reported staleness for the active run of each conversation. Populated by the
	// chat page's zombie-timer $effect from the /active-run GET response (stalenessMs field).
	// Drives the StuckRunBanner so users can see when the backend is silent.
	runStaleness = $state<Record<string, { stalenessMs: number; startedAt: number }>>({});
	// Extension panel states (updated via ext:state WS events from sandboxed extensions)
	extensionPanelStates = $state<Record<string, { extensionName: string; state: Record<string, unknown> }>>({});
	// Team panel state for viewing agent team details. Restored from
	// localStorage on app load so the panel reopens to its prior state
	// after a refresh; persisted on every mutation via the helpers below.
	teamPanel = $state<{
		open: boolean;
		agentConfigId: string | null;
		teamName: string | null;
		conversationId: string | null;
		drillDownAgent: { subConversationId: string; agentName: string; turnIndex?: number } | null;
	}>(readTeamPanel() ?? { open: false, agentConfigId: null, teamName: null, conversationId: null, drillDownAgent: null });
}

export const store = new AppStore();

export function setActiveProjectId(id: string | null) {
	store.activeProjectId = id ?? "global";
	if (typeof localStorage !== "undefined") {
		localStorage.setItem("activeProjectId", store.activeProjectId);
	}
}

export function refreshProjects() {
	fetchProjects()
		.then((data) => (store.projects = data))
		.catch(() => {});
}

export function refreshSettings() {
	fetchSettings()
		.then((data) => (store.settings = data))
		.catch(() => {});
}

export function refreshAgentConfigs() {
	fetchAgentConfigs()
		.then((data) => (store.agentConfigs = data))
		.catch(() => {});
}

export function refreshPipelines() {
	fetchPipelines()
		.then((data) => (store.pipelines = data))
		.catch(() => {});
}

// ── Chat streaming helpers ──────────────────────────────────────────

/** Content block builders per run (imperative, not reactive — snapshots are pushed to store) */
const blockBuilders = new Map<string, ContentBlockBuilder>();

/** Token buffer for requestAnimationFrame batching */
let tokenBuffer: Record<string, string> = {};
let thinkingTokenBuffer: Record<string, string> = {};
let rafPending = false;

/** Flush buffered tokens for a single run. Called before tool_ref insertion to preserve ordering. */
function flushTokensForRun(runId: string) {
	const tokens = tokenBuffer[runId];
	if (!tokens) return;
	delete tokenBuffer[runId];
	if (store.streamingRunToConversation[runId] !== undefined || store.streamingMessages[runId] !== undefined) {
		const current = store.streamingMessages[runId] ?? "";
		store.streamingMessages = { ...store.streamingMessages, [runId]: current + tokens };
		const builder = blockBuilders.get(runId);
		if (builder) {
			builder.appendText(tokens);
			store.streamingContentBlocks = { ...store.streamingContentBlocks, [runId]: builder.snapshot() };
		}
	}
}

function flushTokenBuffer() {
	rafPending = false;
	// Flush thinking tokens
	for (const [runId, tokens] of Object.entries(thinkingTokenBuffer)) {
		if (store.streamingRunToConversation[runId] !== undefined || store.streamingThinking[runId] !== undefined) {
			const current = store.streamingThinking[runId] ?? "";
			store.streamingThinking = { ...store.streamingThinking, [runId]: current + tokens };
			const builder = blockBuilders.get(runId);
			if (builder) {
				builder.appendThinking(tokens);
				store.streamingContentBlocks = { ...store.streamingContentBlocks, [runId]: builder.snapshot() };
			}
		}
	}
	thinkingTokenBuffer = {};
	// Flush text tokens
	for (const [runId, tokens] of Object.entries(tokenBuffer)) {
		// Only flush if still actively streaming (not yet stopped)
		if (store.streamingRunToConversation[runId] !== undefined || store.streamingMessages[runId] !== undefined) {
			const current = store.streamingMessages[runId] ?? "";
			store.streamingMessages = {
				...store.streamingMessages,
				[runId]: current + tokens,
			};
			// Also append to content block builder and push snapshot
			const builder = blockBuilders.get(runId);
			if (builder) {
				builder.appendText(tokens);
				store.streamingContentBlocks = {
					...store.streamingContentBlocks,
					[runId]: builder.snapshot(),
				};
			}
		}
	}
	tokenBuffer = {};
}

function scheduleFlush() {
	if (!rafPending && typeof requestAnimationFrame !== "undefined") {
		rafPending = true;
		requestAnimationFrame(flushTokenBuffer);
	} else if (typeof requestAnimationFrame === "undefined") {
		flushTokenBuffer();
	}
}

function bufferToken(runId: string, token: string) {
	tokenBuffer[runId] = (tokenBuffer[runId] ?? "") + token;
	scheduleFlush();
}

function bufferThinkingToken(runId: string, token: string) {
	thinkingTokenBuffer[runId] = (thinkingTokenBuffer[runId] ?? "") + token;
	scheduleFlush();
}

/** Returns false if the run already completed/errored before streaming could start */
export function startStreaming(runId: string, conversationId: string): boolean {
	// If the run already completed/errored before we got here, don't start streaming
	if (store.completedBeforeStream.has(runId)) {
		store.completedBeforeStream = new Set([...store.completedBeforeStream].filter(id => id !== runId));
		return false;
	}
	const existing = store.streamingMessages[runId] ?? "";
	store.streamingMessages = { ...store.streamingMessages, [runId]: existing };
	store.streamingThinking = { ...store.streamingThinking, [runId]: "" };
	store.streamingRunToConversation = { ...store.streamingRunToConversation, [runId]: conversationId };
	blockBuilders.set(runId, new ContentBlockBuilder());
	store.streamingContentBlocks = { ...store.streamingContentBlocks, [runId]: [] };
	store.streamingAgentCalls = { ...store.streamingAgentCalls, [runId]: [] };
	return true;
}

export function getStreamingText(runId: string): string | undefined {
	return store.streamingMessages[runId];
}

export function stopStreaming(runId: string) {
	const { [runId]: _, ...rest } = store.streamingMessages;
	store.streamingMessages = rest;
	const { [runId]: _t, ...restThinking } = store.streamingThinking;
	store.streamingThinking = restThinking;
	const { [runId]: __, ...restConv } = store.streamingRunToConversation;
	store.streamingRunToConversation = restConv;
	const { [runId]: ___, ...restStatus } = store.streamingStatus;
	store.streamingStatus = restStatus;
	const { [runId]: ____, ...restTools } = store.streamingToolCalls;
	store.streamingToolCalls = restTools;
	blockBuilders.delete(runId);
	const { [runId]: _____, ...restBlocks } = store.streamingContentBlocks;
	store.streamingContentBlocks = restBlocks;
	const { [runId]: ______, ...restAgents } = store.streamingAgentCalls;
	store.streamingAgentCalls = restAgents;
}

export function getStreamingStatus(runId: string): string | undefined {
	return store.streamingStatus[runId];
}

export function getStreamingConversationId(runId: string): string | undefined {
	return store.streamingRunToConversation[runId];
}

export function isConversationStreaming(conversationId: string): boolean {
	return Object.values(store.streamingRunToConversation).includes(conversationId);
}

/** Build a snapshot of the store's routing state for the pure routing module. */
function routingSnapshot(): RoutingState {
	return {
		streamingRunToConversation: store.streamingRunToConversation,
		subConvToRootRun: store.subConvToRootRun,
		agentRunToRootRun: store.agentRunToRootRun,
	};
}

/** Apply a new routing state to the store, writing back only the maps that changed. */
function applyRoutingState(next: RoutingState): void {
	if (next.streamingRunToConversation !== store.streamingRunToConversation) {
		store.streamingRunToConversation = next.streamingRunToConversation;
	}
	if (next.subConvToRootRun !== store.subConvToRootRun) {
		store.subConvToRootRun = next.subConvToRootRun;
	}
	if (next.agentRunToRootRun !== store.agentRunToRootRun) {
		store.agentRunToRootRun = next.agentRunToRootRun;
	}
}

export function getActiveRunIdForConversation(conversationId: string): string | undefined {
	return routingGetActiveRunIdForConversation(routingSnapshot(), conversationId);
}

/**
 * Resolve an event's conversationId to the root (user-visible) runId.
 * Handles both root conversations and sub-conversations spawned by agents,
 * so events fired by sub-agents reach the UI the user is watching.
 */
export function resolveRunForConversation(conversationId: string): string | undefined {
	return routingResolveRunForConversation(routingSnapshot(), conversationId);
}

/** Send permission response (allow/deny) for a pending tool call */
export async function sendToolPermissionResponse(toolCallId: string, approved: boolean): Promise<void> {
	await fetch(`/api/tool-calls/${toolCallId}/permission`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ approved }),
	});
}

/** Send kill signal for a running tool call */
export function sendToolKill(toolCallId: string): void {
	fetch(`/api/tool-calls/${toolCallId}/kill`, { method: 'POST' }).catch(() => {});
}

export function getStreamingToolCalls(runId: string): ToolCallState[] {
	return store.streamingToolCalls[runId] ?? [];
}

export function getStreamingContentBlocks(runId: string): ContentBlock[] {
	return store.streamingContentBlocks[runId] ?? [];
}

export function getStreamingAgentCalls(runId: string): AgentCallState[] {
	return store.streamingAgentCalls[runId] ?? [];
}

export function getPendingHumanInputs(conversationId: string): Array<{ runId: string; conversationId: string; question: string; requestId: string }> {
	return Object.values(store.pendingHumanInputs).filter(h => h.conversationId === conversationId);
}

export function getTaskSnapshot(conversationId: string): TaskSnapshot | undefined {
	return store.taskSnapshots[conversationId];
}

export function getWsReconnectCount(): number {
	return store.wsReconnectCount;
}

export function setTaskSnapshot(snapshot: TaskSnapshot): void {
	store.taskSnapshots = { ...store.taskSnapshots, [snapshot.conversationId]: snapshot };
}

/** Read-only accessor for the server-reported staleness of a conversation's active run. */
export function getRunStaleness(conversationId: string): { stalenessMs: number; startedAt: number } | undefined {
	return store.runStaleness[conversationId];
}

/** Called by the chat page's zombie-timer on every /active-run poll. Pass null to clear. */
export function setRunStaleness(conversationId: string, value: { stalenessMs: number; startedAt: number } | null): void {
	if (value === null) {
		if (conversationId in store.runStaleness) {
			const { [conversationId]: _removed, ...rest } = store.runStaleness;
			store.runStaleness = rest;
		}
		return;
	}
	store.runStaleness = { ...store.runStaleness, [conversationId]: value };
}

// ── Team panel helpers ──

export function openTeamPanel(conversationId: string, agentConfigId: string, teamName: string): void {
	store.teamPanel = {
		open: true, agentConfigId, teamName, conversationId, drillDownAgent: null,
	};
	writeTeamPanel(store.teamPanel);
}

export function closeTeamPanel(): void {
	store.teamPanel = {
		open: false, agentConfigId: null, teamName: null, conversationId: null, drillDownAgent: null,
	};
	writeTeamPanel(store.teamPanel);
}

export function openTeamDrillDown(subConversationId: string, agentName: string, turnIndex?: number): void {
	store.teamPanel = { ...store.teamPanel, drillDownAgent: { subConversationId, agentName, turnIndex } };
	writeTeamPanel(store.teamPanel);
}

export function closeTeamDrillDown(): void {
	store.teamPanel = { ...store.teamPanel, drillDownAgent: null };
	writeTeamPanel(store.teamPanel);
}

export function initStores() {
	fetchAgents()
		.then((data) => (store.agents = data))
		.catch(() => {});

	fetchRuns()
		.then((data) => (store.runs = data))
		.catch(() => {});

	refreshProjects();
	refreshSettings();
	refreshAgentConfigs();
	refreshPipelines();

	const client = createWSClient();
	_wsManualRetry = client.manualRetry;

	const unsub = client.subscribe((event: WSEvent) => {
		switch (event.type) {
			case "ws:connected":
				store.connected = true;
				store.wsReconnectCount++;
				return;

			case "ws:disconnected":
				store.connected = false;
				return;

			case "run:start": {
				const { run } = event.data as { run: Run };
				const idx = store.runs.findIndex((r) => r.id === run.id);
				if (idx >= 0) {
					store.runs[idx] = run;
				} else {
					store.runs = [run, ...store.runs];
				}
				break;
			}

			case "run:log": {
				const { runId, log } = event.data as { runId: string; log: unknown };
				store.runs = store.runs.map((r) => {
					if (r.id === runId) {
						return { ...r, logs: [...r.logs, log as Run["logs"][number]] };
					}
					return r;
				});
				break;
			}

			case "run:status": {
				const { runId, status } = event.data as { runId: string; status: string };
				store.streamingStatus = { ...store.streamingStatus, [runId]: status };
				if (status === "memory_unavailable") {
					store.memoryUnavailableRunId = runId;
				} else if (store.memoryUnavailableRunId !== null) {
					// Recovery: a non-memory_unavailable status clears the flag
					store.memoryUnavailableRunId = null;
				}
				break;
			}

			case "run:token": {
				const { runId, token, kind } = event.data as { runId: string; token: string; kind?: string };
				if (kind === "thinking") {
					bufferThinkingToken(runId, token);
				} else {
					bufferToken(runId, token);
				}
				break;
			}

			case "run:usage": {
				const { runId, usage } = event.data as {
					runId: string;
					usage: { inputTokens: number; outputTokens: number };
				};
				store.streamingUsage = { ...store.streamingUsage, [runId]: usage };
				break;
			}

			case "run:turn_text_reset": {
				const { runId } = event.data as { runId: string };
				// Reset streaming text and thinking buffers — next turn's tokens start from empty
				store.streamingMessages = { ...store.streamingMessages, [runId]: "" };
				store.streamingThinking = { ...store.streamingThinking, [runId]: "" };
				// Clear streaming tool calls — they're now persisted in DB
				store.streamingToolCalls = { ...store.streamingToolCalls, [runId]: [] };
				// DON'T reset streamingAgentCalls — agents persist across turns
				// (they were spawned in turn 1, synthesized in turn 2)
				// Reset content block builder for next turn, but re-inject agent refs
				const resetBuilder = blockBuilders.get(runId);
				if (resetBuilder) {
					resetBuilder.reset();
					// Re-inject agent_ref blocks for agents spawned in previous turns
					const existingAgents = store.streamingAgentCalls[runId] ?? [];
					for (let i = 0; i < existingAgents.length; i++) {
						resetBuilder.pushAgentRef();
					}
					store.streamingContentBlocks = { ...store.streamingContentBlocks, [runId]: resetBuilder.snapshot() };
				} else {
					store.streamingContentBlocks = { ...store.streamingContentBlocks, [runId]: [] };
				}
				break;
			}

			case "run:turn_saved": {
				const { runId, conversationId, messageId, parentMessageId, content } = event.data as {
					runId: string; conversationId: string; messageId: string; parentMessageId: string | null; content: string;
				};
				// Dispatch DOM event for chat page to handle message list update
				if (typeof window !== "undefined") {
					window.dispatchEvent(new CustomEvent("ez:turn_saved", {
						detail: { runId, conversationId, messageId, parentMessageId, content },
					}));
				}
				break;
			}

			case "run:complete":
			case "run:error":
			case "run:cancel": {
				const { run: updated } = event.data as { run: Run };
				const conversationId = store.streamingRunToConversation[updated.id];
				store.runs = store.runs.map((r) => (r.id === updated.id ? updated : r));
				// Mark any still-running agent pills as cancelled/error before cleanup
				const pendingAgents = store.streamingAgentCalls[updated.id];
				if (pendingAgents?.some(a => a.status === "running")) {
					const finalStatus = event.type === "run:complete" ? "complete" as const : "error" as const;
					store.streamingAgentCalls = {
						...store.streamingAgentCalls,
						[updated.id]: pendingAgents.map(a => a.status === "running"
							? { ...a, status: finalStatus, resultPreview: event.type === "run:error" ? "Cancelled — parent run failed" : undefined }
							: a),
					};
				}
				// Clean up streaming state for completed runs
				if (conversationId !== undefined) {
					stopStreaming(updated.id);
				} else {
					// Run completed before startStreaming was called — track it
					store.completedBeforeStream = new Set([...store.completedBeforeStream, updated.id]);
				}
				// Toast notifications for completion/error (not cancel)
				if (event.type === "run:complete") {
					const viewingConv = conversationId && typeof window !== "undefined"
						&& window.location.pathname.includes(conversationId);
					if (!viewingConv) {
						if (conversationId) unreadStore.markUnread(conversationId);
						addToast({
							type: "success",
							message: "Run completed",
							action: { label: "View", onclick: () => { window.location.href = `/runs/${updated.id}`; } },
						});
					}
				} else if (event.type === "run:error") {
					addToast({
						type: "error",
						message: `Run failed: ${(updated as any).error || "Unknown error"}`,
						action: { label: "View", onclick: () => { window.location.href = `/runs/${updated.id}`; } },
					});
				}
				break;
			}

			case "pipeline:start": {
				const { pipelineRun } = event.data as { pipelineRun: PipelineRun };
				store.pipelineRuns = [pipelineRun, ...store.pipelineRuns];
				break;
			}

			case "pipeline:step":
			case "pipeline:complete":
			case "pipeline:error": {
				const { pipelineRun } = event.data as { pipelineRun: PipelineRun };
				store.pipelineRuns = store.pipelineRuns.map((r) => (r.id === pipelineRun.id ? pipelineRun : r));
				break;
			}

			case "tool:start": {
				const { conversationId, toolName, input, timestamp, extensionId, source, invocationId, cardType, category } = event.data as {
					conversationId: string; toolName: string; input: unknown; timestamp: number; extensionId?: string; source?: string; invocationId?: string; cardType?: string; category?: string;
				};
				if (source === 'inline' && invocationId) {
					inlineToolStore.updateFromEvent(invocationId, 'tool:start', { timestamp, ...(cardType ? { cardType } : {}) });
					break;
				}
				// Live Diff Summary panel: upsert non-inline tool calls into the
				// inline store keyed by invocationId. This is the push path that
				// replaces the previous DOM-event + full-refetch hack — when a
				// sub-agent edits a file, its tool:complete arrives here directly
				// and the panel updates within the same tick.
				if (invocationId) {
					inlineToolStore.upsertStreaming({
						id: invocationId,
						conversationId,
						extensionName: extensionId ?? 'builtin',
						toolName,
						input: (input ?? {}) as Record<string, unknown>,
						status: 'running',
						startedAt: timestamp,
						...(cardType ? { cardType } : {}),
					});
				}
				// Find runId from conversationId
				const runId = Object.entries(store.streamingRunToConversation)
					.find(([, cId]) => cId === conversationId)?.[0];
				if (runId) {
					// Flush any buffered tokens BEFORE inserting tool_ref to preserve text/tool ordering
					flushTokensForRun(runId);
					const existing = store.streamingToolCalls[runId] ?? [];
					store.streamingToolCalls = {
						...store.streamingToolCalls,
						[runId]: [...existing, { toolName, status: 'running', input, startedAt: timestamp, extensionId, cardType, category }],
					};
					// Insert tool_ref into content blocks
					const tcBuilder = blockBuilders.get(runId);
					if (tcBuilder) {
						tcBuilder.pushToolRef();
						store.streamingContentBlocks = {
							...store.streamingContentBlocks,
							[runId]: tcBuilder.snapshot(),
						};
					}
				}
				break;
			}

			case "tool:complete": {
				const { conversationId, toolName, output, duration, success: completeSuccess, source: completeSource, invocationId: completeInvId, cardType: completeCardType } = event.data as {
					conversationId: string; toolName: string; output: unknown; duration: number; success?: boolean; source?: string; invocationId?: string; cardType?: string;
				};
				if (completeSource === 'inline' && completeInvId) {
					if (completeSuccess === false) {
						inlineToolStore.updateFromEvent(completeInvId, 'tool:error', { error: output, duration });
					} else {
						inlineToolStore.updateFromEvent(completeInvId, 'tool:complete', { output, duration, ...(completeCardType ? { cardType: completeCardType } : {}) });
					}
					break;
				}
				// Live Diff Summary panel: finalize the streaming entry in the
				// inline store. Matches the tool:start upsert above. `input`
				// is intentionally omitted so the entry's original input from
				// tool:start is preserved — the panel's diff aggregator keys
				// off `input.file_path` / `input.path`.
				if (completeInvId) {
					const extracted = extractToolOutput(output);
					const outputText = typeof extracted === 'string' ? extracted : JSON.stringify(extracted);
					inlineToolStore.upsertStreaming({
						id: completeInvId,
						conversationId,
						extensionName: 'builtin',
						toolName,
						status: completeSuccess === false ? 'error' : 'complete',
						output: outputText,
						duration,
						...(completeCardType ? { cardType: completeCardType } : {}),
					});
				}
				const runId = Object.entries(store.streamingRunToConversation)
					.find(([, cId]) => cId === conversationId)?.[0];
				if (runId) {
					const calls = store.streamingToolCalls[runId] ?? [];
					// Find the latest running call with matching toolName
					const idx = calls.findLastIndex((tc) => tc.toolName === toolName && tc.status === 'running');
					if (idx >= 0) {
						const updated = [...calls];
						updated[idx] = { ...updated[idx]!, status: 'complete', output: extractToolOutput(output), duration, permissionPending: false };
						store.streamingToolCalls = { ...store.streamingToolCalls, [runId]: updated };
					}
				}
				break;
			}

			case "tool:error": {
				const { conversationId, toolName, error: toolError, duration, source: errorSource, invocationId: errorInvId } = event.data as {
					conversationId: string; toolName: string; error: string; duration: number; source?: string; invocationId?: string;
				};
				if (errorSource === 'inline' && errorInvId) {
					inlineToolStore.updateFromEvent(errorInvId, 'tool:error', { error: toolError, duration });
					break;
				}
				// Live Diff Summary panel: mark the streaming entry as errored.
				// `input` omitted on purpose (see tool:complete above).
				if (errorInvId) {
					inlineToolStore.upsertStreaming({
						id: errorInvId,
						conversationId,
						extensionName: 'builtin',
						toolName,
						status: 'error',
						error: toolError,
						duration,
					});
				}
				const runId = Object.entries(store.streamingRunToConversation)
					.find(([, cId]) => cId === conversationId)?.[0];
				if (runId) {
					const calls = store.streamingToolCalls[runId] ?? [];
					const idx = calls.findLastIndex((tc) => tc.toolName === toolName && tc.status === 'running');
					if (idx >= 0) {
						const updated = [...calls];
						updated[idx] = { ...updated[idx]!, status: 'error', error: toolError, duration };
						store.streamingToolCalls = { ...store.streamingToolCalls, [runId]: updated };
					}
				}
				addToast({ type: "warning", message: `Tool "${toolName}" failed` });
				break;
			}

			case "tool:permission_request": {
				const { conversationId, toolCallId, toolName: permToolName, input: permInput, cardType: permCardType, category: permCategory } = event.data as {
					conversationId: string; toolCallId: string; toolName: string; input: unknown; cardType?: string; category?: string;
				};
				// Resolve root run — handles both root conversations and sub-agent conversations
				const runId = resolveRunForConversation(conversationId);
				if (runId) {
					const calls = store.streamingToolCalls[runId] ?? [];
					// Find existing tool call or create one
					const idx = calls.findLastIndex((tc) => tc.toolName === permToolName && tc.status === 'running');
					if (idx >= 0) {
						const updated = [...calls];
						updated[idx] = { ...updated[idx]!, id: toolCallId, permissionPending: true, cardType: permCardType, category: permCategory };
						store.streamingToolCalls = { ...store.streamingToolCalls, [runId]: updated };
					} else {
						store.streamingToolCalls = {
							...store.streamingToolCalls,
							[runId]: [...calls, { id: toolCallId, toolName: permToolName, status: 'running', input: permInput, startedAt: Date.now(), permissionPending: true, cardType: permCardType, category: permCategory }],
						};
					}
				} else {
					// No root run found — this shouldn't happen if agent:spawn was received
					// Surface a toast so the user can manually deny/approve via the sub-conversation view
					console.warn("[permission] Could not resolve root run for conversation", conversationId, "tool", permToolName);
					addToast({ type: "warning", message: `Sub-agent "${permToolName}" is waiting for permission. Open the sub-conversation to approve.` });
				}
				break;
			}

			// ── Multi-Agent Orchestration Events ──

			case "agent:spawn": {
				const { runId, subConversationId, agentName, agentConfigId, task, agentRunId } = event.data as {
					runId: string; subConversationId: string; agentName: string; agentConfigId: string; task: string; agentRunId: string;
				};
				// Register sub-conversation → root run mapping so events fired by
				// the sub-agent (tool permissions etc.) reach the UI. Nested
				// spawns inherit the root via agentRunToRootRun, handled by
				// the pure routing module.
				applyRoutingState(routingRegisterSpawn(routingSnapshot(), { runId, agentRunId, subConversationId }));
				// Flush buffered tokens to preserve text/agent ordering
				flushTokensForRun(runId);
				const existing = store.streamingAgentCalls[runId] ?? [];
				// Deduplicate: if this agent already has a pill (persistent sub-conversation), update it
				const existingIdx = existing.findIndex(a => a.subConversationId === subConversationId);
				if (existingIdx >= 0) {
					const updated = [...existing];
					updated[existingIdx] = { ...updated[existingIdx]!, status: 'running', statusText: undefined, resultPreview: undefined, task, agentRunId, startedAt: Date.now() };
					store.streamingAgentCalls = { ...store.streamingAgentCalls, [runId]: updated };
					break;
				}
				store.streamingAgentCalls = {
					...store.streamingAgentCalls,
					[runId]: [...existing, { subConversationId, agentName, agentConfigId, task, status: 'running', agentRunId, startedAt: Date.now() }],
				};
				// Insert agent_ref into content blocks (only for new agents, not re-invocations)
				const agentBuilder = blockBuilders.get(runId);
				if (agentBuilder) {
					agentBuilder.pushAgentRef();
					store.streamingContentBlocks = { ...store.streamingContentBlocks, [runId]: agentBuilder.snapshot() };
				}
				break;
			}

			case "agent:status": {
				const { runId, subConversationId, status: agentStatus } = event.data as {
					runId: string; subConversationId: string; status: string;
				};
				const agents = store.streamingAgentCalls[runId];
				if (agents) {
					store.streamingAgentCalls = {
						...store.streamingAgentCalls,
						[runId]: agents.map(a => a.subConversationId === subConversationId ? { ...a, statusText: agentStatus } : a),
					};
				}
				break;
			}

			case "agent:complete": {
				const { runId, subConversationId, agentName: completeAgentName, success: agentSuccess, resultPreview, agentRunId: completeAgentRunId } = event.data as {
					runId: string; subConversationId: string; agentName: string; success: boolean; resultPreview: string; agentRunId?: string; parentConversationId?: string;
				};
				const agentCalls = store.streamingAgentCalls[runId];
				if (agentCalls) {
					store.streamingAgentCalls = {
						...store.streamingAgentCalls,
						[runId]: agentCalls.map(a => a.subConversationId === subConversationId
							? { ...a, status: agentSuccess ? 'complete' as const : 'error' as const, resultPreview }
							: a),
					};
				}
				// Top-level signal for sub-agent failures. The red AgentChip is easy to miss;
				// a toast makes sure users notice even if the panel is collapsed or the failing
				// chip is buried among others.
				if (!agentSuccess) {
					addToast({
						type: "error",
						message: `Agent "${completeAgentName}" failed: ${resultPreview ?? "Unknown error"}`,
					});
				}
				// NOTE: live updates to the parent's Diff Summary panel are now
				// driven directly from tool:complete events (see above). No
				// DOM custom event / refetch hack is needed here — by the time
				// this agent:complete fires, every sub-agent tool call has
				// already arrived on the bus and been upserted into the inline
				// tool store.
				// Notify the chat page so it can re-hydrate sub-conversation data
				const parentConvId = (event.data as Record<string, unknown>).parentConversationId as string | undefined;
				if (parentConvId && typeof window !== "undefined") {
					window.dispatchEvent(new CustomEvent("ez:agent_complete", {
						detail: { parentConversationId: parentConvId, subConversationId },
					}));
				}
				// Clean up sub-conversation → root run mappings via the pure routing module
				applyRoutingState(routingUnregisterSpawn(routingSnapshot(), { subConversationId, agentRunId: completeAgentRunId }));
				break;
			}

			// ── Orchestration: Human-in-the-Loop ──

			case "orchestrator:human_input": {
				const { runId, conversationId, question, requestId } = event.data as {
					runId: string; conversationId: string; question: string; requestId: string;
				};
				store.pendingHumanInputs = {
					...store.pendingHumanInputs,
					[requestId]: { runId, conversationId, question, requestId },
				};
				break;
			}

			case "orchestrator:human_response": {
				const { requestId } = event.data as { requestId: string };
				const { [requestId]: _, ...rest } = store.pendingHumanInputs;
				store.pendingHumanInputs = rest;
				break;
			}

			case "task:snapshot": {
				const snapshot = event.data as unknown as TaskSnapshot;
				if (snapshot?.conversationId) {
					store.taskSnapshots = {
						...store.taskSnapshots,
						[snapshot.conversationId]: snapshot,
					};
				}
				break;
			}

			case "task:assignment_update": {
				const { conversationId, taskId, assignment } = event.data as {
					conversationId: string; taskId: string; assignment: TaskAssignment;
				};
				const snapshot = store.taskSnapshots[conversationId];
				if (snapshot) {
					const task = snapshot.tasks.find(t => t.id === taskId);
					if (task) {
						const idx = (task.assignments ?? []).findIndex(a => a.id === assignment.id);
						if (idx >= 0) {
							task.assignments[idx] = assignment;
						} else {
							task.assignments = [...(task.assignments ?? []), assignment];
						}
						// Trigger reactivity
						store.taskSnapshots = { ...store.taskSnapshots, [conversationId]: { ...snapshot } };
					}
				}
				break;
			}

			case "ext:state": {
				const { extensionId, extensionName, state } = event.data as {
					extensionId: string; extensionName: string; state: Record<string, unknown>;
				};
				if (extensionId) {
					store.extensionPanelStates = {
						...store.extensionPanelStates,
						[extensionId]: { extensionName, state },
					};
				}
				break;
			}
		}
	});

	return () => {
		unsub();
		client.close();
	};
}
