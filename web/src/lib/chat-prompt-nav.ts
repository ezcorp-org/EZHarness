/**
 * Pure logic for arrow-key navigation between chat prompts (user messages).
 *
 * When the chat thread holds focus (and no text input does), ArrowLeft scrolls
 * UP to the previous prompt and ArrowRight scrolls DOWN to the next one. Pressing
 * ArrowRight while already on the last prompt falls through to the bottom of the
 * thread. `ChatThread.svelte` only wires this in; all decisions + the DOM
 * measurement/scroll glue live here so they are testable without the full
 * component (and the lone `.svelte` line gets no lcov anyway).
 */

export type PromptNavDirection = "prev" | "next";

/**
 * Map a keydown to a prompt-nav direction. Only a BARE ArrowLeft / ArrowRight
 * navigates — any modifier (Alt/Ctrl/Meta/Shift) is left to the browser so we
 * never hijack word-jump / history-back / accessibility shortcuts.
 *
 * An already-`defaultPrevented` event is left alone too: some in-thread UI
 * component (an image carousel, a card that owns the arrows) handled it
 * first, and the thread must not ALSO scroll underneath it.
 */
export function promptNavDirection(e: {
	key: string;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	shiftKey?: boolean;
	defaultPrevented?: boolean;
}): PromptNavDirection | null {
	if (e.defaultPrevented) return null;
	if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
	if (e.key === "ArrowLeft") return "prev";
	if (e.key === "ArrowRight") return "next";
	return null;
}

/**
 * True while a modal overlay owns the keyboard — the image lightbox opened
 * from a chat card, the command palette, a bottom sheet, any dialog. Every
 * one of them renders `aria-modal="true"` ONLY while open (the inline Ez
 * panel deliberately renders `aria-modal="false"`, so it doesn't match).
 *
 * Without this the thread scrolls behind an open lightbox: both the card and
 * the thread listen for arrows on `window`, so one press flipped the image
 * AND moved the conversation the user was reading.
 */
export function isNavBlockedByOverlay(
	doc: Pick<Document, "querySelector">,
): boolean {
	return doc.querySelector('[aria-modal="true"]') !== null;
}

/**
 * True when the element is a text-entry control, where arrows must keep their
 * native caret behaviour. Guards the composer, search inputs, selects, and any
 * contenteditable surface so typing is never hijacked.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
	const el = target as (HTMLElement & { tagName?: unknown }) | null;
	if (!el || typeof el.tagName !== "string") return false;
	const tag = el.tagName.toUpperCase();
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	return el.isContentEditable === true;
}

/**
 * Geometry of the conversation's prompts: parallel `ids` / `positions`, oldest
 * → newest.
 *
 * `ids` is EVERY user prompt in the conversation, not just the rendered ones.
 * The thread renders a tail window of the message list, so a prompt further up
 * has no geometry yet — its position is `null`, and because the window is
 * always a tail slice, a `null` is by definition ABOVE everything rendered.
 *
 * Measuring only the rendered rows is what broke the arrows in an agentic
 * conversation (one prompt, then twenty tool/assistant turns): the window held
 * no prompt at all, so there was nothing to step to and both keys went dead.
 */
export interface PromptNavState {
	ids: string[];
	positions: (number | null)[];
}

/**
 * Resolution of a single nav step:
 *  - `prompt` — scroll to / park this prompt at the fold.
 *  - `bottom` — ArrowRight past the last prompt: fall through to the very bottom.
 *  - `top` — ArrowLeft with nowhere to step: go to the very top of the thread.
 * `null` (returned by {@link resolvePromptNav}) means no-op (ArrowLeft already
 * on the first of several prompts — we stop, never wrap).
 */
export type PromptNavResult =
	| { kind: "prompt"; index: number; id: string }
	| { kind: "top" }
	| { kind: "bottom" };

/** The container's scroll state at the moment of a keypress. */
export interface ScrollView {
	scrollTop: number;
	scrollHeight: number;
}

/**
 * Where the nav left off: the prompt last navigated to, plus the container's
 * scroll state we came to rest in — `scrollTop` is the ACTUAL post-scroll
 * value (the browser may have clamped it to the end of the range) and
 * `scrollHeight` is how tall the thread was at that moment.
 */
export interface PromptNavPointer extends ScrollView {
	id: string;
}

/** Px of `scrollTop` drift still counted as "the user hasn't scrolled". */
const POINTER_SCROLL_EPSILON = 2;

/**
 * Is the pointer still authoritative? Yes unless the USER has scrolled since we
 * parked — the prompt we navigated to is then still the one we are "on",
 * wherever the layout has since pushed it on screen.
 *
 * Two things move `scrollTop` without the user touching anything, and both are
 * ruled out here:
 *  - the thread reflowing (a card mounting, an image or iframe arriving): the
 *    browser's scroll anchoring shifts `scrollTop` to hold the view steady.
 *    That always comes with a change in `scrollHeight`, which is how we tell it
 *    apart from a wheel/drag.
 *  - a scroll the browser clamped to the end of the range.
 *
 * Judging the pointer by the prompt's live offset instead (the old rule) broke
 * on exactly those reflows: a card growing pushed the parked prompt off the
 * fold, the pointer was written off as stale, and the next press re-derived a
 * prompt the user had already walked past — the arrows skipped, or stopped.
 */
