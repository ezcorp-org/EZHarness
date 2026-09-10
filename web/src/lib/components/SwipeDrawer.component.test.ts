import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import SwipeDrawer from "./SwipeDrawer.svelte";

function children() {
	return createRawSnippet(() => ({
		render: () => '<button data-testid="drawer-action">Action</button><button data-testid="drawer-last">Last</button>',
	}));
}

function renderDrawer(overrides: Partial<{ open: boolean; side: "left" | "right"; backdrop: boolean; zIndex: number }> = {}) {
	const onclose = vi.fn();
	const result = render(SwipeDrawer, {
		open: true,
		side: "left",
		ariaLabel: "Navigation",
		onclose,
		children: children(),
		...overrides,
	});
	return { ...result, onclose };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SwipeDrawer DOM behavior", () => {
	test("opens as an accessible left drawer, contains its slot, and closes from the backdrop", async () => {
		const { onclose } = renderDrawer();
		const drawer = screen.getByTestId("swipe-drawer");
		expect(drawer).toHaveAttribute("role", "dialog");
		expect(drawer).toHaveAttribute("aria-modal", "true");
		expect(drawer).toHaveAttribute("aria-label", "Navigation");
		expect(screen.getByTestId("drawer-action")).toBeInTheDocument();

		await fireEvent.click(screen.getByTestId("swipe-drawer-backdrop"));
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("does not close when a user clicks within the panel", async () => {
		const { onclose } = renderDrawer({ side: "right" });
		const panel = screen.getByTestId("swipe-drawer-panel");
		expect(panel.className).toContain("right-0");
		await fireEvent.click(panel);
		expect(onclose).not.toHaveBeenCalled();
	});

	test("does not render a backdrop when callers opt out", () => {
		renderDrawer({ backdrop: false });
		expect(screen.queryByTestId("swipe-drawer-backdrop")).toBeNull();
	});

	test("ESC closes only the drawer with the highest z-index", async () => {
		const low = renderDrawer({ zIndex: 10 });
		const high = renderDrawer({ zIndex: 60, side: "right" });
		await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
		await fireEvent.keyDown(window, { key: "Escape" });
		expect(high.onclose).toHaveBeenCalledTimes(1);
		expect(low.onclose).not.toHaveBeenCalled();
	});

	test("a horizontal left-edge drag closes, while a vertical gesture stays a scroll", async () => {
		const horizontal = renderDrawer();
		const panel = screen.getByTestId("swipe-drawer-panel");
		Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 100 });
		await fireEvent.touchStart(panel, { touches: [{ clientX: 100, clientY: 20 }] });
		await fireEvent.touchMove(panel, { touches: [{ clientX: 40, clientY: 22 }] });
		expect(panel.getAttribute("style")).toContain("translateX(-60px)");
		await fireEvent.touchEnd(panel);
		expect(horizontal.onclose).toHaveBeenCalledTimes(1);

		horizontal.unmount();
		const vertical = renderDrawer();
		const scrollPanel = screen.getByTestId("swipe-drawer-panel");
		await fireEvent.touchStart(scrollPanel, { touches: [{ clientX: 100, clientY: 20 }] });
		await fireEvent.touchMove(scrollPanel, { touches: [{ clientX: 104, clientY: 80 }] });
		await fireEvent.touchEnd(scrollPanel);
		expect(vertical.onclose).not.toHaveBeenCalled();
	});

	test("close state keeps the panel for its animation then removes it", async () => {
		vi.useFakeTimers();
		const { rerender } = renderDrawer();
		await rerender({ open: false });
		expect(screen.getByTestId("swipe-drawer")).toBeInTheDocument();
		await vi.advanceTimersByTimeAsync(300);
		await waitFor(() => expect(screen.queryByTestId("swipe-drawer")).toBeNull());
		vi.useRealTimers();
	});
});
