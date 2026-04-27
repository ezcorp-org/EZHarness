/**
 * Load-messages orchestration — extracted from
 * `routes/(app)/project/[id]/chat/[convId]/+page.svelte` (W5 of the chat-page
 * split).
 *
 * Two concerns live here:
 *
 * 1. **Pure tree-walk helpers** that operate on `Message[]` snapshots:
 *      - `findLeafByMessageId(messages, id)` — walk forward through children,
 *        always picking the most-recent child, until a leaf is reached.
 *      - `computeLatestLeaf(messages)` — find the most recently-created leaf
 *        across the whole conversation tree.
 *      - `hydrateToolCallsFromApiData(data)` — split the
 *        `/messages?withToolCalls=true` response into the historical-tool-call
 *        list (for transcript rendering) and the per-conversation hydrate
 *        inputs the inline-tool-store consumes. Pure transform — no I/O,
 *        no mutation.
 *
 * 2. **Stateful loaders** wrapped in `makeLoadMessages(host)`:
 *      - `loadMessages()` — fires the all-messages + conversation reads via
 *        `backgroundFetch`, then chains into `hydrateToolCallsFromApi()`.
 *      - `hydrateToolCallsFromApi()` — fires the with-tool-calls read,
 *        unpacks it via `hydrateToolCallsFromApiData`, pushes the result
 *        into `inlineToolStore` and the host slots.
 *
 *    Both have function-level dedup (closure-state Map keyed by convId): if
 *    a second caller hits the same conversation while a request is in
 *    flight, it joins the existing promise instead of firing a parallel
 *    fetch cascade. The underlying URL throttle in `fetch-policy` is the
 *    second line of defence — both must hold for reconnect storms to be
 *    quiet.
 *
 * Reactive store reads (`inlineToolStore`) flow through the singleton
 * import — same as the original page — so reactivity propagates without
 * plumbing the store through the host.
 */

import { restoreLastModel } from "$lib/last-model.js";
import { backgroundFetch } from "$lib/utils/fetch-policy.js";
import { inlineToolStore } from "$lib/inline-tool-store.svelte.js";
import type { SubConvoRecord } from "$lib/sub-convo-agent-state.js";
import type { Conversation, Message, Mode } from "$lib/api.js";

// ── Types ────────────────────────────────────────────────────────────────

/** Per-message historical tool call summary used by transcript rendering. */
export interface HistoricalToolCall {
	id: string;
	messageId: string;
	extensionId: string;
	toolName: string;
	status: "success" | "error" | "interrupted";
	source?: "user" | "agent";
	cardLayout?: string | null;
}

/** Tool-call shape consumed by `inlineToolStore.hydrateToolCalls`. */
export interface HydrateInputCall {
	id: string;
	extensionId: string;
	toolName: string;
	input: Record<string, unknown> | null;
	outputSummary: string | null;
	fullOutput?: string | null;
	success: boolean;
	durationMs: number;
	status: "success" | "error" | "interrupted";
	messageId?: string;
	cardType?: string | null;
	cardLayout?: string | null;
}

/** Raw API row (loose — server may add new fields and we tolerate them). */
interface ApiToolCallRow {
	id: string;
	extensionId: string;
	toolName: string;
	status: "success" | "error" | "interrupted";
	input: Record<string, unknown> | null;
	outputSummary: string | null;
	fullOutput?: string | null;
	success: boolean;
	durationMs: number;
	messageId?: string | null;
	cardType?: string | null;
	cardLayout?: string | null;
}

/** Raw `/messages?withToolCalls=true` payload. */
export interface MessagesWithToolCallsResponse {
	messages?: Array<{ id: string; toolCalls?: ApiToolCallRow[] }>;
	orphanedToolCalls?: ApiToolCallRow[];
	subConversations?: Array<{
		id: string;
		agentName?: string;
		agentConfigId?: string;
		parentMessageId?: string;
		messageCount?: number;
		lastMessagePreview?: string | null;
	}>;
	subConversationToolCalls?: Record<string, ApiToolCallRow[]>;
}

/** Result of unpacking the with-tool-calls response into store-ready slices. */
export interface HydratedToolCallsBundle {
	historicalToolCalls: HistoricalToolCall[];
	hydrateInput: HydrateInputCall[];
	subConversations: SubConvoRecord[] | null;
	subToolCalls: Record<string, HydrateInputCall[]>;
}

// ── Pure tree-walk helpers ──────────────────────────────────────────────

/**
 * Walk forward from `messageId` through children, always picking the
 * most-recently-created child, until a leaf is reached. Returns the
 * starting id when the message has no children. Returns the input id
 * unchanged when no message with that id exists in the array (the walk
 * just doesn't proceed).
 *
 * Equivalent to the original page's `findLeafFromAll` but takes the
 * messages array as an argument instead of reading the page's `$state`.
 */
