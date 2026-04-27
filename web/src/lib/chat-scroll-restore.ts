/**
 * Decision logic + cache for "open chat → where do we land?".
 *
 * Rules (see plan):
 *   - If a run is currently streaming for this conversation → scroll to bottom.
 *   - Else if we have a remembered scroll position → restore it.
 *   - Else (first visit in this tab session) → scroll to bottom.
 *
 * The cache tracks four pieces of per-conversation state:
 *   - `scrollTop`        Numeric pixel offset. Used as a fallback when the
 *                        anchor message can't be located (e.g. it dropped out
 *                        of the visible window).
 *   - `windowSize`       The user's expanded pagination window — restored on
 *                        re-entry so the DOM has the same set of messages
 *                        rendered as when the user left, otherwise the anchor
 *                        / scrollTop would land on a different message.
 *   - `anchorMessageId`  Stable id of the message at the top of the viewport.
 *   - `anchorOffset`     Pixel distance from the container's top edge to the
 *                        top of the anchor message. May be negative if the
 *                        message extends above the fold.
 *
 * The anchor pair is what makes restore robust to late-rendering content
 * (tool-call cards, image generation): even if heights above the viewport
 * grow after the initial restore, scrolling to the anchor message keeps the
 * user on the same content rather than on a stale pixel offset.
 *
 * All fields are independently optional. In particular, `windowSize` may be
 * cached without `scrollTop` / anchor, which preserves first-visit semantics
 * in `decideOpenScroll` (it only checks `cachedScrollTop`).
 *
 * Storage is `sessionStorage` (per tab, survives a full page reload, cleared
 * on tab close) with an in-memory mirror so reads are cheap and so the module
 * still works in non-DOM environments (SSR, Bun unit tests). When
 * `sessionStorage` is unavailable or throws (Safari private mode, quota), we
 * silently fall back to memory-only — the only user-visible cost is losing
 * the restored scroll on the next reload.
 */

export function hasActiveStreamForConversation(
	convId: string,
	streamingRunToConversation: Record<string, string>,
): boolean {
	for (const c of Object.values(streamingRunToConversation)) {
		if (c === convId) return true;
	}
	return false;
}

export type OpenScrollDecision =
	| { kind: "scroll-to-bottom"; reason: "active-stream" | "first-visit" }
	| { kind: "restore"; scrollTop: number };

export function decideOpenScroll(args: {
	convId: string;
	streamingRunToConversation: Record<string, string>;
	cachedScrollTop: number | undefined;
}): OpenScrollDecision {
	if (hasActiveStreamForConversation(args.convId, args.streamingRunToConversation)) {
		return { kind: "scroll-to-bottom", reason: "active-stream" };
	}
	if (args.cachedScrollTop === undefined) {
		return { kind: "scroll-to-bottom", reason: "first-visit" };
	}
	return { kind: "restore", scrollTop: args.cachedScrollTop };
}

export interface ScrollState {
	scrollTop?: number;
	windowSize?: number;
	anchorMessageId?: string;
	anchorOffset?: number;
}

/** DOM attribute written by ChatMessage.svelte on every message wrapper. */
export const MESSAGE_ANCHOR_ATTR = "data-message-id";

/**
 * Find the message that owns the top of the viewport and return its id plus
 * the offset (in px) from the container's top edge to the message's top.
 * Returns `null` when no message wrapper is inside / straddling the fold —
 * e.g. before the message list mounts.
 *
 * "Owns the top" = the message whose top is at or above the container's top
 * edge AND whose bottom is below it. If every message starts below the top
 * (rare — only when scrolled all the way up), we use the first message and
 * its positive offset.
 */
export function computeAnchor(
	container: HTMLElement,
): { messageId: string; offset: number } | null {
	const containerTop = container.getBoundingClientRect().top;
	const wrappers = container.querySelectorAll<HTMLElement>(`[${MESSAGE_ANCHOR_ATTR}]`);
	if (wrappers.length === 0) return null;

	let firstBelow: { el: HTMLElement; offset: number } | null = null;
	for (const el of wrappers) {
		const rect = el.getBoundingClientRect();
		const offset = rect.top - containerTop;
		if (offset <= 0 && rect.bottom - containerTop > 0) {
			// Straddling the top — best anchor.
			const id = el.getAttribute(MESSAGE_ANCHOR_ATTR);
			if (id) return { messageId: id, offset };
		}
		if (offset > 0 && firstBelow === null) {
			firstBelow = { el, offset };
		}
	}
	if (firstBelow) {
		const id = firstBelow.el.getAttribute(MESSAGE_ANCHOR_ATTR);
		if (id) return { messageId: id, offset: firstBelow.offset };
	}
	return null;
}

