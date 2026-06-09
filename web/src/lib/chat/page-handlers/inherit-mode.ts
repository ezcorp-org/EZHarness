/**
 * First-paint mode inheritance for the chat composer's Tools popover.
 *
 * The chat route shell owns `selectedMode`, which is otherwise only set by an
 * explicit user pick (`handleModeChange`) or mode-create. On load it therefore
 * stays `null` and `ConversationToolsSelector` renders its empty "no mode"
 * baseline even when the conversation already carries a `modeId` with attached
 * extensions. This pure helper decides whether — and to what — the shell should
 * inherit `selectedMode` from the loaded conversation.
 *
 * Invariants the decision enforces:
 *   - Only sync once both the conversation and the mode list are loaded.
 *   - Only sync when the conversation we hold matches the active route
 *     (`convId`) — never inherit from a stale conversation mid-navigation.
 *   - Sync exactly once per conversation id (`lastSyncedConvId`), so an explicit
 *     mid-session `handleModeChange` (which stamps `lastSyncedConvId`) is never
 *     clobbered by a later re-run, yet navigating to a new conversation
 *     re-inherits.
 */
import type { Conversation, Mode } from "$lib/api";

export interface InheritModeInput {
	/** The conversation surfaced from <ChatThread>, or null before load. */
	currentConversation: Conversation | null;
	/** Modes fetched by the shell; empty until `fetchModes()` settles. */
	availableModes: Mode[];
	/** The active route conversation id (`page.params.convId`). */
	convId: string;
	/** The conversation id we last synced `selectedMode` for, or null. */
	lastSyncedConvId: string | null;
}

export type InheritModeDecision =
	| { sync: false }
	| { sync: true; mode: Mode | null; syncedConvId: string };

export function decideInheritedMode(
	input: InheritModeInput,
): InheritModeDecision {
	const { currentConversation, availableModes, convId, lastSyncedConvId } =
		input;

	// Not enough loaded yet to make a decision.
	if (!currentConversation || availableModes.length === 0) return { sync: false };
	// The conversation we hold belongs to a different route — don't inherit from
	// a stale conversation while navigation is in flight.
	if (currentConversation.id !== convId) return { sync: false };
	// Already synced (or an explicit in-session pick already stamped) this id.
	if (lastSyncedConvId === convId) return { sync: false };

	// A `modeId` that matches no fetched mode resolves to `null` (Default)
	// intentionally — re-inherit on conversation switch self-heals it; this
	// is NOT a load-order bug (the mode list is already settled by line 44).
	const mode = currentConversation.modeId
		? (availableModes.find((m) => m.id === currentConversation.modeId) ?? null)
		: null;
	return { sync: true, mode, syncedConvId: convId };
}
