/**
 * DOM tests for SkeletonLoader.svelte. Four render shapes (lines, card-grid,
 * list, form) + optional status-text footer. Each branch is exercised with a
 * distinct prop combo so we catch regressions if the layout logic changes.
 */

import { render, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach } from "vitest";
import SkeletonLoader from "./SkeletonLoader.svelte";

afterEach(() => cleanup());

describe("SkeletonLoader", () => {
	test("default 'lines' renders `lines` skeleton bars", () => {
		const { container } = render(SkeletonLoader, { lines: 3 });
		const bars = container.querySelectorAll(".skeleton-line");
		// 'lines' variant emits exactly `lines` bars.
		expect(bars.length).toBe(3);
	});

	test("different `lines` value produces different bar count (prop-driven)", () => {
		const { container } = render(SkeletonLoader, { lines: 7 });
		expect(container.querySelectorAll(".skeleton-line").length).toBe(7);
	});

	test("'card-grid' renders `count` cards, each with 3 bars", () => {
		const { container } = render(SkeletonLoader, { type: "card-grid", count: 4 });
		// Grid wrapper contains exactly `count` direct children.
		const cards = container.querySelectorAll(".grid > div");
		expect(cards.length).toBe(4);
		// Each card contains 3 skeleton lines → 12 total.
		expect(container.querySelectorAll(".skeleton-line").length).toBe(12);
	});

	test("'list' renders `rows` rows each with an avatar + 2 text bars", () => {
		const { container } = render(SkeletonLoader, { type: "list", rows: 3 });
		// Each row produces 3 skeleton-line elements (avatar + 2 text).
		expect(container.querySelectorAll(".skeleton-line").length).toBe(9);
	});

	test("'form' always renders 4 field blocks regardless of other props", () => {
		const { container } = render(SkeletonLoader, { type: "form", lines: 99, rows: 99, count: 99 });
		// 4 fields × 2 lines each = 8 skeleton lines.
		expect(container.querySelectorAll(".skeleton-line").length).toBe(8);
	});

	test("statusText prop renders a <p> footer when provided", () => {
		const { getByText } = render(SkeletonLoader, {
			type: "lines",
			statusText: "Loading projects…",
		});
		expect(getByText("Loading projects…").tagName).toBe("P");
		// And absent when omitted.
		cleanup();
		const { container: c2 } = render(SkeletonLoader, { type: "lines" });
		expect(c2.querySelector("p")).toBeNull();
	});
});
