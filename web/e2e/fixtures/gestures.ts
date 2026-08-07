import type { Locator } from "@playwright/test";

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
