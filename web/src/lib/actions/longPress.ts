/**
 * `use:longPress={{ onLongPress }}` — fires `onLongPress(event)` after the
 * pointer has been held on `node` for `delay` ms without moving more than
 * `movementThreshold` pixels. The follow-up synthetic `click` is suppressed
 * (capture phase, `preventDefault` + `stopImmediatePropagation`) so a row
 * that long-press-selects doesn't also fire its plain-click handler.
 *
 * Defaults to touch + pen only — desktop already has shift+click, and
 * hijacking mouse-hold would surprise users. Override via `pointerTypes`.
 *
 * `shouldFire(target)` lets the caller veto the gesture when the press
 * lands on an interactive descendant (anchor, button, input). Mirrors the
 * predicate `ChatMessage.handleRowClick` uses for plain clicks so e.g.
 * tapping a link inside a long-pressed row still navigates.
 */
export interface LongPressOptions {
	onLongPress: (event: PointerEvent) => void;
	delay?: number;
	movementThreshold?: number;
	pointerTypes?: ReadonlyArray<"touch" | "pen" | "mouse">;
	shouldFire?: (target: EventTarget | null) => boolean;
}

const DEFAULT_DELAY = 500;
const DEFAULT_MOVEMENT_PX = 10;
const DEFAULT_POINTER_TYPES: ReadonlyArray<"touch" | "pen" | "mouse"> = ["touch", "pen"];

export function longPress(node: HTMLElement, options: LongPressOptions) {
	let opts = options;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let startX = 0;
	let startY = 0;
	let fired = false;

	function clear() {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function onPointerDown(e: PointerEvent) {
		const allowed = opts.pointerTypes ?? DEFAULT_POINTER_TYPES;
		if (!allowed.includes(e.pointerType as "touch" | "pen" | "mouse")) return;
		if (opts.shouldFire && !opts.shouldFire(e.target)) return;
		clear();
		fired = false;
		startX = e.clientX;
		startY = e.clientY;
		const delay = opts.delay ?? DEFAULT_DELAY;
		timer = setTimeout(() => {
			timer = null;
			fired = true;
			opts.onLongPress(e);
		}, delay);
	}

	function onPointerMove(e: PointerEvent) {
		if (timer === null) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		const threshold = opts.movementThreshold ?? DEFAULT_MOVEMENT_PX;
		if (dx * dx + dy * dy > threshold * threshold) clear();
	}

	function onPointerEnd() {
		clear();
	}

	function onClickCapture(e: MouseEvent) {
		if (fired) {
			e.preventDefault();
			e.stopImmediatePropagation();
			fired = false;
		}
	}

	function onContextMenu(e: Event) {
		// Long-press on touch can trigger the OS callout (iOS magnifying glass,
		// Android selection handles). Suppress it once we've fired so the row
		// just shows our checkbox state instead of the OS UI.
		if (fired) e.preventDefault();
	}

	node.addEventListener("pointerdown", onPointerDown);
	node.addEventListener("pointermove", onPointerMove);
	node.addEventListener("pointerup", onPointerEnd);
	node.addEventListener("pointercancel", onPointerEnd);
	node.addEventListener("pointerleave", onPointerEnd);
	node.addEventListener("click", onClickCapture, true);
	node.addEventListener("contextmenu", onContextMenu);

	return {
		update(next: LongPressOptions) {
			opts = next;
		},
		destroy() {
			clear();
			node.removeEventListener("pointerdown", onPointerDown);
			node.removeEventListener("pointermove", onPointerMove);
			node.removeEventListener("pointerup", onPointerEnd);
			node.removeEventListener("pointercancel", onPointerEnd);
			node.removeEventListener("pointerleave", onPointerEnd);
			node.removeEventListener("click", onClickCapture, true);
			node.removeEventListener("contextmenu", onContextMenu);
		},
	};
}
