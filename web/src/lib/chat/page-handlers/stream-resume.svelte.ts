/**
 * Stream-resume orchestration — extracted from
 * `routes/(app)/project/[id]/chat/[convId]/+page.svelte` (W9 of the chat-page
 * split). HIGHEST-RISK wave: timing-sensitive WS reconnect / zombie-detection
 * / run-resume code. By W9 the surrounding page is much smaller, so the
 * remaining seams are easier to isolate.
 *
 * Three concerns live here:
 *
 * 1. **`checkActiveRun(gen)`** — hits `GET /api/conversations/:id/active-run`
 *    and, if a run is in flight, calls `startStreaming(runId)` to attach the
 *    page's streaming state to it. Restores `pendingPermissions` and
 *    `pendingAskUser` synthetic tool-call cards into `store.streamingToolCalls`
 *    so the UI shows the same gates the user left when they reloaded.
 *    Pushes a `streaming-<runId>` placeholder assistant message at the leaf
 *    so token streaming has somewhere to render. The `gen` argument is the
 *    page's `loadGeneration` counter — every async resume bails if the
 *    counter has advanced (i.e., the user switched conversations).
 *
 * 2. **WS-reconnect resume** — a `$effect` that watches `store.connected`
 *    and, on every reconnect (`!wasConnected → connected`), re-runs
 *    `checkActiveRun`. **MUST be throttled** by `RECONNECT_CHECK_COOLDOWN_MS`
 *    or a flaky network (Tailscale handoff, captive portal) cascades into
 *    `loadMessages()` storms (3 GETs per call) that visibly freeze the UI.
 *    The cooldown timestamp lives at MODULE scope so it persists across
 *    `attachStreamResume` re-attachments on convId switches — same pattern
 *    as the panel-persistence W4 closure-state. Tests exercise the cooldown
 *    via an injectable clock (`now()`), defaulting to `Date.now`.
 *
 * 3. **Zombie / staleness watchdog** — a `$effect` that, while a run is in
 *    flight, runs two timers:
 *      - a 10s `setInterval` that polls `/active-run` to refresh
 *        `serverStalenessMs` (drives the StuckRunBanner timer even when no
 *        new tokens arrive), and
 *      - a `resumedRun ? 5s : 30s` `setTimeout` that checks for zombie state
 *        (status flipped to non-running, or stale heartbeat).
 *    Both timers are torn down on every effect re-run AND on host detach.
 *
 * Reactive store reads (`store.connected`, `store.streamingMessages`,
 * `store.streamingStatus`, `store.streamingToolCalls`) and the
 * `startStreaming` / `stopStreaming` action imports flow through the
 * `$lib/stores.svelte.js` singleton — same as the original page — so
 * reactivity propagates without plumbing the store through the host.
 *
 * The plain (testable) inner functions are exported so the test suite
 * doesn't have to stand up a Svelte effect scope:
 *   - `runActiveRunCheck(host)` — body of `checkActiveRun(gen)` minus the
 *     `gen` discard guards (which use `host.loadGeneration()`).
 *   - `attemptReconnectCheck(host, now)` — body of the WS-reconnect $effect
 *     minus the `wasConnected` flip-flop (kept inside the rune wrapper).
 *   - `pollStaleness(host)` — body of the 10s interval.
 *   - `runZombieCheck(host, snapshotText)` — body of the zombie timeout.
 *
 * The `attachStreamResume(host)` rune-host wraps these in `$effect`s, owns
 * the timer handles, and returns `{ checkActiveRun }` so the page can fire
 * a manual check from `loadMessages().then(...)` on convId change.
 */

import {
	store,
	startStreaming,
	stopStreaming,
} from "$lib/stores.svelte.js";
import { backgroundFetch } from "$lib/utils/fetch-policy.js";
import type { Message } from "$lib/api.js";
import type { SelectedModel } from "$lib/chat/page-handlers/send-message.js";

// ── Constants ────────────────────────────────────────────────────────────

/**
 * WS reconnect throttle. On flaky networks the EventSource at
 * `/api/runtime-events` can drop and re-connect every second or two; without
 * this throttle each reconnect cascades into `loadMessages()` (3 GETs) and
 * spams the server. Module-level so it persists across re-attachments.
 */
export const RECONNECT_CHECK_COOLDOWN_MS = 10_000;

/**
 * Zombie-detection timeout for runs the page started fresh in this tab.
 * If no token arrives for this long, the watchdog re-checks server status.
 */
export const ZOMBIE_TIMEOUT_FRESH_MS = 30_000;

