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
import { describe, test, expect } from "vitest";
import { createRawSnippet } from "svelte";

import Tooltip from "$lib/components/Tooltip.svelte";

const children = createRawSnippet(() => ({
	render: () => `<button>trigger</button>`,
}));

function renderTooltip(props: Record<string, unknown> = {}) {
	return render(Tooltip, { text: "A helpful description", children, ...props });
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

	test("hides on Escape", async () => {
		const { getByText, getByRole, queryByRole } = renderTooltip();
		const wrapper = getByText("trigger").parentElement!;
		await fireEvent.mouseEnter(wrapper);
		await waitFor(() => expect(getByRole("tooltip")).toBeInTheDocument());
		await fireEvent.keyDown(wrapper, { key: "Escape" });
		expect(queryByRole("tooltip")).toBeNull();
	});
});