/**
 * Compute the `scrollTop` value that places the given message at the saved
 * offset from the container's top edge. Returns `null` if the message isn't
 * currently in the DOM (e.g. pagination window collapsed).
 */
export function scrollTopForAnchor(
	container: HTMLElement,
	messageId: string,
	offset: number,
): number | null {
	const el = container.querySelector<HTMLElement>(
		`[${MESSAGE_ANCHOR_ATTR}="${CSS.escape(messageId)}"]`,
	);
	if (!el) return null;
	const containerTop = container.getBoundingClientRect().top;
	const elTop = el.getBoundingClientRect().top;
	// elTop - containerTop is the message's current offset from the fold.
	// We want it to equal `offset`, so adjust scrollTop by the difference.
	return container.scrollTop + (elTop - containerTop) - offset;
}

const STORAGE_PREFIX = "ezcorp:chat-scroll:";
const stateByConv = new Map<string, ScrollState>();

function getStorage(): Storage | undefined {
	try {
		return typeof sessionStorage !== "undefined" ? sessionStorage : undefined;
	} catch {
		return undefined;
	}
}

function readStored(convId: string): ScrollState | undefined {
	const storage = getStorage();
	if (!storage) return undefined;
	try {
		const raw = storage.getItem(STORAGE_PREFIX + convId);
		if (!raw) return undefined;
		const parsed = JSON.parse(raw) as ScrollState;
		// Defensive: ignore non-numeric / wrong-type values that could land
		// us in a bad scroll.
		const out: ScrollState = {};
		if (typeof parsed.scrollTop === "number" && Number.isFinite(parsed.scrollTop)) {
			out.scrollTop = parsed.scrollTop;
		}
		if (typeof parsed.windowSize === "number" && Number.isFinite(parsed.windowSize)) {
			out.windowSize = parsed.windowSize;
		}
		if (typeof parsed.anchorMessageId === "string" && parsed.anchorMessageId.length > 0) {
			out.anchorMessageId = parsed.anchorMessageId;
		}
		if (typeof parsed.anchorOffset === "number" && Number.isFinite(parsed.anchorOffset)) {
			out.anchorOffset = parsed.anchorOffset;
		}
		return Object.keys(out).length === 0 ? undefined : out;
	} catch {
		return undefined;
	}
}

function writeStored(convId: string, state: ScrollState): void {
	const storage = getStorage();
	if (!storage) return;
	try {
		storage.setItem(STORAGE_PREFIX + convId, JSON.stringify(state));
	} catch {
		// Quota exceeded or storage denied — keep the in-memory copy and move on.
	}
}

export function getCachedScrollState(convId: string): ScrollState | undefined {
	const mem = stateByConv.get(convId);
	if (mem) return mem;
	const stored = readStored(convId);
	if (stored) stateByConv.set(convId, stored);
	return stored;
}

/** Merge a partial update into the conversation's cached state. */
export function updateCachedScrollState(convId: string, partial: ScrollState): void {
	const existing = getCachedScrollState(convId) ?? {};
	const merged = { ...existing, ...partial };
	stateByConv.set(convId, merged);
	writeStored(convId, merged);
}

/** Test-only — clear the in-memory cache and any persisted entries. */
export function _resetScrollCache(): void {
	stateByConv.clear();
	const storage = getStorage();
	if (!storage) return;
	const toRemove: string[] = [];
	for (let i = 0; i < storage.length; i++) {
		const key = storage.key(i);
		if (key && key.startsWith(STORAGE_PREFIX)) toRemove.push(key);
	}
	for (const key of toRemove) {
		try {
			storage.removeItem(key);
		} catch {
			// ignore — best-effort cleanup
		}
	}
}
