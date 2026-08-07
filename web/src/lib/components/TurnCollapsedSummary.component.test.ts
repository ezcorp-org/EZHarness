/**
 * Component test for the row a folded turn leaves behind.
 *
 * It is one button, but the label is the whole point of the row: it is the
 * only thing telling the reader what the fold is hiding, so every branch of
 * it (singular / plural, tools present / absent) is pinned here.
 *
 * vitest + jsdom + @testing-library/svelte.
 */
import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import TurnCollapsedSummary from "./TurnCollapsedSummary.svelte";

beforeEach(() => {
	// `slide` calls Element.animate, which jsdom does not implement.
	if (!Element.prototype.animate) {
		Element.prototype.animate = (() => ({
			cancel() {},
			finished: Promise.resolve(),
			onfinish: null,
		})) as unknown as Element["animate"];
	}
});

const row = (): HTMLButtonElement =>
	document.querySelector<HTMLButtonElement>(
		'[data-testid="turn-collapsed-summary"]',
	)!;

describe("TurnCollapsedSummary", () => {
	test("reports replies and tools together", () => {
		render(TurnCollapsedSummary, { replies: 12, tools: 3, onexpand: () => {} });
		expect(row().textContent).toContain("12 replies · 3 tools");
	});

	test("drops the tools half when there are none", () => {
		// "· 0 tools" would read as a failure rather than a plain answer.
		render(TurnCollapsedSummary, { replies: 4, tools: 0, onexpand: () => {} });
		expect(row().textContent).toContain("4 replies");
		expect(row().textContent).not.toContain("tool");
	});

	test("singular forms for one reply and one tool", () => {
		render(TurnCollapsedSummary, { replies: 1, tools: 1, onexpand: () => {} });
		expect(row().textContent).toContain("1 reply · 1 tool");
		expect(row().textContent).not.toContain("replies");
		expect(row().textContent).not.toContain("tools");
	});

	test("a turn with no replies at all still renders a row", () => {
		render(TurnCollapsedSummary, { replies: 0, tools: 0, onexpand: () => {} });
		expect(row().textContent).toContain("0 replies");
	});

	test("announces itself as a collapsed control, with the label in the aria-label", () => {
		render(TurnCollapsedSummary, { replies: 2, tools: 0, onexpand: () => {} });
		expect(row().getAttribute("aria-expanded")).toBe("false");
		expect(row().getAttribute("aria-label")).toBe("Expand turn — 2 replies");
	});

	test("clicking asks the caller to unfold the turn", () => {
		const onexpand = vi.fn();
		render(TurnCollapsedSummary, { replies: 2, tools: 0, onexpand });
		row().click();
		expect(onexpand).toHaveBeenCalledTimes(1);
	});
});