export type FindLeafByMessageId = typeof findLeafByMessageId;
export function findLeafByMessageId(messages: Message[], messageId: string): string {
	let current = messageId;
	while (true) {
		const children = messages.filter((m) => m.parentMessageId === current);
		if (children.length === 0) return current;
		// Pick latest child (sort ascending, take last).
		children.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		current = children[children.length - 1]!.id;
	}
}

/**
 * Find the most recently-created leaf in the conversation tree. A "leaf"
 * is a message with no children. Falls back to the last message in the
 * array when no leaves are found (a fully cyclic / malformed tree — in
 * practice this shouldn't happen but the original page guarded for it).
 */
export type ComputeLatestLeaf = typeof computeLatestLeaf;
export function computeLatestLeaf(msgs: Message[]): string | null {
	if (msgs.length === 0) return null;
	const parentIds = new Set(msgs.map((m) => m.parentMessageId).filter(Boolean));
	const leaves = msgs.filter((m) => !parentIds.has(m.id));
	if (leaves.length === 0) return msgs[msgs.length - 1]?.id ?? null;
	return leaves.reduce((latest, m) =>
		m.createdAt.localeCompare(latest.createdAt) > 0 ? m : latest,
	).id;
}

/**
 * Pure transform: split the `/messages?withToolCalls=true` server response
 * into the four slices the hydration step needs. Caller is responsible for
 * pushing them into `inlineToolStore` and the host slots — keeping this
 * pure makes it trivial to unit-test.
 */
export function hydrateToolCallsFromApiData(
	data: MessagesWithToolCallsResponse,
): HydratedToolCallsBundle {
	const historicalToolCalls: HistoricalToolCall[] = [];
	const hydrateInput: HydrateInputCall[] = [];

	for (const msg of data.messages ?? []) {
		for (const tc of msg.toolCalls ?? []) {
			historicalToolCalls.push({
				id: tc.id,
				messageId: msg.id,
				extensionId: tc.extensionId,
				toolName: tc.toolName,
				status: tc.status,
				cardLayout: tc.cardLayout ?? null,
			});
			hydrateInput.push({ ...tc, messageId: msg.id });
		}
	}
	// Orphaned tool calls (card action buttons / inline invocations) keep
	// their own messageId from the row — null becomes undefined.
	for (const tc of data.orphanedToolCalls ?? []) {
		hydrateInput.push({ ...tc, messageId: tc.messageId ?? undefined });
	}

	const subConversations = data.subConversations?.length
		? data.subConversations.map<SubConvoRecord>((sc) => ({
				id: sc.id,
				agentName: sc.agentName ?? "Agent",
				agentConfigId: sc.agentConfigId ?? "",
				parentMessageId: sc.parentMessageId ?? "",
				messageCount: sc.messageCount ?? 0,
				lastMessagePreview: sc.lastMessagePreview ?? null,
			}))
		: null;

	const subToolCalls: Record<string, HydrateInputCall[]> = {};
	for (const [subId, calls] of Object.entries(data.subConversationToolCalls ?? {})) {
		subToolCalls[subId] = calls.map((tc) => ({
			...tc,
			messageId: tc.messageId ?? undefined,
		}));
	}

	return { historicalToolCalls, hydrateInput, subConversations, subToolCalls };
}

// ── Stateful loaders ────────────────────────────────────────────────────

export interface Slot<T> {
	get(): T;
	set(v: T): void;
}

export interface LoadMessagesHost {
	/** Active conversation id — read fresh every call. */
	convId(): string;

	// Per-message state
	allMessages: Slot<Message[]>;
	activeLeafId: Slot<string | null>;
	editingMessageId: Slot<string | null>;
	error: Slot<string | null>;

	// Conversation metadata
	currentConversation: Slot<Conversation | null>;
	selectedModel: Slot<{ provider: string; model: string } | null>;
	selectedMode: Slot<Mode | null>;
	availableModes(): Mode[];

	// Hydration outputs
	historicalToolCalls: Slot<HistoricalToolCall[]>;
	subConversations: Slot<SubConvoRecord[]>;

	/**
	 * `localStorage` provider — passed through so the page (and tests) can
	 * inject a stub. The page hands in `globalThis.localStorage` (or null
	 * during SSR); tests can hand in a fake.
	 */
	localStorage(): Storage | null;
}

export interface LoadMessagesApi {
	loadMessages(): Promise<void>;
	hydrateToolCallsFromApi(): Promise<void>;
}