/**
 * Zombie-detection timeout for runs the page resumed via `checkActiveRun`.
 * Resumed runs are more likely to be stale (the upstream process may have
 * already exited), so we check sooner.
 */
export const ZOMBIE_TIMEOUT_RESUMED_MS = 5_000;

/** Lightweight staleness poll interval — keeps the StuckRunBanner fresh. */
export const STALENESS_POLL_INTERVAL_MS = 10_000;

// ── Types ────────────────────────────────────────────────────────────────

export interface Slot<T> {
	get(): T;
	set(v: T): void;
}

export interface StreamResumeHost {
	/** Active conversation id — read fresh inside each effect. */
	convId(): string;

	/**
	 * Generation counter — incremented on each convId change. `checkActiveRun`
	 * is async, so every continuation guards on `gen === loadGeneration()`
	 * to discard stale callbacks from a previous conversation.
	 */
	loadGeneration(): number;

	/** Has the initial `loadMessages()` settled for this convId? */
	initialLoadDone(): boolean;

	/** Currently selected model (used to tag the streaming placeholder). */
	selectedModel(): SelectedModel | null;

	// State slots — paired getter/setter pairs backed by `$state` in the
	// page. Identity of the underlying `$state` MUST be preserved.
	activeRunId: Slot<string | null>;
	activeRunStartedAt: Slot<number | null>;
	serverStalenessMs: Slot<number | null>;
	resumedRun: Slot<boolean>;
	checkingActiveRun: Slot<boolean>;
	allMessages: Slot<Message[]>;
	activeLeafId: Slot<string | null>;

	/** Reload the whole conversation (used as a fallback in `checkActiveRun`). */
	loadMessages(): Promise<void>;

	/** Build an optimistic placeholder assistant message at the leaf. */
	makeOptimisticMessage(
		overrides: Partial<Message> & Pick<Message, "conversationId">,
	): Message;

	/**
	 * Live streaming-text reader — typically a `$derived` over
	 * `activeRunId ? store.streamingMessages[activeRunId] : undefined`. Read
	 * inside the zombie effect so the snapshot/diff captures the *current*
	 * streaming text after the timeout fires.
	 */
	currentStreamingText(): string | undefined;

	/**
	 * Live `isStreaming` reader — typically a `$derived`. The zombie
	 * watchdog tears down its timers when this flips false.
	 */
	isStreaming(): boolean;
}

export interface StreamResumeApi {
	/** Manual check (page calls this from `loadMessages().then(...)`). */
	checkActiveRun: (gen: number) => Promise<void>;
}

// ── Server response shape ────────────────────────────────────────────────

interface PendingPermissionEntry {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown> | null;
	cardType?: string | null;
	category?: string | null;
}

interface PendingAskUserEntry {
	toolCallId: string;
	question: string;
	options?: unknown;
}

interface ActiveRunResponse {
	runId?: string | null;
	status?: string | null;
	startedAt?: string | null;
	stalenessMs?: number | null;
	partialResponse?: string | null;
	pendingPermissions?: PendingPermissionEntry[] | null;
	pendingAskUser?: PendingAskUserEntry[] | null;
}

// ── Plain (testable) inner functions ─────────────────────────────────────

/**
 * Body of `checkActiveRun`. Caller is responsible for guarding on the
 * `gen === host.loadGeneration()` invariants — those are still done inline
 * here because they're interleaved with `await` boundaries (one stale-gen
 * check after each await).
 *
 * Sets `checkingActiveRun = false` in the `finally` block to mirror the
 * original lifecycle. Caller (the convId-change effect on the page) sets
 * it to `true` BEFORE invoking; the WS-reconnect effect also sets it to
 * `true` before invoking. Both paths converge here for cleanup.
 */
