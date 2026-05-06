/**
 * Pure helper extracted from the chat page's `handleTurnSaved` so the
 * extension-runId branch can be unit-tested without spinning up a full
 * Svelte component.
 *
 * Why this exists:
 * Extension-authored turns (synthetic runId prefix `ext:`) arrive
 * out-of-band when a user clicks a messageToolbar icon and the
 * subprocess calls `ezcorp/append-message`. Naïvely calling
 * `loadMessages()` is not enough: the chat page's mount-time
 * `loadMessages()` already hit the same `messages-all:<convId>`
 * throttle key seconds before the click, so the throttle silently
 * returns null and the new extension turn never gets fetched.
 *
 * The handler must:
 *   1. Drop the `messages-all:` and `messages-tools:` cooldowns
 *   2. Re-run `loadMessages()` to pick up the new row
 *   3. Re-run `hydrateToolCallsFromApi()` so any newly persisted
 *      `running` tool-call rows reach `inlineToolStore` (otherwise
 *      tool cards like KokoroTtsPlayerCard never mount even after
 *      the message row appears).
 *
 * This mirrors the existing `handleAgentComplete` cooldown-bust
 * pattern — see `web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte`.
 */

export interface HandleExtensionTurnDeps {
	/** Drop a fetch-policy cooldown by exact key. */
	invalidateFetchPolicy: (key: string) => void;
	/** Re-fetch the conversation's persisted message tree. */
	loadMessages: () => unknown;
	/** Re-fetch the conversation's tool-call rows into inlineToolStore. */
	hydrateToolCallsFromApi: () => unknown;
}

export interface HandleExtensionTurnInput {
	convId: string;
	messageId: string;
	/** Caller's snapshot — used to dedupe. */
	knownMessageIds: ReadonlySet<string> | { has(id: string): boolean };
}

/**
 * Returns true if a refresh was dispatched, false if it was a no-op
 * (caller already had the message). Pure function — all I/O happens
 * via the injected deps.
 */
export function handleExtensionTurnSaved(
	deps: HandleExtensionTurnDeps,
	input: HandleExtensionTurnInput,
): boolean {
	if (input.knownMessageIds.has(input.messageId)) return false;

	deps.invalidateFetchPolicy(`messages-all:${input.convId}`);
	deps.invalidateFetchPolicy(`messages-tools:${input.convId}`);
	void deps.loadMessages();
	void deps.hydrateToolCallsFromApi();
	return true;
}