function pointerIsLive(
	pointer: PromptNavPointer | null,
	view: ScrollView,
): pointer is PromptNavPointer {
	if (pointer === null) return false;
	if (view.scrollHeight !== pointer.scrollHeight) return true;
	return Math.abs(view.scrollTop - pointer.scrollTop) <= POINTER_SCROLL_EPSILON;
}

/**
 * Pick the next nav step.
 *
 * `anchor` is the fold line (px from the top of the scroll container) that a
 * navigated-to prompt is parked at. When `pointer` is still live (see
 * {@link pointerIsLive}) we step relative to it; otherwise the user scrolled
 * by hand since, so we re-derive the current prompt from the live geometry.
 *
 * ArrowLeft stops at the first prompt (`null`). ArrowRight past the last prompt
 * returns `{ kind: "bottom" }` so the caller can scroll to the bottom.
 *
 * A conversation with AT MOST ONE prompt is the exception: there is no prompt
 * to step to in either direction, so the arrows page the thread instead —
 * ArrowLeft to the top, ArrowRight to the bottom. Stepping between prompts and
 * paging one turn are the same gesture to the reader: "show me the start of
 * this / show me the end of it". (Before, ArrowLeft was simply a dead key in a
 * brand-new conversation, which is where a first-time user meets it; zero
 * prompts — a thread an agent opened — was a dead key in BOTH directions.)
 *
 * A prompt with a `null` position has not been rendered yet. It still counts:
 * the window is a tail slice, so it sits above everything on screen, and the
 * caller widens the window to reach it (see {@link applyPromptNav}'s `pending`).
 */
export function resolvePromptNav(
	state: PromptNavState,
	direction: PromptNavDirection,
	pointer: PromptNavPointer | null,
	view: ScrollView,
	anchor: number,
	band = 24,
): PromptNavResult | null {
	const { ids, positions } = state;
	if (ids.length <= 1) {
		return direction === "prev" ? { kind: "top" } : { kind: "bottom" };
	}

	const pointerIndex = pointerIsLive(pointer, view)
		? ids.indexOf(pointer.id)
		: -1;
	let current: number;
	if (pointerIndex >= 0) {
		// Nothing has scrolled since we parked it — step from it.
		current = pointerIndex;
	} else if (!positions.some((p) => p !== null)) {
		// NOTHING is rendered: every prompt is above the window, so the reader is
		// below all of them — deep in an agentic run's tail. One past the end, so
		// `prev` targets the LAST prompt (the nearest one above) and `next` falls
		// through to the bottom. Reading it as "we are standing on the last
		// prompt" instead would skip straight past it to the one before.
		current = ids.length;
	} else {
		// Re-derive: the last prompt at or above the fold line. Positions are
		// monotonic top→bottom, so the first prompt below the line ends the scan.
		// An unrendered prompt (`null`) is above the window, hence above the fold.
		current = -1;
		for (let i = 0; i < ids.length; i++) {
			const pos = positions[i] ?? null;
			if (pos === null || pos <= anchor + band) current = i;
			else break;
		}
	}

	if (direction === "prev") {
		const prev = current - 1;
		if (prev < 0) return null; // stop at the top, never wrap
		return { kind: "prompt", index: prev, id: ids[prev]! };
	}

	const next = current + 1;
	if (next < ids.length) return { kind: "prompt", index: next, id: ids[next]! };
	// ArrowRight on (or past) the last prompt → fall through to the bottom.
	return { kind: "bottom" };
}

/** Options for {@link parkPrompt}. */
export interface ParkPromptOptions {
	container: HTMLElement;
	direction: PromptNavDirection;
	/** `data-message-id` of the prompt to park at the fold. */
	id: string;
	/** Px from the fold to park it at. */
	offset: number;
	scrollTopForAnchor: (
		container: HTMLElement,
		id: string,
		offset: number,
	) => number | null;
	/** Called right before a prompt scroll (caller breaks stick-to-bottom). */
	onPromptScroll?: () => void;
	/** Called right before the bottom scroll (caller re-engages stick-to-bottom). */
	onBottomScroll?: () => void;
}

/**
 * Scroll a resolved prompt to the fold and return the pointer to persist —
 * `null` when we ended up at the bottom of the thread instead.
 *
 * Shared by {@link applyPromptNav} and by the caller's deferred path (a prompt
 * that had to be rendered first), so a nav step scrolls exactly one way.
 */
