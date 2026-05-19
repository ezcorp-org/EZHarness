/**
 * Phase 57 — UX-01 Wave 0 RED scaffold.
 *
 * Pins the BottomSheet contract before Wave 1 lands the component.
 * Failures here MUST be "Cannot find module '$lib/components/BottomSheet.svelte'"
 * (and the behavior assertions blocked on a missing import). The eight cases
 * lock the WCAG 2.5.1 single-pointer-equivalent surface called out in
 * must_haves and the iOS safe-area requirement from CONTEXT.md.
 *
 * Wave 1 (Plan 57-02 Task 2) will ship BottomSheet.svelte and flip every
 * case GREEN with no edits here.
 *
 * Runner: vitest (jsdom) — see web/vitest.config.ts.
 * NEVER bun:test for web/ — Svelte 5 needs the Vite + svelte-vite-plugin
 * compile path that vitest provides.
 */

import { render, screen, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi } from "vitest";
import { createRawSnippet } from "svelte";
import BottomSheet from "$lib/components/BottomSheet.svelte";

/**
 * Minimal snippet that renders `<div data-testid="sheet-content">hi</div>`.
 * Svelte 5's `children` prop expects a Snippet; createRawSnippet lets the
 * test caller pass an arbitrary DOM subtree without needing a wrapper
 * component file.
 */
function makeChildrenSnippet() {
	return createRawSnippet(() => ({
		render: () => `<div data-testid="sheet-content">hi</div>`,
	}));
}

describe("BottomSheet", () => {
	test("renders panel when open=true and aria-modal=true", () => {
		render(BottomSheet, {
			open: true,
			onclose: vi.fn(),
			children: makeChildrenSnippet(),
		});
		const sheet = screen.getByTestId("bottom-sheet");
		expect(sheet).toBeInTheDocument();
		expect(sheet).toHaveAttribute("aria-modal", "true");
		expect(sheet).toHaveAttribute("role", "dialog");
	});

	test("does NOT render panel when open=false", () => {
		render(BottomSheet, {
			open: false,
			onclose: vi.fn(),
			children: makeChildrenSnippet(),
		});
		expect(screen.queryByTestId("bottom-sheet")).toBeNull();
	});

	test("× button click invokes onclose", async () => {
		const onclose = vi.fn();
		render(BottomSheet, {
			open: true,
			onclose,
			children: makeChildrenSnippet(),
		});
		const closeBtn = screen.getByLabelText("Close");
		await fireEvent.click(closeBtn);
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("Escape key invokes onclose", async () => {
		const onclose = vi.fn();
		render(BottomSheet, {
			open: true,
			onclose,
			children: makeChildrenSnippet(),
		});
		await fireEvent.keyDown(window, { key: "Escape" });
		expect(onclose).toHaveBeenCalled();
	});

	test("backdrop click invokes onclose", async () => {
		const onclose = vi.fn();
		const { container } = render(BottomSheet, {
			open: true,
			onclose,
			children: makeChildrenSnippet(),
		});
		// Backdrop is the element painted with the bg-black/50 overlay.
		const backdrop = container.querySelector(".bg-black\\/50");
		expect(backdrop).not.toBeNull();
		await fireEvent.click(backdrop as Element);
		expect(onclose).toHaveBeenCalled();
	});

	test("applies padding-bottom: env(safe-area-inset-bottom, 0px) on the panel", () => {
		render(BottomSheet, {
			open: true,
			onclose: vi.fn(),
			children: makeChildrenSnippet(),
		});
		const panel = screen.getByTestId("bottom-sheet-panel");
		// Inline style must include env(safe-area-inset-bottom — verifies
		// the iOS home-indicator clearance per CONTEXT.md UX-01.
		expect(panel.getAttribute("style") ?? "").toContain(
			"env(safe-area-inset-bottom",
		);
	});

	test("renders ariaLabel as the dialog aria-label", () => {
		render(BottomSheet, {
			open: true,
			onclose: vi.fn(),
			ariaLabel: "Agent picker",
			children: makeChildrenSnippet(),
		});
		const sheet = screen.getByTestId("bottom-sheet");
		expect(sheet).toHaveAttribute("aria-label", "Agent picker");
	});

	test("close button has min 44x44 touch target (WCAG 2.5.5)", () => {
		render(BottomSheet, {
			open: true,
			onclose: vi.fn(),
			children: makeChildrenSnippet(),
		});
		const closeBtn = screen.getByLabelText("Close");
		const style = closeBtn.getAttribute("style") ?? "";
		expect(style).toContain("min-width: 44px");
		expect(style).toContain("min-height: 44px");
	});
});