export function makeLoadMessages(host: LoadMessagesHost): LoadMessagesApi {
	// Function-level dedup: if two callers (initial load + reconnect re-sync)
	// hit loadMessages() at the same moment, the second call gets the first
	// call's in-flight promise instead of launching a parallel three-fetch
	// cascade. Belt to the URL-level throttle's suspenders.
	let loadMessagesPending: { convId: string; promise: Promise<void> } | null = null;

	// Belt-and-suspenders: if hydrateToolCallsFromApi is called while a
	// previous call is still in flight for the same conversation, reuse the
	// pending promise instead of firing a parallel request. Prevents any
	// remaining call-site from accidentally spamming the endpoint.
	let hydratePending: { convId: string; promise: Promise<void> } | null = null;

	async function hydrateToolCallsFromApi(): Promise<void> {
		const cid = host.convId();
		if (hydratePending && hydratePending.convId === cid) {
			return hydratePending.promise;
		}
		const run = (async () => {
			try {
				await doHydrate();
			} finally {
				hydratePending = null;
			}
		})();
		hydratePending = { convId: cid, promise: run };
		return run;
	}

	async function doHydrate(): Promise<void> {
		const cid = host.convId();
		try {
			// Throttled + deduped by fetch-policy. Key is semantic
			// (messages-tools:<cid>) so querystring reshuffles or new callers
			// still collapse to one request.
			const res = await backgroundFetch(
				`messages-tools:${cid}`,
				`/api/conversations/${cid}/messages?withToolCalls=true`,
				{},
				{ minIntervalMs: 5000 },
			);
			if (!res || !res.ok) return;
			const data = (await res.json()) as MessagesWithToolCallsResponse;
			const bundle = hydrateToolCallsFromApiData(data);

			host.historicalToolCalls.set(bundle.historicalToolCalls);
			inlineToolStore.hydrateToolCalls(cid, bundle.hydrateInput);

			if (bundle.subConversations) {
				host.subConversations.set(bundle.subConversations);
			}

			// Hydrate sub-conversation tool calls so the Diff Summary panel
			// can show edits made by team members / invoked agents alongside
			// the parent's edits. Keyed by sub id — each call to
			// hydrateToolCalls(subId, …) replaces only that sub's entries.
			for (const [subId, calls] of Object.entries(bundle.subToolCalls)) {
				inlineToolStore.hydrateToolCalls(subId, calls);
			}
		} catch {
			/* non-critical */
		}
	}

	async function loadMessages(): Promise<void> {
		const cid = host.convId();
		if (!cid) return;
		if (loadMessagesPending && loadMessagesPending.convId === cid) {
			return loadMessagesPending.promise;
		}
		const capturedConvId = cid;
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

	async function doLoadMessages(): Promise<void> {
		const cid = host.convId();
		if (!cid) return;

		// Synchronously preload the user's last-used model from localStorage
		// BEFORE any await, so ModelSelector's parallel /api/models fetch
		// doesn't race in and fire onautoselect (which would persist
		// models[0] to the DB and clobber the conversation's actual stored
		// model on next refresh).
		if (!host.selectedModel.get()) {
			const preload = restoreLastModel(host.localStorage());
			if (preload) host.selectedModel.set(preload);
		}

		try {
			// Route both reads through the fetch-policy. A flaky SSE that
			// triggers N reconnect re-syncs in quick succession collapses to
			// a single actual pair of GETs, eliminating the visible spam of
			//   GET /api/conversations/:id
			//   GET /api/conversations/:id/messages?all=true
			// that used to appear once per reconnect cycle.
			const msgsRes = await backgroundFetch(
				`messages-all:${cid}`,
				`/api/conversations/${cid}/messages?all=true`,
				{},
				{ minIntervalMs: 5000 },
			);
			if (msgsRes && msgsRes.ok) {
				host.allMessages.set((await msgsRes.json()) as Message[]);
			} else if (msgsRes === null) {
				// Throttled; skip this refresh. Existing allMessages stays
				// current because the WS push path has kept it live.
			}
			host.activeLeafId.set(computeLatestLeaf(host.allMessages.get()));

			const convRes = await backgroundFetch(
				`conv:${cid}`,
				`/api/conversations/${cid}`,
				{},
				{ minIntervalMs: 5000 },
			);
			if (convRes && convRes.ok) {
				host.currentConversation.set((await convRes.json()) as Conversation);
			}

			// Hydrate historical tool calls + sub-conversations from API
			await hydrateToolCallsFromApi();

			// The conversation's stored model (if any) wins over localStorage
			// — it represents a deliberate per-conversation override.
			const conv = host.currentConversation.get();
			if (conv?.provider && conv?.model) {
				host.selectedModel.set({ provider: conv.provider, model: conv.model });
			}
			// Restore mode from conversation
			if (conv?.modeId) {
				host.selectedMode.set(host.availableModes().find((m) => m.id === conv.modeId) ?? null);
			} else {
				host.selectedMode.set(null);
			}
			host.editingMessageId.set(null);
			host.error.set(null);
			// Initial scroll-to-bottom is handled by the dedicated
			// `initialScrollDone` effect — it waits for the sentinel to exist
			// in the DOM, so it's reliable regardless of race conditions
			// between fetchAllMessages resolving and Svelte flushing the DOM.
			// Crucially: it does NOT re-fire on every loadMessages() call, so
			// a reconnect-driven re-sync cannot scrub the user's scroll
			// position.
		} catch (err) {
			host.error.set("Failed to load messages");
			console.error(err);
		}
	}

	return { loadMessages, hydrateToolCallsFromApi };
}