export function parkPrompt(opts: ParkPromptOptions): PromptNavPointer | null {
	const {
		container,
		direction,
		id,
		offset,
		scrollTopForAnchor,
		onPromptScroll,
		onBottomScroll,
	} = opts;

	const top = scrollTopForAnchor(container, id, offset);
	// A prompt inside the final screenful CANNOT be parked at the fold — the
	// browser clamps the scroll at the end of the range. It is already on
	// screen there, so stepping onto it means the same thing as stepping past
	// the last prompt: go to the bottom. (Scrolling to the clamped position
	// instead would leave the thread visually frozen for several presses.)
	const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
	if (direction === "next" && top !== null && top > maxScroll) {
		onBottomScroll?.();
		container.scrollTop = container.scrollHeight;
		return null;
	}

	onPromptScroll?.();
	if (top !== null) container.scrollTop = Math.max(0, top);
	// Record where we actually came to rest, not where we aimed — the browser
	// may have clamped the write, and the pointer's liveness is judged against
	// this exact resting state.
	return {
		id,
		scrollTop: container.scrollTop,
		scrollHeight: container.scrollHeight,
	};
}

/** Options for {@link applyPromptNav}. `scrollTopForAnchor` is injected (rather
 *  than imported) so this stays decoupled + unit-testable with a stub. */
export interface ApplyPromptNavOptions {
	container: HTMLElement;
	direction: PromptNavDirection;
	/** Where the last nav left off (relative-step pointer), or null. */
	pointer: PromptNavPointer | null;
	/** EVERY user prompt in the conversation, oldest → newest — including the
	 *  ones above the render window. Rows outside this list (assistant turns,
	 *  tool cards) are never nav targets. */
	promptIds: readonly string[];
	/** Attribute the message rows are keyed by (`data-message-id`). */
	anchorAttr: string;
	/** Px from the fold to park a navigated prompt at (also the nav anchor). */
	offset: number;
	/** Tolerance band for "at or above the fold" when re-deriving the current
	 *  prompt from the live geometry. */
	band?: number;
	scrollTopForAnchor: (
		container: HTMLElement,
		id: string,
		offset: number,
	) => number | null;
	/** Called right before a prompt scroll (caller breaks stick-to-bottom). */
	onPromptScroll?: () => void;
	/** Called right before the bottom scroll (caller re-engages stick-to-bottom). */
	onBottomScroll?: () => void;
}

/** Outcome of one nav step. */
export interface PromptNavOutcome {
	/** Did we move (or are we about to)? The caller `preventDefault`s only then. */
	acted: boolean;
	/** The pointer to persist. */
	pointer: PromptNavPointer | null;
	/** Set when the step resolved to a prompt the render window has not reached
	 *  yet: NOTHING has scrolled. The caller must widen the window to include
	 *  this id and then finish the step with {@link parkPrompt}. */
	pending?: { id: string; index: number };
}

/**
 * Measure `promptIds` inside `container`, resolve the nav step for `direction`,
 * and apply the scroll.
 */
export function applyPromptNav(opts: ApplyPromptNavOptions): PromptNavOutcome {
	const {
		container,
		direction,
		pointer,
		promptIds,
		anchorAttr,
		offset,
		band,
		scrollTopForAnchor,
		onPromptScroll,
		onBottomScroll,
	} = opts;

	const containerTop = container.getBoundingClientRect().top;
	const rendered = new Map<string, number>();
	for (const node of container.querySelectorAll<HTMLElement>(`[${anchorAttr}]`)) {
		const id = node.getAttribute(anchorAttr);
		if (!id) continue;
		rendered.set(id, node.getBoundingClientRect().top - containerTop);
	}
	const ids = [...promptIds];
	const positions = ids.map((id) => rendered.get(id) ?? null);

	const res = resolvePromptNav(
		{ ids, positions },
		direction,
		pointer,
		{ scrollTop: container.scrollTop, scrollHeight: container.scrollHeight },
		offset,
		band,
	);
	if (!res) return { acted: false, pointer };

	if (res.kind === "bottom") {
		onBottomScroll?.();
		container.scrollTop = container.scrollHeight;
		return { acted: true, pointer: null };
	}

	if (res.kind === "top") {
		// Same stick-to-bottom break as a prompt step: we are deliberately
		// leaving the live end of the thread.
		onPromptScroll?.();
		container.scrollTop = 0;
		return { acted: true, pointer: null };
	}

	// The target is above the render window. Measuring it — let alone scrolling
	// to it — needs it in the DOM first, so hand it back for the caller to
	// reveal. `acted` is already true: the press IS consumed, it just finishes
	// a tick later.
	if (positions[res.index] === null) {
		return { acted: true, pointer, pending: { id: res.id, index: res.index } };
	}

	return {
		acted: true,
		pointer: parkPrompt({
			container,
			direction,
			id: res.id,
			offset,
			scrollTopForAnchor,
			onPromptScroll,
			onBottomScroll,
		}),
	};
}
