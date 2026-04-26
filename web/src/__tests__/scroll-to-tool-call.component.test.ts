/**
 * Unit tests for `scrollToToolCall` — the helper wired up as
 * `<ContextUsageIndicator oncallclick={...}>` on the chat page so a
 * click on a per-call row in the context-usage popover navigates the
 * chat to the matching tool card.
 *
 * Locks down four contracts:
 *  1. Anchor lookup uses the `tool-call-${id}` id convention written
 *     by ChatMessage / InlineToolCard wrappers.
 *  2. `scrollIntoView` is called with smooth/center so the user lands
 *     mid-viewport (matches the chat scroll's restore behavior).
 *  3. The brief ring highlight is added immediately and removed after
 *     the configured timeout — no permanent visual mutation.
 *  4. Missing element / empty id / no document → graceful `false`
 *     return, no throw. Older messages outside the paginated window
 *     simply don't navigate; that's a known UX tradeoff documented in
 *     the helper module.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
	scrollToToolCall,
	TOOL_CALL_ANCHOR_PREFIX,
} from "$lib/scroll-to-tool-call";

function makeAnchor(id: string): HTMLElement {
	const el = document.createElement("div");
	el.id = id;
	document.body.appendChild(el);
	// jsdom doesn't implement `scrollIntoView` — patch on a per-element vi.fn
	// so each test can introspect the call args.
	(el as unknown as { scrollIntoView: ReturnType<typeof vi.fn> }).scrollIntoView = vi.fn();
	return el;
}

describe("scrollToToolCall", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = "";
	});

	test("anchors lookup uses the `tool-call-${id}` id prefix", () => {
		// The chat-page anchor convention (ChatMessage.svelte's wrapper +
		// InlineToolCard list on +page.svelte) MUST stay in sync with this
		// prefix — otherwise the popover's "jump to call" silently breaks.
		expect(TOOL_CALL_ANCHOR_PREFIX).toBe("tool-call-");
		const el = makeAnchor("tool-call-abc-123");
		expect(scrollToToolCall("abc-123")).toBe(true);
		expect((el as any).scrollIntoView).toHaveBeenCalledTimes(1);
	});

	test("calls scrollIntoView with smooth + center so the target lands mid-viewport", () => {
		const el = makeAnchor("tool-call-xyz");
		scrollToToolCall("xyz");
		expect((el as any).scrollIntoView).toHaveBeenCalledWith({
			behavior: "smooth",
			block: "center",
		});
	});

	test("adds a transient ring highlight that auto-removes after the configured timeout", () => {
		const el = makeAnchor("tool-call-h1");
		scrollToToolCall("h1");
		// Highlight applied synchronously so the user sees it on the next paint.
		expect(el.classList.contains("ring-2")).toBe(true);
		expect(el.classList.contains("ring-emerald-400/60")).toBe(true);

		vi.advanceTimersByTime(1499);
		expect(el.classList.contains("ring-2")).toBe(true); // not yet

		vi.advanceTimersByTime(2);
		expect(el.classList.contains("ring-2")).toBe(false);
		expect(el.classList.contains("ring-emerald-400/60")).toBe(false);
	});

	test("`highlightMs: 0` skips the timeout entirely (no pending timer leaks)", () => {
		// Tests use this knob to keep their fake-timer setup tiny. Production
		// always uses the default; the option exists strictly for testability.
		const el = makeAnchor("tool-call-h2");
		scrollToToolCall("h2", { highlightMs: 0 });
		// Highlight stays — caller asked for "no auto-remove".
		expect(el.classList.contains("ring-2")).toBe(true);
		// No pending timers were scheduled (vitest throws on unflushed timers
		// only via `expect(vi.getTimerCount()).toBe(0)`).
		expect(vi.getTimerCount()).toBe(0);
	});

	test("returns false and is a no-op when the anchor element is missing", () => {
		// Older messages outside the paginated window have no DOM anchor.
		// The helper must NOT throw and must NOT mutate any other element —
		// otherwise navigation silently corrupts an unrelated card.
		const decoy = makeAnchor("tool-call-other");
		expect(scrollToToolCall("ghost")).toBe(false);
		expect((decoy as any).scrollIntoView).not.toHaveBeenCalled();
		expect(decoy.classList.contains("ring-2")).toBe(false);
	});

	test("returns false on empty / undefined-ish id without touching the DOM", () => {
		const decoy = makeAnchor("tool-call-decoy");
		expect(scrollToToolCall("")).toBe(false);
		expect(scrollToToolCall(undefined as unknown as string)).toBe(false);
		expect((decoy as any).scrollIntoView).not.toHaveBeenCalled();
	});

	test("respects an injected `doc` so callers can sandbox the lookup", () => {
		// Lets a future callsite (e.g. shadow-DOM scoped popover) point the
		// helper at a different root without monkey-patching `document`.
		const el = makeAnchor("tool-call-root1"); // in real document
		const fakeDoc: Pick<Document, "getElementById"> = {
			getElementById: vi.fn(() => null),
		};
		expect(scrollToToolCall("root1", { doc: fakeDoc })).toBe(false);
		expect(fakeDoc.getElementById).toHaveBeenCalledWith("tool-call-root1");
		expect((el as any).scrollIntoView).not.toHaveBeenCalled();
	});

	test("returns false when there's no `document` available (SSR / non-browser caller)", () => {
		// The helper is imported from a Svelte component, which can run on
		// the server during SSR. It must NOT throw in that environment.
		const fakeDoc = undefined as unknown as Pick<Document, "getElementById">;
		// `doc: null` triggers the no-document branch; passing null would be a
		// type error so route via `as any` to mirror what SSR effectively gets.
		expect(scrollToToolCall("anything", { doc: fakeDoc })).toBe(false);
	});
});
