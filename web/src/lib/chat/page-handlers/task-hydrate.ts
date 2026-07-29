/**
 * Task-panel cold-start hydration — transport half.
 *
 * `GET /api/conversations/:id/tasks` has always been the documented
 * "cold-start loader for the task-tracking panel" — it just had no caller, so
 * the panel was fed exclusively by `task:snapshot` bus events. Anything that
 * reset the client store therefore emptied the panel:
 *
 *   - a refresh, or opening the chat in a second tab (the reported bug)
 *   - an SSE drop, which loses every task event emitted during the gap
 *
 * This is the missing caller; `task-hydrate.svelte.ts` is the rune half that
 * decides WHEN to run it. The split is deliberate: importing the rune store
 * pulls `$state` into module scope, which `bun test` cannot execute, so the
 * logic worth testing lives here where it can be driven directly.
 */

/** Wire shape of `GET /api/conversations/:id/tasks`. */
export interface TaskSnapshotResponse {
	conversationId?: string;
	tasks?: unknown;
	activeTaskId?: string;
}

export interface TaskHydrationHost {
	/** Active conversation id — read fresh inside the effect so it tracks. */
	convId(): string;
	/** Reconnect counter; reading it makes the effect re-run on reconnect. */
	reconnectCount(): number;
	/** Counter of store-side "I got a delta I can't apply" resync requests. */
	requestCount(): number;
	/** Defaults to the global `fetch` when omitted. */
	fetchImpl?: typeof fetch;
	/** Write a fetched snapshot into the store (bound by the rune half). */
	apply(convId: string, payload: TaskSnapshotResponse, seqAtFetchStart: number): void;
	/** The store's live-event counter for a conversation. */
	seqFor(convId: string): number;
}

/**
 * Fetch the persisted snapshot for one conversation and hand it to `apply`.
 *
 * Resolves to `true` when a response was applied, `false` when the request
 * failed or was discarded. Never throws — a task panel that can't hydrate
 * must not break the chat page around it.
 */
export async function hydrateTaskSnapshot(
	host: TaskHydrationHost,
	convId: string,
	isCurrent: () => boolean,
): Promise<boolean> {
	if (!convId) return false;
	const doFetch = host.fetchImpl ?? fetch;
	// Snapshot the live-event counter BEFORE the request goes out — that is
	// what lets the reducer tell "nothing happened while I was reading" from
	// "the bus has already moved past this".
	const seqAtFetchStart = host.seqFor(convId);
	try {
		const res = await doFetch(`/api/conversations/${convId}/tasks`);
		if (!res.ok) return false;
		const payload = (await res.json()) as TaskSnapshotResponse;
		// The user navigated away (or a newer hydrate superseded this one)
		// while the request was in flight — writing now would show one
		// conversation's tasks under another.
		if (!isCurrent()) return false;
		host.apply(convId, payload, seqAtFetchStart);
		return true;
	} catch {
		return false;
	}
}
