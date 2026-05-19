/**
 * DOM tests for ShortcutHelp.svelte — the keyboard shortcuts modal. Covers:
 * - Hidden when open=false
 * - role/dialog + aria-modal when open
 * - Renders one row per shortcut (default set when no customization stored)
 * - Close button fires onclose
 * - Escape keydown on the backdrop fires onclose
 * - Clicking the backdrop (but not the inner dialog) fires onclose
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import ShortcutHelp from "./ShortcutHelp.svelte";
import { DEFAULT_SHORTCUTS } from "$lib/shortcuts.js";

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => cleanup());

describe("ShortcutHelp", () => {
	test("renders nothing when open=false", () => {
		const { queryByRole } = render(ShortcutHelp, { open: false, onclose: () => {} });
		expect(queryByRole("dialog")).toBeNull();
	});

	test("renders as aria-modal dialog with a Keyboard Shortcuts heading when open", () => {
		const { getByRole } = render(ShortcutHelp, { open: true, onclose: () => {} });
		const dialog = getByRole("dialog", { name: "Keyboard shortcuts" });
		expect(dialog).toHaveAttribute("aria-modal", "true");
		expect(getByRole("heading", { name: "Keyboard Shortcuts" })).toBeInTheDocument();
	});

	test("renders one row per DEFAULT_SHORTCUT binding when localStorage is empty", () => {
		const { container } = render(ShortcutHelp, { open: true, onclose: () => {} });
		// Each shortcut binding renders a <kbd>; count kbd elements as row count.
		const kbds = container.querySelectorAll("kbd");
		expect(kbds.length).toBe(DEFAULT_SHORTCUTS.length);
		// And the first binding's label is present in the DOM.
		expect(container.textContent).toContain(DEFAULT_SHORTCUTS[0]!.label);
	});

	test("Close button fires onclose", async () => {
		const onclose = vi.fn();
		const { getByLabelText } = render(ShortcutHelp, { open: true, onclose });
		await fireEvent.click(getByLabelText("Close"));
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("Escape keydown on backdrop fires onclose", async () => {
		const onclose = vi.fn();
		const { container } = render(ShortcutHelp, { open: true, onclose });
		const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement;
		expect(backdrop).not.toBeNull();
		await fireEvent.keyDown(backdrop, { key: "Escape" });
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("clicking backdrop surface fires onclose; clicking inner dialog does not", async () => {
		const onclose = vi.fn();
		const { container, getByRole } = render(ShortcutHelp, { open: true, onclose });
		const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement;
		// Inner dialog click should NOT bubble into an onclose call.
		await fireEvent.click(getByRole("heading", { name: "Keyboard Shortcuts" }));
		expect(onclose).not.toHaveBeenCalled();
		// Backdrop click (where currentTarget === target) should fire onclose.
		await fireEvent.click(backdrop);
		expect(onclose).toHaveBeenCalledTimes(1);
	});
});
