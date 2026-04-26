/**
 * Panel persistence orchestration — extracted from
 * `routes/(app)/project/[id]/chat/[convId]/+page.svelte` (W4 of the chat-page
 * split).
 *
 * The chat page stores which side panels (Settings, Observability, Diff,
 * Tools popover, Task Logs, Agent Detail) are open per-conversation in
 * localStorage via `$lib/panel-persistence.ts`'s `readChatPanels` /
 * `writeChatPanels`. The page also accepts a `?agent=<subConvoId>` URL
 * param that deep-links into the AgentDetailPanel.
 *
 * The orchestration that wires those helpers together is three reactive
 * effects:
 *   1. RESTORE on convId change — clears stale per-conversation state
 *      (selection mode, etc.), then restores panel-open flags from
 *      localStorage. The `?agent=` query overrides any stored
 *      `selectedAgentSubConvId`.
 *   2. RESOLVE pending agent — once the streaming agent calls hydrate (or
 *      the DB-loaded sub-conversations arrive for a deep link with no live
 *      streaming state), bind the matching `AgentCallState` into
 *      `selectedAgent` and clear `agentDetailId`.
 *   3. PERSIST — whenever any tracked panel flag changes (after restore),
 *      write the snapshot back to localStorage.
 *
 * The page's `$state` slots are passed in as `{ get, set }` accessor pairs
 * so reactivity propagates across the module boundary while preserving the
 * identity of the underlying state. Plain getters that re-pack values
 * would lose the proxied identity; bare reads/writes against accessor
 * pairs keep it.
 *
 * The three effect bodies are exported as plain functions
 * (`restorePanelsForConv`, `resolvePendingAgent`, `persistPanelSnapshot`)
 * so they can be unit-tested without standing up a Svelte rune host.
 * `attachPanelPersistence` wraps them in `$effect`s and is the single
 * entry point the page calls.
 */

import { readChatPanels, writeChatPanels } from "$lib/panel-persistence.js";
import {
	subConvoToAgentCallState,
	type SubConvoRecord,
} from "$lib/sub-convo-agent-state.js";
import type {
	AgentCallState,
	AssignmentStatus,
	TaskPanelTask,
	TaskSnapshot,
} from "$lib/stores.svelte.js";

export interface BoolSlot {
	get(): boolean;
	set(v: boolean): void;
}

export interface NullableSlot<T> {
	get(): T | null;
	set(v: T | null): void;
}

/** Minimal task-snapshot shape the resolver reads (super-type of `TaskSnapshot`). */
export type TaskSnapshotLike = Pick<TaskSnapshot, "tasks">;

export interface PanelPersistenceHost {
	/** Active conversation id — read fresh inside each effect. */
	convId(): string;
	/** Reactive URL search params (typically `page.url.searchParams`). */
	searchParams(): URLSearchParams;

	// Panel-open state slots — paired getter/setter pairs backed by `$state`
	// in the page. Identity of the underlying `$state` MUST be preserved.
	settingsOpen: BoolSlot;
	obsOpen: BoolSlot;
	diffPanelOpen: BoolSlot;
	toolsOpen: BoolSlot;
	taskLogsOpen: BoolSlot;

	/** Task-logs panel target. Restored from a saved id if a matching task exists. */
	taskLogsTask: NullableSlot<TaskPanelTask>;

	/**
	 * The sub-conversation id the page is *trying* to bind into the
	 * AgentDetailPanel. Set by RESTORE (from localStorage or `?agent=`),
	 * consumed and cleared by RESOLVE once `selectedAgent` is populated.
	 */
	agentDetailId: NullableSlot<string>;

	/** The resolved AgentCallState rendered by the AgentDetailPanel. */
	selectedAgent: NullableSlot<AgentCallState>;

	/** Latest task snapshot (used to resolve `taskLogsTask` from a saved id). */
	taskSnapshot(): TaskSnapshotLike | null;
	/** All sub-conversations for this conversation (used by the resolver). */
	subConversations(): SubConvoRecord[];
	/** Per-sub-convo assignment status (built from the task snapshot). */
	assignmentForSubConvo(
		id: string,
	): { status: AssignmentStatus; resultPreview?: string } | undefined;
	/** Live streaming agent calls — `runId → AgentCallState[]`. */
	streamingAgentCalls(): Record<string, AgentCallState[]>;

	/**
	 * Called once per convId change BEFORE restoration runs. The page uses
	 * this to clear per-conversation selection-mode state that shouldn't
	 * carry across conversation switches.
	 */
	onConvSwitch(): void;
}

// ── Plain effect bodies (testable without rune hosts) ──────────────────

/**
 * Restore panel-open state for the active conversation. Idempotent per
 * convId — caller passes `lastRestoredFor` and gets back the new value
 * (the convId, indicating restore ran). Returns the previous
 * `lastRestoredFor` unchanged when the convId hasn't changed.
 */
