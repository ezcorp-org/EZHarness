/**
 * DOM tests for Tooltip.svelte — the shared fixed-position hover card.
 *
 * Covers the full show/hide contract plus the `header` prop added for the
 * tool-hover cards (bold first line above the description text):
 *   - hidden until hover; shows after the 300ms delay
 *   - renders header + text when `header` is set; text-only otherwise
 *   - hides on mouseleave and on Escape
 *
 * (web/src/__tests__/tooltip-logic.test.ts predates the fixed-position
 * rewrite and pins copied constants, not this component — these are the
 * component's real DOM tests.)
 *
 * vitest + jsdom + @testing-library/svelte. The 300ms show delay uses a
 * real timer; assertions poll via waitFor.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi } from "vitest";
import { createRawSnippet } from "svelte";

import Tooltip from "$lib/components/Tooltip.svelte";

const children = createRawSnippet(() => ({
	render: () => `<button>trigger</button>`,
}));

function renderTooltip(props: Record<string, unknown> = {}) {
	return render(Tooltip, { text: "A helpful description", children, ...props });
}

function rect(left: number, top: number, width = 20, height = 20): DOMRect {
	return {
		bottom: top + height,
		height,
		left,
		right: left + width,
		top,
		width,
		x: left,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

describe("Tooltip", () => {
	test("hidden until hovered; shows after the delay", async () => {
		const { getByText, queryByRole, getByRole } = renderTooltip();
		expect(queryByRole("tooltip")).toBeNull();
		await fireEvent.mouseEnter(getByText("trigger").parentElement!);
		await waitFor(() => {
			expect(getByRole("tooltip")).toHaveTextContent("A helpful description");
		});
	});

	test("renders the bold header line when `header` is set", async () => {
		const { getByText, getByRole } = renderTooltip({ header: "my_tool" });
		await fireEvent.mouseEnter(getByText("trigger").parentElement!);
		await waitFor(() => {
			const tip = getByRole("tooltip");
			expect(tip).toHaveTextContent("my_tool");
			expect(tip).toHaveTextContent("A helpful description");
			// The header is its own bold line above the text.
			expect(tip.querySelector(".font-semibold")?.textContent).toBe("my_tool");
		});
	});

	test("no header line when `header` is omitted", async () => {
		const { getByText, getByRole } = renderTooltip();
		await fireEvent.mouseEnter(getByText("trigger").parentElement!);
		await waitFor(() => {
			expect(getByRole("tooltip").querySelector(".font-semibold")).toBeNull();
		});
	});

	test("hides on mouseleave", async () => {
		const { getByText, getByRole, queryByRole } = renderTooltip();
		const wrapper = getByText("trigger").parentElement!;
		await fireEvent.mouseEnter(wrapper);
		await waitFor(() => expect(getByRole("tooltip")).toBeInTheDocument());
		await fireEvent.mouseLeave(wrapper);
		expect(queryByRole("tooltip")).toBeNull();
	});

	test("click cancels overlapping hover and focus delays", async () => {
		vi.useFakeTimers();
		try {
			const { getByText, queryByRole } = renderTooltip();
			const wrapper = getByText("trigger").parentElement!;
			await fireEvent.mouseEnter(wrapper);
			await fireEvent.focusIn(wrapper);
			await fireEvent.click(wrapper);

			await vi.advanceTimersByTimeAsync(300);
			expect(queryByRole("tooltip")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	test.each([
		["top", rect(100, 20), "95px", "48px"],
		["bottom", rect(100, window.innerHeight - 40), "95px", `${window.innerHeight - 58}px`],
		["left", rect(20, 100), "48px", "105px"],
		["right", rect(window.innerWidth - 40, 100), `${window.innerWidth - 78}px`, "105px"],
	])("flips %s placement at a viewport edge", async (position, triggerRect, expectedLeft, expectedTop) => {
		vi.useFakeTimers();
		try {
			const { getByText, getByRole } = renderTooltip({ position });
			const wrapper = getByText("trigger").parentElement!;
			vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
				return this === wrapper ? triggerRect : rect(0, 0, 30, 10);
			});

			await fireEvent.mouseEnter(wrapper);
			await vi.advanceTimersByTimeAsync(300);

			const tooltip = getByRole("tooltip");
			expect(tooltip).toHaveStyle({ left: expectedLeft, top: expectedTop });
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	test("repositions an open tooltip after resize and scroll", async () => {
		vi.useFakeTimers();
		try {
			const { getByText, getByRole } = renderTooltip();
			const wrapper = getByText("trigger").parentElement!;
			let triggerRect = rect(100, 100);
			vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
				return this === wrapper ? triggerRect : rect(0, 0, 30, 10);
			});

			await fireEvent.mouseEnter(wrapper);
			await vi.advanceTimersByTimeAsync(300);
			await vi.advanceTimersByTimeAsync(0);
			const tooltip = getByRole("tooltip");
			expect(tooltip).toHaveStyle({ left: "95px", top: "82px" });

			triggerRect = rect(200, 200);
			window.dispatchEvent(new Event("resize"));
			await vi.advanceTimersByTimeAsync(0);
			expect(tooltip).toHaveStyle({ left: "195px", top: "182px" });

			triggerRect = rect(300, 300);
			window.dispatchEvent(new Event("scroll"));
			await vi.advanceTimersByTimeAsync(0);
			expect(tooltip).toHaveStyle({ left: "295px", top: "282px" });
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	test("hides on Escape", async () => {
		const { getByText, getByRole, queryByRole } = renderTooltip();
		const wrapper = getByText("trigger").parentElement!;
		await fireEvent.mouseEnter(wrapper);
		await waitFor(() => expect(getByRole("tooltip")).toBeInTheDocument());
		await fireEvent.keyDown(wrapper, { key: "Escape" });
		expect(queryByRole("tooltip")).toBeNull();
	});
});
