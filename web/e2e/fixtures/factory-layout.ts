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

/** What a reader sees of the graph canvas: its theme, its parts' brightness, and its label size. */
export interface FactoryGraphReading {
	/** The canvas draws in dark mode. */
	readonly canvasDark: boolean;
	/** The app itself is in dark mode. */
	readonly appDark: boolean;
	/** Relative luminance (0 black, 1 white) of the zoom controls, the minimap, and the grid lines. */
	readonly controls: number;
	readonly minimap: number;
	readonly grid: number;
	/** The smallest rendered node-label font size, in CSS pixels, after the canvas zoom. */
	readonly labelPx: number;
}

/** Reads the factory graph canvas as rendered, so a journey can assert it follows the app theme and stays legible. */
export async function factoryGraphReading(page: Page): Promise<FactoryGraphReading> {
	return page.evaluate(() => {
		// Chromium reports color-mix() results as `color(srgb r g b / a)` and plain colours as `rgb(a)(...)`.
		const luminance = (value: string): number => {
			const srgb = value.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
			const rgb = value.match(/rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/);
			const channels = srgb ? srgb.slice(1, 4).map(Number) : rgb ? rgb.slice(1, 4).map(part => Number(part) / 255) : null;
			if (!channels) throw new Error(`unreadable colour ${value}`);
			const [r, g, b] = channels.map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
			return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
		};
		const one = (selector: string): Element => {
			const found = document.querySelector(`[data-testid="factory-graph"] ${selector}`);
			if (!found) throw new Error(`no ${selector} in the factory graph`);
			return found;
		};
		const scale = new DOMMatrixReadOnly(getComputedStyle(one(".svelte-flow__viewport")).transform).a;
		const labels = [...document.querySelectorAll('[data-testid="factory-graph"] .factory-node-label')];
		if (labels.length === 0) throw new Error("no node label in the factory graph");
		return {
			canvasDark: one(".svelte-flow").classList.contains("dark"),
			appDark: document.documentElement.classList.contains("dark"),
			controls: luminance(getComputedStyle(one(".svelte-flow__controls-button")).backgroundColor),
			minimap: luminance(getComputedStyle(one(".svelte-flow__minimap")).backgroundColor),
			grid: luminance(getComputedStyle(one(".svelte-flow__background path")).stroke),
			labelPx: Math.min(...labels.map(label => Number.parseFloat(getComputedStyle(label).fontSize) * scale)),
		};
	});
}

/** Smallest readable node label, in CSS pixels, after the canvas zoom. */
export const FACTORY_GRAPH_MIN_LABEL_PX = 11;

/**
 * Everything that makes the canvas hard to read, by name: a canvas theme that
 * differs from the app's, controls, minimap, or grid lines drawn for the other
 * theme, or labels shrunk below the readable size. Empty when it reads cleanly.
 */
export async function factoryGraphProblems(page: Page): Promise<string[]> {
	const reading = await factoryGraphReading(page);
	const problems: string[] = [];
	if (reading.canvasDark !== reading.appDark) problems.push(`the canvas is ${reading.canvasDark ? "dark" : "light"} in the ${reading.appDark ? "dark" : "light"} app`);
	for (const [part, name] of [["controls", "the zoom controls are"], ["minimap", "the minimap is"]] as const) {
		// Dark surfaces sit well under mid-grey luminance, light ones well over it.
		if (reading.appDark ? reading[part] > 0.2 : reading[part] < 0.6) problems.push(`${name} drawn for the other theme (luminance ${reading[part].toFixed(2)})`);
	}
	if (reading.appDark ? reading.grid > 0.35 : reading.grid < 0.35) problems.push(`the grid lines are drawn for the other theme (luminance ${reading.grid.toFixed(2)})`);
	if (reading.labelPx < FACTORY_GRAPH_MIN_LABEL_PX) problems.push(`node labels render at ${reading.labelPx.toFixed(1)} px`);
	return problems;
}
