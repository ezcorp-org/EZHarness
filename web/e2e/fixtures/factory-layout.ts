/**
 * Layout problems in the factory workspace: sideways page scroll, and any text
 * or control that ends past the viewport without a scroller or an ellipsis to
 * hold it. Returns the problems by name, so a spec asserts an empty list.
 */
import type { Page } from "@playwright/test";

export async function factoryLayoutOverflow(page: Page): Promise<string[]> {
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	const clipped = await page.evaluate(() => {
		const root = document.querySelector('[data-testid="factory-workspace"]');
		if (!root) return ["factory workspace missing"];
		const limit = document.documentElement.clientWidth;
		const inScroller = (element: Element) => {
			// Deliberate truncation: the direct parent clips with an ellipsis.
			const direct = element.parentElement ? getComputedStyle(element.parentElement) : null;
			if (direct && direct.overflowX === "hidden" && direct.textOverflow === "ellipsis") return true;
			for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
				if (/(auto|scroll)/.test(getComputedStyle(parent).overflowX)) return true;
			}
			return false;
		};
		const out: string[] = [];
		for (const element of root.querySelectorAll("h1, h2, h3, p, button, strong, small, code, td, th, label, a, select, input")) {
			const box = element.getBoundingClientRect();
			if (box.width === 0 || box.height === 0 || box.right <= limit + 1 || inScroller(element)) continue;
			out.push(`${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 40)}" ends at ${Math.round(box.right)}px`);
		}
		// Every view tab shows its whole label inside the viewport, so no view hides behind a scroll with no cue.
		for (const tab of root.querySelectorAll('[role="tab"]')) {
			const box = tab.getBoundingClientRect();
			const label = (tab.textContent ?? "").trim();
			if (box.left < -1 || box.right > limit + 1) out.push(`tab "${label}" is outside the viewport`);
			if (tab.scrollWidth > tab.clientWidth + 1) out.push(`tab "${label}" is clipped`);
		}
		return out;
	});
	return overflow > 0 ? [`the page scrolls sideways by ${overflow}px`, ...clipped] : clipped;
}
