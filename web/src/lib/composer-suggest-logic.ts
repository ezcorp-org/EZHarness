/**
 * Pure decision logic for composer suggestions (tool chips + prompt
 * enhancement). ChatInput.svelte owns the timers/fetches/state — this
 * module owns every decision, mirroring the mention-logic split, so the
 * behavior is unit-testable without a DOM.
 *
 * UX contract (the part reviews flagged as make-or-break):
 *  - never fire while the mention popover or inline-tool UI is open
 *  - never render a response for a draft the user has already changed
 *    (staleness guard: responses are keyed by a normalized draft key)
 *  - the enhancement rewrite must never clobber mention chips — apply is
 *    only offered for plain-text drafts
 *  - when the sidecar reports unavailable, back off instead of probing on
 *    every pause
 */
import { parseMentions } from "$lib/mention-logic";

export interface SuggestedTool {
	name: string;
	extension: string;
	extensionType: string;
	description: string;
	score: number;
}

export interface Enhancement {
	enhanced: string;
	reason: string;
}

/** Longer than the mention autocomplete's 200ms: suggestions react to a
 *  typing PAUSE, not to keystrokes. */
export const SUGGEST_DEBOUNCE_MS = 600;

/** Below this (normalized) length a draft carries too little intent for
 *  embedding relevance to mean anything — don't suggest on "hi". */
export const MIN_SUGGEST_DRAFT_LENGTH = 12;

/** When the enhance endpoint reports the local model unavailable, stop
 *  asking for rewrites for this long (tool chips keep working). */
export const ENHANCE_BACKOFF_MS = 5 * 60_000;

/** Normalized draft identity — whitespace-insensitive so trailing-space
 *  keystrokes don't refetch, and the staleness guard key. */
export function suggestKey(draft: string): string {
	return draft.trim().replace(/\s+/g, " ");
}

export function isDraftEligible(
	wire: string,
	opts: { mentionOpen: boolean; inlineToolOpen: boolean; muted: boolean; minLength?: number },
): boolean {
	if (opts.muted || opts.mentionOpen || opts.inlineToolOpen) return false;
	return suggestKey(wire).length >= (opts.minLength ?? MIN_SUGGEST_DRAFT_LENGTH);
}

/** Staleness guard: only render a response that matches the current draft. */
export function isFresh(responseKey: string, currentKey: string): boolean {
	return responseKey === currentKey;
}

/** Apply-rewrite is plain-text-only: replacing a draft that carries mention
 *  tokens would silently destroy the user's chips. */
export function canApplyEnhancement(wire: string): boolean {
	return parseMentions(wire).length === 0;
}

export function enhanceAllowed(nowMs: number, backoffUntil: number): boolean {
	return nowMs >= backoffUntil;
}

export function nextEnhanceBackoff(nowMs: number, llmAvailable: boolean): number {
	return llmAvailable ? 0 : nowMs + ENHANCE_BACKOFF_MS;
}

/** The popover renders only when it has something to show — an empty box
 *  (or a lone spinner) is noise, not a suggestion. */
export function popoverVisible(state: {
	tools: SuggestedTool[];
	enhancement: Enhancement | null;
}): boolean {
	return state.tools.length > 0 || state.enhancement !== null;
}

/**
 * Append an extension-mention token to the draft (chip click). Unlike
 * mention-logic's insertMentionToken — which REPLACES an active sigil
 * trigger and no-ops without one — a suggestion chip has no trigger to
 * replace, so the token lands at the end of the draft.
 */
export function appendExtensionMention(
	wire: string,
	extension: string,
): { wire: string; cursor: number } {
	const sep = wire.length > 0 && !/\s$/.test(wire) ? " " : "";
	const next = `${wire}${sep}![ext:${extension}] `;
	return { wire: next, cursor: next.length };
}

/**
 * Request body for POST /api/composer/suggest. `modeId` is ALWAYS present
 * (null = explicitly no mode): the composer's selection is authoritative
 * over the conversation's persisted mode — same freshness semantics as
 * /api/tools?modeId=.
 */
export function buildSuggestBody(opts: {
	draft: string;
	conversationId?: string;
	/** Per-project toggle fallback — only consulted server-side when no
	 *  conversation scopes the call (the conversation's project wins). */
	projectId?: string;
	modeId: string | null;
	include: Array<"tools" | "enhance">;
}): string {
	const body: Record<string, unknown> = {
		draft: opts.draft,
		modeId: opts.modeId,
		include: opts.include,
	};
	if (opts.conversationId) body.conversationId = opts.conversationId;
	if (opts.projectId) body.projectId = opts.projectId;
	return JSON.stringify(body);
}