export function restorePanelsForConv(
	host: PanelPersistenceHost,
	lastRestoredFor: string | null,
): string | null {
	const cid = host.convId();
	if (!cid || lastRestoredFor === cid) return lastRestoredFor;

	host.onConvSwitch();

	const saved = readChatPanels(cid);
	if (saved) {
		host.obsOpen.set(saved.obsOpen);
		host.diffPanelOpen.set(saved.diffPanelOpen);
		host.toolsOpen.set(saved.toolsOpen);
		host.settingsOpen.set(saved.settingsOpen);
		// taskLogs is restored only once we have a matching task in scope.
		if (saved.taskLogsOpen && saved.taskLogsTaskId) {
			const snapshot = host.taskSnapshot();
			const found = snapshot?.tasks.find(t => t.id === saved.taskLogsTaskId) ?? null;
			if (found) {
				host.taskLogsTask.set(found);
				host.taskLogsOpen.set(true);
			}
		}
		host.agentDetailId.set(saved.selectedAgentSubConvId);
	} else {
		// New conversation — clear any leaked state from prior conv.
		host.obsOpen.set(false);
		host.diffPanelOpen.set(false);
		host.toolsOpen.set(false);
		host.settingsOpen.set(false);
		host.taskLogsOpen.set(false);
		host.taskLogsTask.set(null);
		host.selectedAgent.set(null);
		host.agentDetailId.set(null);
	}

	// `?agent=<subConversationId>` overrides any persisted value — set by
	// the Active Agents list when opening a sub-agent from its parent chat.
	const urlAgent = host.searchParams().get("agent");
	if (urlAgent) host.agentDetailId.set(urlAgent);

	return cid;
}

/**
 * Resolve the pending agent-detail id into a concrete `AgentCallState`.
 * Tries live streaming agent calls first; falls back to DB-loaded
 * sub-conversations. Clears `agentDetailId` once bound. No-op when
 * there's nothing pending.
 */
export function resolvePendingAgent(host: PanelPersistenceHost): void {
	const target = host.agentDetailId.get();
	if (!target) return;
	for (const calls of Object.values(host.streamingAgentCalls())) {
		const found = calls.find(c => c.subConversationId === target);
		if (found) {
			host.selectedAgent.set(found);
			host.agentDetailId.set(null);
			return;
		}
	}
	const sc = host.subConversations().find(s => s.id === target);
	if (sc) {
		host.selectedAgent.set(
			subConvoToAgentCallState(sc, host.assignmentForSubConvo(sc.id)),
		);
		host.agentDetailId.set(null);
	}
}

/**
 * Persist the current panel-open snapshot to localStorage. Caller is
 * responsible for gating on `restoredFor === convId` so the persist
 * effect never clobbers storage with default values before restoration
 * has run.
 */
export function persistPanelSnapshot(host: PanelPersistenceHost): void {
	const cid = host.convId();
	if (!cid) return;
	writeChatPanels(cid, {
		obsOpen: host.obsOpen.get(),
		diffPanelOpen: host.diffPanelOpen.get(),
		taskLogsOpen: host.taskLogsOpen.get(),
		taskLogsTaskId: host.taskLogsTask.get()?.id ?? null,
		toolsOpen: host.toolsOpen.get(),
		settingsOpen: host.settingsOpen.get(),
		selectedAgentSubConvId: host.selectedAgent.get()?.subConversationId ?? null,
	});
}

// ── Rune-host wiring ───────────────────────────────────────────────────

/**
 * Attach the three reactive effects (restore / resolve / persist) to the
 * Svelte effect tree. MUST be called inside a component or other rune
 * scope — `$effect` is required.
 *
 * The three effects observe the host's reactive sources transitively:
 * any `$state`/`$derived` read inside `host.*()` getters or accessor
 * `.get()` calls will be tracked, and the effect re-runs when they
 * change. The persist effect deliberately re-reads every panel flag
 * inside the body so each one becomes a dependency.
 */
export function attachPanelPersistence(host: PanelPersistenceHost): void {
	// `restoredFor` is a plain closure variable, not a `$state`. The restore
	// effect re-runs when `host.convId()` flips; the persist effect re-runs
	// when any panel-slot getter changes (which it reads inside the body).
	// `restoredFor` only acts as a write-once-per-convId gate that the
	// persist effect consults to avoid clobbering storage with defaults
	// before restore lands.
	let restoredFor: string | null = null;

	// Restore on convId change.
	$effect(() => {
		restoredFor = restorePanelsForConv(host, restoredFor);
	});

	// Resolve pending agent once streaming calls / sub-convos hydrate.
	$effect(() => {
		resolvePendingAgent(host);
	});

	// Persist whenever any tracked panel state changes (only after restore
	// has landed for the current convId).
	$effect(() => {
		const cid = host.convId();
		if (!cid || restoredFor !== cid) return;
		persistPanelSnapshot(host);
	});
}
