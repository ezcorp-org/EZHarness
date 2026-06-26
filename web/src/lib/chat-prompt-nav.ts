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
 */
export function promptNavDirection(e: {
	key: string;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	shiftKey?: boolean;
}): PromptNavDirection | null {
	if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
	if (e.key === "ArrowLeft") return "prev";
	if (e.key === "ArrowRight") return "next";
	return null;
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

/**
 * Pick the next nav step.
 *
 * `anchor` is the fold line (px from the top of the scroll container) that a
 * navigated-to prompt is parked at. `pointerId` is the prompt we last parked
 * there: if it is still within `band` px of the anchor we step relative to it
 * (so repeated presses walk cleanly without oscillating), otherwise we
 * re-derive the current prompt from the live scroll position (handles a
 * mouse-scroll between key presses).
 *
 * ArrowLeft stops at the top (`null`). ArrowRight past the last prompt returns
 * `{ kind: "bottom" }` so the caller can scroll to the bottom of the thread.
 */
export function resolvePromptNav(
	state: PromptNavState,
	direction: PromptNavDirection,
	pointerId: string | null,
	anchor: number,
	band = 24,
): PromptNavResult | null {
	const { ids, positions } = state;
	if (ids.length === 0) return null;

	const pointerIndex = pointerId !== null ? ids.indexOf(pointerId) : -1;
	let current: number;
	if (pointerIndex >= 0 && Math.abs(positions[pointerIndex]! - anchor) <= band) {
		// The pointer is still parked where we left it — step from it.
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
	/** Last prompt we parked at the fold (relative-step pointer), or null. */
	pointerId: string | null;
	/** Predicate: is this `data-message-id` a user prompt (vs assistant/tool)? */
	isUserPrompt: (id: string) => boolean;
	/** Attribute the message rows are keyed by (`data-message-id`). */
	anchorAttr: string;
	/** Px from the fold to park a navigated prompt at (also the nav anchor). */
	offset: number;
	/** Tolerance band for the "still parked" pointer check. */
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
 * `preventDefault`s only then) and the new `pointerId` to persist.
 */
export function applyPromptNav(
	opts: ApplyPromptNavOptions,
): { acted: boolean; pointerId: string | null } {
	const {
		container,
		direction,
		pointerId,
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

	const res = resolvePromptNav({ ids, positions }, direction, pointerId, offset, band);
	if (!res) return { acted: false, pointerId };

	if (res.kind === "bottom") {
		onBottomScroll?.();
		container.scrollTop = container.scrollHeight;
		return { acted: true, pointerId: null };
	}

	onPromptScroll?.();
	const top = scrollTopForAnchor(container, res.id, offset);
	if (top !== null) container.scrollTop = Math.max(0, top);
	return { acted: true, pointerId: res.id };
}
