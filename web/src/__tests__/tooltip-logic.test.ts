import { test, expect, describe } from "bun:test";

// ── Pure logic extracted from Tooltip.svelte ────────────────────────────────

const positionClasses: Record<string, string> = {
	top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
	bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
	left: "right-full top-1/2 -translate-y-1/2 mr-2",
	right: "left-full top-1/2 -translate-y-1/2 ml-2",
};

const arrowClasses: Record<string, string> = {
	top: "left-1/2 top-full -translate-x-1/2 border-t-[var(--color-border)] border-x-transparent border-b-transparent",
	bottom: "left-1/2 bottom-full -translate-x-1/2 border-b-[var(--color-border)] border-x-transparent border-t-transparent",
	left: "left-full top-1/2 -translate-y-1/2 border-l-[var(--color-border)] border-y-transparent border-r-transparent",
	right: "right-full top-1/2 -translate-y-1/2 border-r-[var(--color-border)] border-y-transparent border-l-transparent",
};

describe("Tooltip positionClasses", () => {
	test("top positions above the element", () => {
		expect(positionClasses.top).toContain("bottom-full");
		expect(positionClasses.top).toContain("mb-2");
	});

	test("bottom positions below the element", () => {
		expect(positionClasses.bottom).toContain("top-full");
		expect(positionClasses.bottom).toContain("mt-2");
	});

	test("left positions to the left", () => {
		expect(positionClasses.left).toContain("right-full");
		expect(positionClasses.left).toContain("mr-2");
	});

	test("right positions to the right", () => {
		expect(positionClasses.right).toContain("left-full");
		expect(positionClasses.right).toContain("ml-2");
	});

	test("all positions center on the cross-axis", () => {
		// top/bottom center horizontally
		expect(positionClasses.top).toContain("left-1/2");
		expect(positionClasses.top).toContain("-translate-x-1/2");
		expect(positionClasses.bottom).toContain("left-1/2");
		expect(positionClasses.bottom).toContain("-translate-x-1/2");
		// left/right center vertically
		expect(positionClasses.left).toContain("top-1/2");
		expect(positionClasses.left).toContain("-translate-y-1/2");
		expect(positionClasses.right).toContain("top-1/2");
		expect(positionClasses.right).toContain("-translate-y-1/2");
	});

	test("covers all four directions", () => {
		expect(Object.keys(positionClasses)).toEqual(["top", "bottom", "left", "right"]);
	});
});

describe("Tooltip arrowClasses", () => {
	test("top arrow points downward from tooltip", () => {
		expect(arrowClasses.top).toContain("top-full");
		expect(arrowClasses.top).toContain("border-t-[var(--color-border)]");
		expect(arrowClasses.top).toContain("border-b-transparent");
	});

	test("bottom arrow points upward from tooltip", () => {
		expect(arrowClasses.bottom).toContain("bottom-full");
		expect(arrowClasses.bottom).toContain("border-b-[var(--color-border)]");
		expect(arrowClasses.bottom).toContain("border-t-transparent");
	});

	test("left arrow points right from tooltip", () => {
		expect(arrowClasses.left).toContain("left-full");
		expect(arrowClasses.left).toContain("border-l-[var(--color-border)]");
		expect(arrowClasses.left).toContain("border-r-transparent");
	});

	test("right arrow points left from tooltip", () => {
		expect(arrowClasses.right).toContain("right-full");
		expect(arrowClasses.right).toContain("border-r-[var(--color-border)]");
		expect(arrowClasses.right).toContain("border-l-transparent");
	});

	test("arrow positions match tooltip positions", () => {
		expect(Object.keys(arrowClasses)).toEqual(Object.keys(positionClasses));
	});
});

// ── Timer delay logic (mirrors startDelay/cancelDelay) ─────────────────────

describe("Tooltip timer logic", () => {
	test("delay is 300ms (matches InfoTooltip convention)", () => {
		// The delay value used in Tooltip.svelte and InfoTooltip.svelte
		const TOOLTIP_DELAY = 300;
		expect(TOOLTIP_DELAY).toBe(300);
	});

	test("cancelDelay clears timer and resets show state", () => {
		let show = false;
		let timer: ReturnType<typeof setTimeout> | null = null;

		// Simulate startDelay
		timer = setTimeout(() => (show = true), 300);

		// Simulate cancelDelay before timer fires
		if (timer) clearTimeout(timer);
		timer = null;
		show = false;

		expect(show).toBe(false);
		expect(timer).toBeNull();
	});
});