export async function runActiveRunCheck(
	host: StreamResumeHost,
	gen: number,
): Promise<void> {
	const convId = host.convId();
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
		if (!res || !res.ok || gen !== host.loadGeneration()) return;
		const data = (await res.json()) as ActiveRunResponse;
		if (!data.runId || gen !== host.loadGeneration()) return;

		// If the run is not actively running, just reload messages
		if (data.status && data.status !== "running") {
			if (gen === host.loadGeneration()) await host.loadMessages();
			return;
		}

		if (gen !== host.loadGeneration()) return;
		const started = startStreaming(data.runId, convId);
		if (!started) {
			await host.loadMessages();
			return;
		}
		host.activeRunId.set(data.runId);
		host.resumedRun.set(true);
		// Capture server-side run metadata for the elapsed counter + stuck-run banner.
		host.activeRunStartedAt.set(
			data.startedAt ? new Date(data.startedAt).getTime() : Date.now(),
		);
		host.serverStalenessMs.set(
			typeof data.stalenessMs === "number" ? data.stalenessMs : null,
		);

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
							status: "running" as const,
							input: perm.input,
							startedAt: Date.now(),
							permissionPending: true,
							cardType: perm.cardType ?? undefined,
							category: perm.category ?? undefined,
						},
					],
				};
			}
		}

		// Restore open ask_user_question gates from server state. The
		// live tool:start SSE fired before this refresh and the
		// tool_calls DB row isn't written until the user answers, so
		// the in-memory ask-user-registry is the only source. Mirror
		// pendingPermissions above: push a synthetic running entry per
		// gate; the live tool:complete will update it in place by
		// toolName match (see stores.svelte.ts case "tool:complete").
		if (data.pendingAskUser?.length) {
			for (const entry of data.pendingAskUser) {
				store.streamingToolCalls = {
					...store.streamingToolCalls,
					[data.runId]: [
						...(store.streamingToolCalls[data.runId] ?? []),
						{
							id: entry.toolCallId,
							toolName: "ask-user__ask_user_question",
							status: "running" as const,
							input: { question: entry.question, options: entry.options },
							startedAt: Date.now(),
							cardType: "ask-user-question",
						},
					],
				};
			}
		}

		// Add placeholder assistant message with partial response if available
		const all = host.allMessages.get();
		const lastMsg = all[all.length - 1];
		const selectedModel = host.selectedModel();
		const assistantPlaceholder = host.makeOptimisticMessage({
			id: `streaming-${data.runId}`,
			conversationId: convId,
			role: "assistant",
			content: data.partialResponse ?? "",
			model: selectedModel?.model ?? null,
			provider: selectedModel?.provider ?? null,
			runId: data.runId,
			parentMessageId: lastMsg?.id ?? null,
		});
		host.allMessages.set([...all, assistantPlaceholder]);
		host.activeLeafId.set(assistantPlaceholder.id);
	} catch {
		// Non-fatal — page works normally without resume
	} finally {
		host.checkingActiveRun.set(false);
	}
}

/**
 * Body of the WS-reconnect $effect — minus the `wasConnected` flip-flop
 * (kept inside the rune wrapper because it's a per-attach piece of state).
 *
 * Returns the new `lastReconnectCheckAt` if a check fired, or the previous
 * value otherwise. Caller manages persistence at module scope.
 *
 * Cooldown reasoning: on a flaky network the SSE drops and reconnects
 * every second or two. Each reconnect that fired `checkActiveRun` used to
 * cascade into `loadMessages()` storms. The server's answer to "is there
 * an active run" doesn't meaningfully change between reconnects that
 * happen seconds apart, so we throttle to at most one check per
 * RECONNECT_CHECK_COOLDOWN_MS.
 */
export function shouldFireReconnectCheck(
	host: StreamResumeHost,
	connected: boolean,
	wasConnected: boolean,
	lastReconnectCheckAt: number,
	now: number,
): boolean {
	if (!(connected && !wasConnected)) return false;
	if (host.activeRunId.get() !== null) return false;
	if (!host.initialLoadDone()) return false;
	return now - lastReconnectCheckAt >= RECONNECT_CHECK_COOLDOWN_MS;
}

/**
 * Body of the 10s staleness-poll `setInterval`. Reads metadata only —
 * doesn't touch streaming state. Refreshes `serverStalenessMs` on every
 * poll so the StuckRunBanner timer reflects the most recent server-side
 * heartbeat gap even when the user is passively watching.
 */
export async function pollStaleness(host: StreamResumeHost): Promise<void> {
	const runId = host.activeRunId.get();
	if (!runId) return;
	const convId = host.convId();
	try {
		const res = await backgroundFetch(
			`active-run:${convId}`,
			`/api/conversations/${convId}/active-run`,
			{},
			{ minIntervalMs: 4000 },
		);
		if (!res || !res.ok) return;
		const data = (await res.json()) as ActiveRunResponse;
		if (!data.runId || data.runId !== host.activeRunId.get()) return;
		if (typeof data.stalenessMs === "number") host.serverStalenessMs.set(data.stalenessMs);
		if (data.startedAt && host.activeRunStartedAt.get() == null) {
			host.activeRunStartedAt.set(new Date(data.startedAt).getTime());
		}
	} catch {
		/* non-fatal */
	}
}

/**
 * Body of the zombie `setTimeout` callback. If the run is still attached
 * AND `currentStreamingText` is unchanged from when the timer was scheduled,
 * re-check server status. If the run flipped to non-running, tear down
 * streaming. Otherwise refresh `serverStalenessMs`.
 */
