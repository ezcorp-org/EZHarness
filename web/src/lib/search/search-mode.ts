/**
 * Search-mode persistence + hit grouping (Phase 66 — Sidebar Search, plan 01).
 *
 * The chat-search mode (hybrid / keyword / semantic) is a personal habit, so it
 * persists under a single GLOBAL localStorage key — NO projectId (UI-01/UI-02 +
 * CONTEXT lock). Only the user's explicit toggle persists; a per-request
 * `degraded`/`servedMode` from the server NEVER mutates the stored preference
 * (66-RESEARCH.md Pitfall 4).
 *
 * `SearchMode` / `MessageSearchHit` are the Phase 65 contract — imported from
 * `$lib/api.js`, never redefined.
 */
import type { SearchMode, MessageSearchHit } from "$lib/api.js";

/** Global LS key — intentionally contains no projectId (personal preference). */
export const SEARCH_MODE_LS_KEY = "chatSearch.mode";

/** UI-01 default: hybrid (lexical + semantic via RRF). */
export const DEFAULT_SEARCH_MODE: SearchMode = "hybrid";

const VALID_MODES: readonly SearchMode[] = ["hybrid", "keyword", "semantic"];

function isSearchMode(value: unknown): value is SearchMode {
	return typeof value === "string" && (VALID_MODES as readonly string[]).includes(value);
}

/**
 * Read the persisted search mode. Guards SSR (no localStorage), wraps the read
 * in try/catch (private-mode / quota throws), and validates the stored value —
 * any garbage / unknown value falls back to the default. Mirrors the
 * `loadCollapsed` pattern in ConversationList.svelte.
 */
export function loadSearchMode(): SearchMode {
	if (typeof localStorage === "undefined") return DEFAULT_SEARCH_MODE;
	try {
		const raw = localStorage.getItem(SEARCH_MODE_LS_KEY);
		return isSearchMode(raw) ? raw : DEFAULT_SEARCH_MODE;
	} catch {
		return DEFAULT_SEARCH_MODE;
	}
}

/**
 * Persist the user's explicit mode choice to the global key. Guarded + wrapped
 * so a storage failure (SSR / private mode / quota) is a silent no-op.
 */
export function persistSearchMode(mode: SearchMode): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(SEARCH_MODE_LS_KEY, mode);
	} catch {
		/* non-critical — preference simply won't survive reload */
	}
}

/** One conversation's worth of grouped message hits. */
export interface MessageHitGroup {
	conversationId: string;
	title: string;
	hits: MessageSearchHit[];
}

/**
 * Pure, `$derived`-friendly grouping of message hits by conversation,
 * preserving first-seen order and capturing the conversation title per group
 * (66-RESEARCH.md lines 278-288). The first hit seen for a conversation defines
 * its title.
 */
export function groupHitsByConversation(hits: MessageSearchHit[]): MessageHitGroup[] {
	const map = new Map<string, MessageHitGroup>();
	for (const h of hits) {
		const existing = map.get(h.conversationId);
		if (existing) {
			existing.hits.push(h);
		} else {
			map.set(h.conversationId, {
				conversationId: h.conversationId,
				title: h.conversationTitle,
				hits: [h],
			});
		}
	}
	return [...map.values()];
}
