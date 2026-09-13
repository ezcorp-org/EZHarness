import type { Locator, Page } from "@playwright/test";

export interface Point { x: number; y: number }
export interface Box extends Point { width: number; height: number }

/** Every drag driver shares one contract, so a spec can take either. */
export type DragGesture = (page: Page, from: Point, to: Point, beforeRelease?: () => Promise<void>) => Promise<void>;

/**
 * Resolve once the document's web fonts have loaded. `font-display: swap`
 * lays every label out twice, so measure only after the second pass.
 */
export async function fontsReady(page: Page): Promise<void> {
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/**
 * A bounding box that is safe to hand to `page.mouse` / CDP input.
 *
 * `click()` re-runs actionability — visible, stable bounding box — in the
 * same step that presses. Raw pointer coordinates get neither: they are
 * numbers captured earlier, and the press lands on whatever occupies them when
 * it arrives. This helper closes the in-flight part of that gap: it waits for
 * the element to be visible and for the web fonts, then requires the box to
 * hold one position across two consecutive frames, and it fails closed on a
 * zero-area box (a hidden element measures as zeros that are perfectly
 * "stable"; `boundingBox()` would have returned null there).
 *
 * It cannot see a relayout that has not started yet. If the row will re-wrap
 * when later content arrives — the chip row does, when `/api/extensions`
 * resolves and the labels change from ids to names (CI run 34538320472) — the
 * caller must first wait for that content, then measure.
 */
export async function stableBoundingBox(locator: Locator): Promise<Box> {
	await locator.waitFor({ state: "visible" });
	await fontsReady(locator.page());
	const box = await locator.evaluate(async (element) => {
		const read = () => {
			const rect = element.getBoundingClientRect();
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		};
		const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		let previous = read();
		for (let frame = 0; frame < 120; frame++) {
			await nextFrame();
			const current = read();
			if (current.x === previous.x && current.y === previous.y && current.width === previous.width && current.height === previous.height) {
				return current;
			}
			previous = current;
		}
		throw new Error("Element never held one position across two frames");
	});
	if (box.width <= 0 || box.height <= 0) throw new Error(`Element is not measurable: ${JSON.stringify(box)}`);
	return box;
}

/**
 * `use:longPress` (web/src/lib/actions/longPress.ts) defaults to
 * `pointerTypes: ["touch", "pen"]` — mouse is DELIBERATELY excluded so
 * holding a desktop mouse button doesn't hijack a row (desktop has
 * shift+click). So `page.mouse.down()` → wait → `page.mouse.up()` does NOT
 * synthesise a long-press: `onPointerDown` returns at the pointerType check
 * and the timer is never armed. A spec that presses with the mouse and then
 * asserts on select-mode is testing nothing.
 *
 * Dispatch a touch-typed `pointerdown`/`pointerup` pair instead.
 */
const LONG_PRESS_DELAY_MS = 500;
const LONG_PRESS_BUFFER_MS = 200;

/**
 * Synthesize a touch press-and-hold on `locator` long enough to fire
 * `use:longPress`.
 *
 * The action's `setTimeout` is a REAL browser timer (no fake timers in e2e),
 * so the hold has to actually elapse: 500ms default delay + a 200ms buffer.
 * The trailing `pointerup` is a no-op for the gesture itself — the timer has
 * already fired — but it leaves the DOM in a clean released state for
 * whatever the caller does next.
 *
 * `clientX/clientY` are constant, so the action's `movementThreshold` veto
 * (10px) can never trip.
 */
export async function longPressTouch(locator: Locator): Promise<void> {
	const point = { pointerType: "touch", clientX: 10, clientY: 10 };
	await locator.dispatchEvent("pointerdown", point);
	await locator.page().waitForTimeout(LONG_PRESS_DELAY_MS + LONG_PRESS_BUFFER_MS);
	await locator.dispatchEvent("pointerup", point);
}

/** Drive browser-native touch input; synthetic pointer events do not exercise pan cancellation. */
export async function dragTouch(
	page: Page,
	from: Point,
	to: Point,
	beforeRelease?: () => Promise<void>,
): Promise<void> {
	const touch = await page.context().newCDPSession(page);
	try {
		await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
		for (let step = 1; step <= 10; step++) {
			await touch.send("Input.dispatchTouchEvent", {
				type: "touchMove",
				touchPoints: [{ x: from.x + (to.x - from.x) * step / 10, y: from.y + (to.y - from.y) * step / 10 }],
			});
		}
		await beforeRelease?.();
		await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	} finally {
		await touch.detach();
	}
}

/**
 * How far the pointer travels before the destination move.
 *
 * `svelte-dnd-action` arms the drag once either axis moves 3px
 * (`MIN_MOVEMENT_BEFORE_DRAG_START_PX`), so a 6px step clears it from any
 * angle — 6px at 45 degrees is 4.24px per axis. Keeping the step small also
 * leaves the destination move well clear of the library's 10px re-decision
 * tolerance (`TOLERANCE_PX` in its observer), which would otherwise freeze a
 * short drag on the index it picked at activation.
 */
const MOUSE_ACTIVATION_PX = 6;

/**
 * Drive a desktop drag in two observable stages.
 *
 * `svelte-dnd-action` creates its drag ghost only after the pointer crosses
 * its activation threshold. Moving directly to a distant destination can let
 * a busy browser process the threshold after it has already passed the target.
 * Confirming the ghost before the destination move keeps the gesture native
 * while making that state transition explicit.
 */
export async function dragMouse(
	page: Page,
	from: Point,
	to: Point,
	beforeRelease?: () => Promise<void>,
): Promise<void> {
	const distance = Math.hypot(to.x - from.x, to.y - from.y);
	if (distance === 0) throw new Error("Mouse drag requires distinct start and destination points");
	const activationDistance = Math.min(MOUSE_ACTIVATION_PX, distance / 2);
	const activationPoint = {
		x: from.x + (to.x - from.x) * activationDistance / distance,
		y: from.y + (to.y - from.y) * activationDistance / distance,
	};
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	try {
		await page.mouse.move(activationPoint.x, activationPoint.y);
		await page.locator("#dnd-action-dragged-el").waitFor({ state: "visible" });
		await page.mouse.move(to.x, to.y, { steps: 10 });
		await beforeRelease?.();
	} finally {
		await page.mouse.up();
	}
}

/** Compile-time proof that both drivers honour `DragGesture`. */
export const dragGestures = { mouse: dragMouse, touch: dragTouch } satisfies Record<string, DragGesture>;
