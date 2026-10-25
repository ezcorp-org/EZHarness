import type { Locator } from "@playwright/test";
import { expect } from "./test-base.js";

/**
 * Assert that `backdrop` (a `ModalBackdrop`) covers the whole viewport: its box equals the viewport. With `onTop`, it
 * is also the top element at the four corners and along the bottom strip, where a margin used to leave the status bar
 * bright and clickable under an open modal. A popover's click-catcher shares the viewport with its popover, so it
 * checks the box only.
 */
export async function expectFullViewportBackdrop(backdrop: Locator, { onTop = true } = {}): Promise<void> {
	const viewport = backdrop.page().viewportSize()!;
	expect(await backdrop.boundingBox()).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
	if (!onTop) return;
	const uncovered = await backdrop.evaluate((el) => {
		const { innerWidth: w, innerHeight: h } = window;
		const points: Array<[number, number]> = [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2], [w / 2, h - 2], [w / 2, h - 12]];
		return points.filter(([x, y]) => !el.contains(document.elementFromPoint(x, y))).map(([x, y]) => `${x},${y}`);
	});
	expect(uncovered).toEqual([]);
}

/** The computed look of a backdrop: stacking order, wash, blur and cursor, as the browser resolved them. */
export function backdropLook(backdrop: Locator): Promise<{ zIndex: string; background: string; backdropFilter: string; cursor: string }> {
	return backdrop.evaluate((el) => {
		const style = getComputedStyle(el);
		return { zIndex: style.zIndex, background: style.backgroundColor, backdropFilter: style.backdropFilter, cursor: style.cursor };
	});
}