export async function runZombieCheck(
	host: StreamResumeHost,
	snapshotText: string,
): Promise<void> {
	const runId = host.activeRunId.get();
	if (!runId) return;
	if (host.currentStreamingText() !== snapshotText) return;
	const convId = host.convId();
	try {
		const res = await backgroundFetch(
			`active-run:${convId}`,
			`/api/conversations/${convId}/active-run`,
			{},
			{ minIntervalMs: 4000 },
		);
		if (!res || !res.ok) return;
		const data = (await res.json()) as ActiveRunResponse;
		if (
			!data.runId ||
			data.runId !== host.activeRunId.get() ||
			(data.status && data.status !== "running")
		) {
			stopStreaming(runId);
		} else if (typeof data.stalenessMs === "number") {
			host.serverStalenessMs.set(data.stalenessMs);
		}
	} catch {
		/* non-fatal */
	}
}

// ── Module-level cooldown timestamp ──────────────────────────────────────

/**
 * Last reconnect-check fire time, in ms since epoch (matches `Date.now()`).
 * Module-scoped so it persists across `attachStreamResume` re-attachments
 * (e.g., conversation switches that re-mount the host). Per-page-instance
 * scope would let the cooldown reset on every convId change, defeating
 * the point of the throttle.
 *
 * Exported for tests via `__resetReconnectCooldown()` below.
 */
let lastReconnectCheckAt = 0;

/** Test-only: reset the module-level cooldown timestamp. */
export function __resetReconnectCooldown(): void {
	lastReconnectCheckAt = 0;
}

/** Test-only: read the module-level cooldown timestamp. */
export function __getReconnectCooldownAt(): number {
	return lastReconnectCheckAt;
}

// ── Rune-host wiring ─────────────────────────────────────────────────────

/**
 * Attach the WS-reconnect and zombie/staleness reactive effects to the
 * Svelte effect tree. MUST be called inside a component or other rune
 * scope — `$effect` is required.
 *
 * Returns `{ checkActiveRun }` so the page can fire a manual check from
 * its convId-change effect, which loads messages first and then checks
 * for an active run on the same generation token.
 *
 * The `now` parameter is an injectable clock. Defaults to `Date.now` for
 * production use; tests pass a controlled clock to exercise the cooldown.
 */
export function attachStreamResume(
	host: StreamResumeHost,
	options: { now?: () => number } = {},
): StreamResumeApi {
	const now = options.now ?? (() => Date.now());

	// Per-attach state for the WS-reconnect effect. `wasConnected` is reactive
	// so the effect tracks itself as a dependency and re-fires correctly on
	// every connect/disconnect transition.
	let wasConnected = $state(false);

	// Manual entrypoint — page calls this from its loadMessages().then(...)
	// chain. The async body delegates to the plain inner function so the
	// test suite can exercise it without a rune scope.
	const checkActiveRun = (gen: number) => runActiveRunCheck(host, gen);

	// WS-reconnect resume.
	$effect(() => {
		// Read store.connected INSIDE the effect body so reactivity tracks.
		// Capturing it once outside would defeat the effect — it must
		// re-fire on every transition.
		const connected = store.connected;
		if (
			shouldFireReconnectCheck(
				host,
				connected,
				wasConnected,
				lastReconnectCheckAt,
				now(),
			)
		) {
			lastReconnectCheckAt = now();
			host.checkingActiveRun.set(true);
			void checkActiveRun(host.loadGeneration());
		}
		wasConnected = connected;
	});

	// Zombie / staleness watchdog.
	$effect(() => {
		// Re-runs whenever `activeRunId` / `isStreaming` / `resumedRun` /
		// `currentStreamingText` change. The previous run's timers are torn
		// down at the top, then re-scheduled if a run is still in flight.
		// On unmount Svelte runs the cleanup function (returned below).
		const runId = host.activeRunId.get();
		const streaming = host.isStreaming();
		const resumed = host.resumedRun.get();
		const snapshot = host.currentStreamingText() ?? "";

		if (!runId || !streaming) {
			host.serverStalenessMs.set(null);
			host.activeRunStartedAt.set(null);
			return;
		}

		const timeout = resumed ? ZOMBIE_TIMEOUT_RESUMED_MS : ZOMBIE_TIMEOUT_FRESH_MS;

		const stalenessPollTimer = setInterval(() => {
			void pollStaleness(host);
		}, STALENESS_POLL_INTERVAL_MS);

		const zombieTimer = setTimeout(() => {
			void runZombieCheck(host, snapshot);
		}, timeout);

		return () => {
			clearInterval(stalenessPollTimer);
			clearTimeout(zombieTimer);
		};
	});

	return { checkActiveRun };
}
