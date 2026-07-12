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
import { appendStreamingToolCall } from "./chat/streaming-tool-calls.js";
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
	/** "inline" (default) or "dock" — when "dock" + status="complete",
	 *  the chat UI renders a navigable pill in the message bubble and
	 *  mounts the routed card in the right-side `DockHost` panel. */
	cardLayout?: 'inline' | 'dock';
	category?: string;
	permissionPending?: boolean;
	/** Phase 6: sensitive capability that triggered an extension-scoped
	 *  permission prompt. Routes the modal to the four-scope chooser
	 *  (session/conversation/project/forever) for `shell` and `fs.write`
	 *  ops on extensions. Built-in tool gates (read/write/execute) leave
	 *  this undefined and use the legacy two-button modal. */
	capabilityKind?: 'shell' | 'fs.write';
	capabilityValue?: string;
}

/**
 * Per-conversation dock slot state. `userOverrode` flips to true when the
 * user manually toggles the sidebar after `openDock` snapshotted the
 * previous state — sidebar restore-on-close skips when set, per plan §7.2.
 */
export interface DockSlot {
	toolCallId: string;
	previousSidebar: boolean;
	userOverrode: boolean;
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
	/** Current autonomous self-continuation cycle (1-based) — present
	 *  only while an opted-in assignment is looping. */
	autonomousCycle?: number;
	/** Cycle cap for this assignment's autonomous continuation. */
	autonomousMaxCycles?: number;
	/**
	 * Structured-output schema failure (Phase B4). Captured from the
	 * terminal `task:assignment_update` event's top-level
	 * `structuredResultError` field (which the backend keeps OFF the
	 * assignment object) — true when the child finished but never produced
	 * schema-valid JSON. A validated-but-oversized result also carries
	 * `structuredResultError` but with `structuredResultOverCap=true`; that
	 * is NOT a schema failure, so it does NOT set this flag. Drives the
	 * amber "schema" chip on the completed pill so a schema-FAILED
	 * assignment isn't presented as a plain green success.
	 */
	schemaFailed?: boolean;
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
	mobileMenuOpen = $state<boolean>(false);

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

	// ── Canvas Dock SDK ──
	// Per-conversation dock slot — null when no dock is open in that
	// conversation. Cleared by `closeDock`. See `openDock` for snapshot
	// semantics. Mounted by `DockHost.svelte` at app-layout level.
	dockState = $state<Record<string, DockSlot>>({});

	// Dock width in pixels. Drag-handle on `DockHost` writes here via
	// `setDockSize`; clamped to [320, viewportWidth*0.8] and persisted
	// to localStorage("ezcorp-dock-size-px"). Default = 50% of viewport
	// when no prior value exists.
	dockSizePx = $state<number>(_initDockSizePx());

	// Per-conversation set of toolCallIds the user explicitly dismissed
	// (closed the dock). The auto-open `$effect` in InlineToolCard /
	// ToolCallCard checks this set and skips scheduling `openDock` for
	// dismissed ids — without it, `closeDock` triggers an immediate
	// re-open loop because `routeToDock` is still true. A manual reopen
	// via `DockOpenPill` (or any direct `openDock` call) clears the entry
	// for that toolCallId. New tool calls from the agent are unaffected.
	dismissedDocks = $state<Record<string, Record<string, true>>>({});
}

