import type { Locator, Page } from "@playwright/test";

/**
 * A bounding box that is safe to hand to `page.mouse` / CDP input.
 *
 * `click()` re-runs actionability — including a stable-bounding-box check —
 * in the same step that presses. Raw pointer coordinates get neither: they are
 * numbers captured earlier, and the press lands on whatever occupies them when
 * it arrives. `app.css` loads the UI font with `font-display: swap`, so every
 * label is laid out once in fallback metrics and again when the webfont
 * arrives; on a wrapping row that second pass can move a whole item to the
 * next line. Measured on CI run 34538320472: the extension chip row fitted
 * three chips on one line when the spec measured them (chip 2 at x=868.9,
 * chip 0 at x=362, same y), reflowed to two lines when the font swapped, and
 * `mouse.down()` then pressed chip 1 instead of chip 2 — the drag moved the
 * wrong chip and the spec timed out on an unchanged order.
 *
 * Wait for the fonts, then require the box to hold one position across two
 * consecutive frames.
 */
export async function stableBoundingBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
	await locator.page().evaluate(() => document.fonts.ready.then(() => undefined));
	return locator.evaluate(async (element) => {
		const read = () => {
			const box = element.getBoundingClientRect();
			return { x: box.x, y: box.y, width: box.width, height: box.height };
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
	from: { x: number; y: number },
	to: { x: number; y: number },
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
	from: { x: number; y: number },
	to: { x: number; y: number },
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
