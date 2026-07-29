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
 * Live geometry of the rendered prompts: parallel `ids` / `positions` (each
 * prompt's offset in px from the container fold), in top→bottom render order.
 */
export interface PromptNavState {
	ids: string[];
	positions: number[];
}

/**
 * Resolution of a single nav step:
 *  - `prompt` — scroll to / park this prompt at the fold.
 *  - `bottom` — ArrowRight past the last prompt: fall through to the very bottom.
 * `null` (returned by {@link resolvePromptNav}) means no-op (e.g. ArrowLeft at
 * the top — we stop, never wrap).
 */
export type PromptNavResult =
	| { kind: "prompt"; index: number; id: string }
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
 * ArrowLeft stops at the top (`null`). ArrowRight past the last prompt returns
 * `{ kind: "bottom" }` so the caller can scroll to the bottom of the thread.
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
	if (ids.length === 0) return null;

	const pointerIndex = pointerIsLive(pointer, view)
		? ids.indexOf(pointer.id)
		: -1;
	let current: number;
	if (pointerIndex >= 0) {
		// Nothing has scrolled since we parked it — step from it.
		current = pointerIndex;
	} else {
		// Re-derive: the last prompt at or above the fold line. Positions are
		// monotonic top→bottom, so the first prompt below the line ends the scan.
		current = -1;
		for (let i = 0; i < ids.length; i++) {
			if (positions[i]! <= anchor + band) current = i;
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

/** Options for {@link applyPromptNav}. `scrollTopForAnchor` is injected (rather
 *  than imported) so this stays decoupled + unit-testable with a stub. */
export interface ApplyPromptNavOptions {
	container: HTMLElement;
	direction: PromptNavDirection;
	/** Where the last nav left off (relative-step pointer), or null. */
	pointer: PromptNavPointer | null;
	/** Predicate: is this `data-message-id` a user prompt (vs assistant/tool)? */
	isUserPrompt: (id: string) => boolean;
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

/**
 * Measure the rendered user prompts inside `container`, resolve the nav step for
 * `direction`, and apply the scroll. Returns `acted` (did we move — the caller
 * `preventDefault`s only then) and the new `pointer` to persist.
 */
export function applyPromptNav(
	opts: ApplyPromptNavOptions,
): { acted: boolean; pointer: PromptNavPointer | null } {
	const {
		container,
		direction,
		pointer,
		isUserPrompt,
		anchorAttr,
		offset,
		band,
		scrollTopForAnchor,
		onPromptScroll,
		onBottomScroll,
	} = opts;

	const containerTop = container.getBoundingClientRect().top;
	const ids: string[] = [];
	const positions: number[] = [];
	for (const node of container.querySelectorAll<HTMLElement>(`[${anchorAttr}]`)) {
		const id = node.getAttribute(anchorAttr);
		if (!id || !isUserPrompt(id)) continue;
		ids.push(id);
		positions.push(node.getBoundingClientRect().top - containerTop);
	}

	const res = resolvePromptNav(
		{ ids, positions },
		direction,
		pointer,
		{ scrollTop: container.scrollTop, scrollHeight: container.scrollHeight },
		offset,
		band,
	);
	if (!res) return { acted: false, pointer };

	const toBottom = (): { acted: boolean; pointer: null } => {
		onBottomScroll?.();
		container.scrollTop = container.scrollHeight;
		return { acted: true, pointer: null };
	};

	if (res.kind === "bottom") return toBottom();

	const top = scrollTopForAnchor(container, res.id, offset);
	// A prompt inside the final screenful CANNOT be parked at the fold — the
	// browser clamps the scroll at the end of the range. It is already on
	// screen there, so stepping onto it means the same thing as stepping past
	// the last prompt: go to the bottom. (Scrolling to the clamped position
	// instead would leave the thread visually frozen for several presses.)
	const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
	if (direction === "next" && top !== null && top > maxScroll) return toBottom();

	onPromptScroll?.();
	if (top !== null) container.scrollTop = Math.max(0, top);
	// Record where we actually came to rest, not where we aimed — the browser
	// may have clamped the write, and the pointer's liveness is judged against
	// this exact resting state.
	return {
		acted: true,
		pointer: {
			id: res.id,
			scrollTop: container.scrollTop,
			scrollHeight: container.scrollHeight,
		},
	};
}
