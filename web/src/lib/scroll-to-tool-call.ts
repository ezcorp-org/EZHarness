/**
 * Scroll the chat viewport to a tool-call card by id, then briefly
 * highlight it. Wired up by the chat page as the `oncallclick`
 * callback on `<ContextUsageIndicator>` so a click on a per-call row
 * in the context-usage popover navigates straight to the matching
 * card in the message list.
 *
 * Anchors are written by `ChatMessage.svelte` (`#tool-call-${tc.id}`)
 * and by the unanchored `<InlineToolCard>` list on the chat page.
 *
 * Graceful no-op when the call isn't currently in the DOM (older
 * messages outside the loaded pagination window). Returns `true` on a
 * successful navigate, `false` otherwise — exposed primarily for
 * tests; production callers can ignore the return value.
 */
export const TOOL_CALL_ANCHOR_PREFIX = "tool-call-";
const HIGHLIGHT_CLASSES = ["ring-2", "ring-emerald-400/60", "rounded-md", "transition-all"];
const HIGHLIGHT_DURATION_MS = 1500;

export interface ScrollToToolCallOptions {
	/** Override the document used for `getElementById`. Defaults to
	 *  `globalThis.document`. Lets tests inject a sandboxed root. */
	doc?: Pick<Document, "getElementById">;
	/** How long the highlight stays on. Tests pass 0 to skip the wait. */
	highlightMs?: number;
}

export function scrollToToolCall(
	callId: string,
	opts: ScrollToToolCallOptions = {},
): boolean {
	if (!callId) return false;
	const doc = opts.doc ?? (typeof document !== "undefined" ? document : null);
	if (!doc) return false;
	const el = doc.getElementById(`${TOOL_CALL_ANCHOR_PREFIX}${callId}`);
	if (!el) return false;
	el.scrollIntoView({ behavior: "smooth", block: "center" });
	el.classList.add(...HIGHLIGHT_CLASSES);
	const ms = opts.highlightMs ?? HIGHLIGHT_DURATION_MS;
	if (ms > 0) {
		setTimeout(() => {
			// Strip only the highlight ring/colour so the layout-affecting
			// `rounded-md` / `transition-all` (also added by us) come off
			// together — leaving them behind would silently change the card's
			// visual once highlighted.
			el.classList.remove(...HIGHLIGHT_CLASSES);
		}, ms);
	}
	return true;
}