function _initDockSizePx(): number {
	if (typeof window === 'undefined') return 640;
	try {
		const stored = localStorage.getItem('ezcorp-dock-size-px');
		const parsed = stored ? parseInt(stored, 10) : NaN;
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	} catch { /* SSR / private mode */ }
	return Math.round(window.innerWidth * 0.5);
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

function refreshSettings() {
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
	// Re-attach: the runId is already streaming (EventSource + store survived a
	// SPA navigation, and the chat page's convId effect re-fired on return).
	// Preserve all accumulated tokens, thinking, content blocks, agent pills,
	// and the ContentBlockBuilder — only (re-)assert the conversation mapping.
	if (store.streamingRunToConversation[runId] !== undefined && blockBuilders.has(runId)) {
		if (store.streamingRunToConversation[runId] !== conversationId) {
			store.streamingRunToConversation = { ...store.streamingRunToConversation, [runId]: conversationId };
		}
		return true;
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
function resolveRunForConversation(conversationId: string): string | undefined {
	return routingResolveRunForConversation(routingSnapshot(), conversationId);
}

/** Send permission response (allow/deny) for a pending tool call.
 *  Phase 6: extension-scoped requests pass the optional `scope` arg
 *  naming the user-chosen always-allow scope. Built-in tool gates omit
 *  it (the server route ignores the field on built-in gates).
 *  Phase 56: optional `ttlOverrideMs` carries the picker's per-row TTL
 *  selection. `number` for a positive override; `null` for "Never"
 *  (sweep skips the row). `undefined`/omitted → legacy path (server
 *  falls back to TTL_CONFIG[kind]). */
export async function sendToolPermissionResponse(
	toolCallId: string,
	approved: boolean,
	scope?: 'session' | 'conversation' | 'project' | 'forever',
	ttlOverrideMs?: number | null,
): Promise<void> {
	const body: Record<string, unknown> = { approved };
	if (scope !== undefined) body.scope = scope;
	if (ttlOverrideMs !== undefined) body.ttlOverrideMs = ttlOverrideMs;
	await fetch(`/api/tool-calls/${toolCallId}/permission`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
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

export function getTaskSnapshot(conversationId: string): TaskSnapshot | undefined {
	return store.taskSnapshots[conversationId];
}

export function getWsReconnectCount(): number {
	return store.wsReconnectCount;
}

export function setTaskSnapshot(snapshot: TaskSnapshot): void {
	store.taskSnapshots = { ...store.taskSnapshots, [snapshot.conversationId]: snapshot };
}

// ── Canvas Dock helpers ──
//
// Three-method API:
//   - openDock(convId, toolCallId): snapshot sidebar, force-collapse it,
//     persist the dock-state to localStorage. Idempotent on a no-op same-id
//     call. Replacing the toolCallId leaves `previousSidebar` snapshot intact
//     so close still restores the user's pre-dock state.
//   - closeDock(convId): clear the slot, restore previousSidebar UNLESS the
//     user manually toggled it while open (precedence rule, plan §7.2).
//   - setDockSize(px): clamp + persist.
//
// Per-conversation reload restore is keyed on `ezcorp-dock-state-<convId>`
// in localStorage; `DockHost` reads this on mount via `_readDockSlot`.

const DOCK_SIZE_KEY = 'ezcorp-dock-size-px';

function _dockStateKey(conversationId: string): string {
	return `ezcorp-dock-state-${conversationId}`;
}

/**
 * Persist a dock slot to localStorage so a hard reload reopens the dock at
 * the same toolCallId. Stores `{toolCallId, lastOpenedAt}` only — `previousSidebar`
 * doesn't need to round-trip because on reload we're starting fresh and the
 * sidebar's stored value is the user's current preference anyway. Best-effort:
 * any storage exception (private-mode, quota) is silently swallowed.
 */
function _writeDockSlotLS(conversationId: string, slot: { toolCallId: string }): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(
			_dockStateKey(conversationId),
			JSON.stringify({ toolCallId: slot.toolCallId, lastOpenedAt: Date.now() }),
		);
	} catch { /* private mode / quota */ }
}

function _clearDockSlotLS(conversationId: string): void {
	if (typeof localStorage === 'undefined') return;
	try { localStorage.removeItem(_dockStateKey(conversationId)); } catch {}
}

/**
 * Read the persisted dock slot for a conversation. Used by DockHost on mount
 * to rehydrate the prior session's open dock — if the toolCallId is no longer
 * known to inlineToolStore (history was purged), the caller silently bails.
 */
export function readPersistedDockSlot(conversationId: string): { toolCallId: string; lastOpenedAt: number } | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(_dockStateKey(conversationId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as { toolCallId?: unknown; lastOpenedAt?: unknown };
		if (typeof parsed?.toolCallId !== 'string') return null;
		return {
			toolCallId: parsed.toolCallId,
			lastOpenedAt: typeof parsed.lastOpenedAt === 'number' ? parsed.lastOpenedAt : Date.now(),
		};
	} catch { return null; }
}

/**
 * Open the dock for `conversationId` showing `toolCallId`. Snapshots the
 * current `sidebarCollapsed` only on the FIRST open (per replace-without-resnapshot
 * rule, plan §5 unit-test #2), then forces the sidebar collapsed.
 *
 * Re-calling with the SAME toolCallId is a no-op — useful so $effects in
 * `InlineToolCard` / `ChatMessage` can fire freely without double-opening.
 */
export function openDock(conversationId: string, toolCallId: string): void {
	// Manual / auto open clears the user-dismissed flag for this toolCallId.
	// Without this, clicking the chat-history "Canvas open ↗" pill after a
	// previous close would no-op forever because the auto-open effect would
	// still skip the dismissed id.
	const dismissed = store.dismissedDocks[conversationId];
	if (dismissed && dismissed[toolCallId]) {
		const { [toolCallId]: _drop, ...remaining } = dismissed;
		store.dismissedDocks = {
			...store.dismissedDocks,
			[conversationId]: remaining,
		};
	}
	const existing = store.dockState[conversationId];
	if (existing && existing.toolCallId === toolCallId) {
		// Already open with this id — make sure the sidebar is still collapsed
		// (the user may have re-expanded it; we don't override that here, the
		// auto-replace path is for swapping toolCallId only).
		_writeDockSlotLS(conversationId, { toolCallId });
		return;
	}
	const previousSidebar = existing?.previousSidebar ?? store.sidebarCollapsed;
	const userOverrode = existing?.userOverrode ?? false;
	store.dockState = {
		...store.dockState,
		[conversationId]: { toolCallId, previousSidebar, userOverrode },
	};
	if (!store.sidebarCollapsed) {
		store.sidebarCollapsed = true;
		if (typeof localStorage !== 'undefined') {
			try { localStorage.setItem('pi-sidebar-collapsed', 'true'); } catch {}
		}
	}
	_writeDockSlotLS(conversationId, { toolCallId });
}

/**
 * Close the dock for `conversationId`. Restores the snapshot of
 * `sidebarCollapsed` UNLESS `userOverrode` is set (the user manually toggled
 * it after the auto-collapse, so we leave their choice alone).
 */
export function closeDock(conversationId: string): void {
	const slot = store.dockState[conversationId];
	if (!slot) return;
	const { [conversationId]: _removed, ...rest } = store.dockState;
	store.dockState = rest;
	// Mark this toolCallId as user-dismissed so the InlineToolCard /
	// ToolCallCard auto-open `$effect` doesn't fire `openDock` again the
	// moment we return — `routeToDock` is still true (cardLayout=dock,
	// status=complete). The flag is cleared on a manual reopen via
	// `openDock` (which the chat-history pill click goes through).
	const prevDismissed = store.dismissedDocks[conversationId] ?? {};
	store.dismissedDocks = {
		...store.dismissedDocks,
		[conversationId]: { ...prevDismissed, [slot.toolCallId]: true },
	};
	if (!slot.userOverrode && store.sidebarCollapsed !== slot.previousSidebar) {
		store.sidebarCollapsed = slot.previousSidebar;
		if (typeof localStorage !== 'undefined') {
			try { localStorage.setItem('pi-sidebar-collapsed', String(slot.previousSidebar)); } catch {}
		}
	}
	_clearDockSlotLS(conversationId);
}

/**
 * Mark that the user manually changed `sidebarCollapsed` after `openDock`.
 * Called by the layout's toggle handler — the layout already owns sidebar
 * mutations, so this is the cheap centralized signal. Closes flip to "user
 * wins": restore-on-close becomes a no-op for this dock instance.
 *
 * Idempotent — flips the flag for whichever conversation currently has a
 * dock open. (Realistically only one is "active" in the UI at a time, but
 * we keep the contract per-conversation for future multi-pane layouts.)
 */
export function noteSidebarUserOverride(): void {
	const next: Record<string, DockSlot> = {};
	let mutated = false;
	for (const [convId, slot] of Object.entries(store.dockState)) {
		if (!slot.userOverrode) {
			next[convId] = { ...slot, userOverrode: true };
			mutated = true;
		} else {
			next[convId] = slot;
		}
	}
	if (mutated) store.dockState = next;
}

/**
 * Set the dock width in pixels, clamping to a sane range. Persists to
 * localStorage on every successful set so reload picks up the user's last
 * size. Caller is responsible for reading from `store.dockSizePx` to drive
 * the CSS `width` property.
 */
export function setDockSize(px: number): void {
	if (!Number.isFinite(px)) return;
	const min = 320;
	const max = typeof window !== 'undefined' ? Math.round(window.innerWidth * 0.8) : 1600;
	const clamped = Math.max(min, Math.min(max, Math.round(px)));
	store.dockSizePx = clamped;
	if (typeof localStorage !== 'undefined') {
		try { localStorage.setItem(DOCK_SIZE_KEY, String(clamped)); } catch {}
	}
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
				const { runId, conversationId, messageId, parentMessageId, content, thinkingContent, final } = event.data as {
					runId: string; conversationId: string; messageId: string; parentMessageId: string | null; content: string; thinkingContent?: string; final: boolean;
				};
				console.info("[kokoro-tts-flow][store] run:turn_saved received", {
					runId, conversationId, messageId, parentMessageId, final, isExtension: runId.startsWith("ext:"),
				});
				// Dispatch DOM event for chat page to handle message list update
				if (typeof window !== "undefined") {
					window.dispatchEvent(new CustomEvent("ez:turn_saved", {
						detail: { runId, conversationId, messageId, parentMessageId, content, thinkingContent, final },
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
						if (conversationId) unreadStore.markUnread(conversationId, updated.projectId ?? null);
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
				const { conversationId, toolName, input, timestamp, extensionId, source, invocationId, cardType, cardLayout, category } = event.data as {
					conversationId: string; toolName: string; input: unknown; timestamp: number; extensionId?: string; source?: string; invocationId?: string; cardType?: string; cardLayout?: string; category?: string;
				};
				const safeLayout = cardLayout === 'dock' ? 'dock' as const : cardLayout === 'inline' ? 'inline' as const : undefined;
				if (source === 'inline' && invocationId) {
					inlineToolStore.updateFromEvent(invocationId, 'tool:start', { timestamp, ...(cardType ? { cardType } : {}), ...(safeLayout ? { cardLayout: safeLayout } : {}) });
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
						...(safeLayout ? { cardLayout: safeLayout } : {}),
					});
				}
				// Find runId from conversationId
				const runId = Object.entries(store.streamingRunToConversation)
					.find(([, cId]) => cId === conversationId)?.[0];
				if (runId) {
					const existing = store.streamingToolCalls[runId] ?? [];
					const entry: ToolCallState = { ...(invocationId ? { id: invocationId } : {}), toolName, status: 'running', input, startedAt: timestamp, extensionId, cardType, cardLayout: safeLayout, category };
					// Dedup by id (symmetric with the resume guard in
					// stream-resume.svelte.ts): the resume/active-run path may have
					// already injected a synthetic card for this tool call
					// (pendingAskUser / pendingPermissions) before the live
					// tool:start arrives — typically on a WS reconnect while an
					// ask_user_question gate is open. A blind append would render
					// the same question card twice. When the id is already present
					// this is a no-op (and we skip the paired tool_ref push below).
					const { calls, added } = appendStreamingToolCall(existing, entry);
					if (added) {
						// Flush any buffered tokens BEFORE inserting tool_ref to preserve text/tool ordering
						flushTokensForRun(runId);
						store.streamingToolCalls = {
							...store.streamingToolCalls,
							[runId]: calls,
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
				}
				break;
			}

			case "tool:complete": {
				const { conversationId, toolName, output, duration, success: completeSuccess, source: completeSource, invocationId: completeInvId, cardType: completeCardType, cardLayout: completeCardLayout } = event.data as {
					conversationId: string; toolName: string; output: unknown; duration: number; success?: boolean; source?: string; invocationId?: string; cardType?: string; cardLayout?: string;
				};
				const safeCompleteLayout = completeCardLayout === 'dock' ? 'dock' as const : completeCardLayout === 'inline' ? 'inline' as const : undefined;
				if (completeSource === 'inline' && completeInvId) {
					if (completeSuccess === false) {
						inlineToolStore.updateFromEvent(completeInvId, 'tool:error', { error: output, duration });
					} else {
						inlineToolStore.updateFromEvent(completeInvId, 'tool:complete', { output, duration, ...(completeCardType ? { cardType: completeCardType } : {}), ...(safeCompleteLayout ? { cardLayout: safeCompleteLayout } : {}) });
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
					const existingStreaming = inlineToolStore.getById(completeInvId);
					inlineToolStore.upsertStreaming({
						id: completeInvId,
						conversationId,
						extensionName: existingStreaming?.extensionName ?? 'builtin',
						toolName,
						status: completeSuccess === false ? 'error' : 'complete',
						output: outputText,
						duration,
						...(completeCardType ? { cardType: completeCardType } : {}),
						...(safeCompleteLayout ? { cardLayout: safeCompleteLayout } : {}),
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
						const extractedOutput = extractToolOutput(output);
						if (completeSuccess === false) {
							const errText = typeof extractedOutput === 'string' ? extractedOutput : JSON.stringify(extractedOutput);
							updated[idx] = { ...updated[idx]!, status: 'error', error: errText, output: extractedOutput, duration, permissionPending: false, ...(completeCardType ? { cardType: completeCardType } : {}), ...(safeCompleteLayout ? { cardLayout: safeCompleteLayout } : {}) };
						} else {
							updated[idx] = { ...updated[idx]!, status: 'complete', output: extractedOutput, duration, permissionPending: false, ...(completeCardType ? { cardType: completeCardType } : {}), ...(safeCompleteLayout ? { cardLayout: safeCompleteLayout } : {}) };
						}
						store.streamingToolCalls = { ...store.streamingToolCalls, [runId]: updated };
					}
				}
				break;
			}

			case "tool:error": {
				const { conversationId, toolName, error: toolError, duration, source: errorSource, invocationId: errorInvId, cardType: errorCardType, cardLayout: errorCardLayout } = event.data as {
					conversationId: string; toolName: string; error: string; duration: number; source?: string; invocationId?: string; cardType?: string; cardLayout?: string;
				};
				const safeErrorLayout = errorCardLayout === 'dock' ? 'dock' as const : errorCardLayout === 'inline' ? 'inline' as const : undefined;
				if (errorSource === 'inline' && errorInvId) {
					inlineToolStore.updateFromEvent(errorInvId, 'tool:error', { error: toolError, duration, ...(errorCardType ? { cardType: errorCardType } : {}), ...(safeErrorLayout ? { cardLayout: safeErrorLayout } : {}) });
					break;
				}
				// Live Diff Summary panel: mark the streaming entry as errored.
				// `input` omitted on purpose (see tool:complete above).
				if (errorInvId) {
					const existingStreaming = inlineToolStore.getById(errorInvId);
					inlineToolStore.upsertStreaming({
						id: errorInvId,
						conversationId,
						extensionName: existingStreaming?.extensionName ?? 'builtin',
						toolName,
						status: 'error',
						error: toolError,
						duration,
						...(errorCardType ? { cardType: errorCardType } : {}),
						...(safeErrorLayout ? { cardLayout: safeErrorLayout } : {}),
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
				const {
					conversationId,
					toolCallId,
					toolName: permToolName,
					input: permInput,
					cardType: permCardType,
					cardLayout: permCardLayout,
					category: permCategory,
					// Phase 6: extension-scoped fields. When `extensionId` is
					// set, the modal renders the four-scope chooser and uses
					// `capabilityKind`/`capabilityValue` to describe the
					// requested operation. Built-in tool gates leave them
					// undefined and use the legacy two-button modal.
					extensionId: permExtensionId,
					capabilityKind: permCapabilityKind,
					capabilityValue: permCapabilityValue,
				} = event.data as {
					conversationId: string;
					toolCallId: string;
					toolName: string;
					input: unknown;
					cardType?: string;
					cardLayout?: string;
					category?: string;
					extensionId?: string;
					capabilityKind?: 'shell' | 'fs.write';
					capabilityValue?: string;
				};
				const safePermLayout = permCardLayout === 'dock' ? 'dock' as const : permCardLayout === 'inline' ? 'inline' as const : undefined;
				// Resolve root run — handles both root conversations and sub-agent conversations
				const runId = resolveRunForConversation(conversationId);
				if (runId) {
					const calls = store.streamingToolCalls[runId] ?? [];
					// Find existing tool call or create one
					const idx = calls.findLastIndex((tc) => tc.toolName === permToolName && tc.status === 'running');
					if (idx >= 0) {
						const updated = [...calls];
						updated[idx] = {
							...updated[idx]!,
							id: toolCallId,
							permissionPending: true,
							cardType: permCardType,
							cardLayout: safePermLayout,
							category: permCategory,
							extensionId: permExtensionId,
							capabilityKind: permCapabilityKind,
							capabilityValue: permCapabilityValue,
						};
						store.streamingToolCalls = { ...store.streamingToolCalls, [runId]: updated };
					} else {
						store.streamingToolCalls = {
							...store.streamingToolCalls,
							[runId]: [
								...calls,
								{
									id: toolCallId,
									toolName: permToolName,
									status: 'running',
									input: permInput,
									startedAt: Date.now(),
									permissionPending: true,
									cardType: permCardType,
									cardLayout: safePermLayout,
									category: permCategory,
									extensionId: permExtensionId,
									capabilityKind: permCapabilityKind,
									capabilityValue: permCapabilityValue,
								},
							],
						};
					}
				} else {
					// No root run found — this shouldn't happen if agent:spawn was received
					// Surface a toast so the user can manually deny/approve via the sub-conversation view
					// browser-side store: keep console.* — server-side $server/logger writes to
					// process.stderr, which doesn't exist in the browser bundle.
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
				const { subConversationId, agentName: completeAgentName, success: agentSuccess, resultPreview, agentRunId: completeAgentRunId } = event.data as {
					runId: string; subConversationId: string; agentName: string; success: boolean; resultPreview: string; agentRunId?: string; parentConversationId?: string;
				};
				// Resolve the chip by its stable `subConversationId`, scanning every
				// run bucket — NOT just `streamingAgentCalls[runId]`. The terminal
				// `agent:complete` now fires for tool-spawned / background agents
				// too, and for one that auto-continued (auto-continue / autonomous /
				// schema-retry cycle) the terminal `runId` is the LAST cycle's run
				// id, which differs from the initial spawn run id that keyed the
				// chip. Keying strictly on `runId` would leave such an agent stuck
				// "running"; matching on `subConversationId` (constant across all
				// cycles) resolves it to complete/error.
				let matchedAgentCall = false;
				const nextAgentCalls: Record<string, AgentCallState[]> = {};
				for (const [bucketRunId, calls] of Object.entries(store.streamingAgentCalls)) {
					nextAgentCalls[bucketRunId] = calls.map(a => {
						if (a.subConversationId !== subConversationId) return a;
						matchedAgentCall = true;
						return { ...a, status: agentSuccess ? 'complete' as const : 'error' as const, resultPreview };
					});
				}
				if (matchedAgentCall) {
					store.streamingAgentCalls = nextAgentCalls;
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
				const { conversationId, taskId, assignment, structuredResultError, structuredResultOverCap } = event.data as {
					conversationId: string; taskId: string; assignment: TaskAssignment;
					structuredResultError?: string; structuredResultOverCap?: boolean;
				};
				// Schema-failure flag rides the top-level event field (the backend
				// keeps it OFF the assignment object). Capture it into the
				// view-model: a terminal update carrying `structuredResultError`
				// WITHOUT `structuredResultOverCap` is a genuine schema failure; a
				// validated-but-oversized result (overCap) is not.
				const schemaFailed = structuredResultError !== undefined && !structuredResultOverCap;
				const merged: TaskAssignment = { ...assignment, schemaFailed };
				const snapshot = store.taskSnapshots[conversationId];
				if (snapshot) {
					const task = snapshot.tasks.find(t => t.id === taskId);
					if (task) {
						const idx = (task.assignments ?? []).findIndex(a => a.id === merged.id);
						if (idx >= 0) {
							task.assignments[idx] = merged;
						} else {
							task.assignments = [...(task.assignments ?? []), merged];
						}
						// Client-side rollup: the extension emits a fresh task:snapshot
						// when it receives this event and auto-advances, but that round-
						// trip goes through the subprocess RPC and can lag. Mirror the
						// rollup here so the task visibly flips to "completed"/"failed"
						// the instant the last running assignment finishes, rather than
						// waiting on the extension's snapshot emit.
						if (
							task.status !== "completed" &&
							task.status !== "failed" &&
							task.assignments.length > 0 &&
							task.assignments.every(a => a.status === "completed" || a.status === "failed")
						) {
							const anyFailed = task.assignments.some(a => a.status === "failed");
							task.status = anyFailed ? "failed" : "completed";
							const ts = new Date().toISOString();
							if (anyFailed) task.failedAt = task.failedAt ?? ts;
							else task.completedAt = task.completedAt ?? ts;
							if (snapshot.activeTaskId === task.id) snapshot.activeTaskId = undefined;
						}
						// Trigger reactivity
						store.taskSnapshots = { ...store.taskSnapshots, [conversationId]: { ...snapshot } };
					}
				}
				break;
			}

			case "ez:client-tool": {
				// Forward Ez client-side tool invocations (`fill_form` /
				// `navigate_to`) to whatever surface is listening — today
				// that's only EzPanel.svelte. Mirrors the `ez:turn_saved`
				// pattern: route the bus event into a DOM custom event so
				// the panel doesn't need a second EventSource of its own.
				if (typeof window !== "undefined") {
					window.dispatchEvent(new CustomEvent("ez:client-tool", {
						detail: event.data,
					}));
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

			case "ext:page-state": {
				// Extension Pages Hub: content-free invalidation signal.
				// Re-dispatch as a window CustomEvent so the Hub page
				// ((app)/hub/[pageId]) can re-pull its render endpoint
				// without owning a second EventSource — same pattern as
				// `extensions:installed` below. The payload carries only
				// {extensionId, extensionName, pageId}; the actual tree is
				// fetched per-session from the authed render route.
				if (typeof window !== "undefined") {
					window.dispatchEvent(new CustomEvent("ext:page-state", {
						detail: event.data,
					}));
				}
				break;
			}

			case "extensions:installed": {
				// agent-install-ux-polish Phase 2 (D4): re-dispatch the
				// user-scoped install signal as a DOM CustomEvent so the
				// Extensions Library page can trigger its existing
				// cache-bypassing `loadExtensions()` without standing up a
				// second EventSource. Mirrors the `ez:client-tool` /
				// `ez:turn_saved` re-dispatch pattern. Server-side
				// `shouldDeliverEvent` already scoped this to the
				// installing user's session; the page just needs to know
				// "refresh now".
				if (typeof window !== "undefined") {
					window.dispatchEvent(new CustomEvent("extensions:installed", {
						detail: event.data,
					}));
				}
				break;
			}

			case "conversation:created": {
				// Daily Briefing Phase 2 (spec §5.3): a server-initiated
				// conversation (briefing pipeline today; any future
				// server-side creator via `source`) landed for THIS user —
				// the SSE filter is fail-closed per-user, so no ownership
				// re-check is needed here. Mark it unread (lights the
				// sidebar dot, project-rail badge, and favicon badge) and
				// re-dispatch as a window CustomEvent so ConversationList
				// can refetch the affected project's list without owning a
				// second EventSource (same pattern as `extensions:installed`).
				const { conversationId, projectId } = event.data as {
					conversationId?: string;
					projectId?: string | null;
				};
				if (!conversationId) break;
				unreadStore.markUnread(conversationId, projectId ?? null);
				if (typeof window !== "undefined") {
					window.dispatchEvent(new CustomEvent("conversation:created", {
						detail: event.data,
					}));
				}
				break;
			}

			case "conversation:tree-changed": {
				// Sessions P4 rewind/checkpoint: a rewind moved this
				// conversation's durable leaf. The SSE filter already scoped
				// delivery to the owner (conversation-scoped, like goal:update),
				// so re-dispatch as a window CustomEvent — ChatThread guards on
				// its own conversationId and re-pulls the tree + messages (same
				// pattern as `conversation:created` / `ext:page-state`).
				if (typeof window !== "undefined") {
					window.dispatchEvent(new CustomEvent("conversation:tree-changed", {
						detail: event.data,
					}));
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
