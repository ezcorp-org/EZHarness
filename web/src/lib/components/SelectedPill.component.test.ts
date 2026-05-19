/**
 * DOM tests for SelectedPill.svelte. The pill is shared across every picker
 * combo box, so the label rendering, aria-label, and the two code paths that
 * trigger onremove (mousedown on the × button, Enter/Space keydown) all need
 * to stay locked down.
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import SelectedPill from "./SelectedPill.svelte";

afterEach(() => cleanup());

describe("SelectedPill", () => {
	test("renders the label text and sets optional title attribute", () => {
		const { getByTestId } = render(SelectedPill, {
			label: "gpt-4o",
			title: "OpenAI / gpt-4o",
			onremove: () => {},
		});
		const pill = getByTestId("selected-pill");
		expect(pill).toHaveTextContent("gpt-4o");
		expect(pill).toHaveAttribute("title", "OpenAI / gpt-4o");
	});

	test("omits the title attribute when not provided", () => {
		const { getByTestId } = render(SelectedPill, {
			label: "gpt-4o",
			onremove: () => {},
		});
		expect(getByTestId("selected-pill").hasAttribute("title")).toBe(false);
	});

	test("remove button has accessible label derived from `label`", () => {
		const { getByRole } = render(SelectedPill, {
			label: "claude-sonnet",
			onremove: () => {},
		});
		expect(getByRole("button", { name: "Remove claude-sonnet" })).toBeInTheDocument();
	});

	test("mousedown on the × button fires onremove", async () => {
		const onremove = vi.fn();
		const { getByRole } = render(SelectedPill, { label: "x", onremove });
		await fireEvent.mouseDown(getByRole("button", { name: "Remove x" }));
		expect(onremove).toHaveBeenCalledTimes(1);
	});

	test("Enter key on the × button fires onremove", async () => {
		const onremove = vi.fn();
		const { getByRole } = render(SelectedPill, { label: "x", onremove });
		await fireEvent.keyDown(getByRole("button", { name: "Remove x" }), { key: "Enter" });
		expect(onremove).toHaveBeenCalledTimes(1);
	});

	test("Space key on the × button fires onremove", async () => {
		const onremove = vi.fn();
		const { getByRole } = render(SelectedPill, { label: "x", onremove });
		await fireEvent.keyDown(getByRole("button", { name: "Remove x" }), { key: " " });
		expect(onremove).toHaveBeenCalledTimes(1);
	});

	test("other keys (e.g. Escape, Tab) do NOT fire onremove", async () => {
		const onremove = vi.fn();
		const { getByRole } = render(SelectedPill, { label: "x", onremove });
		const btn = getByRole("button", { name: "Remove x" });
		await fireEvent.keyDown(btn, { key: "Escape" });
		await fireEvent.keyDown(btn, { key: "Tab" });
		await fireEvent.keyDown(btn, { key: "a" });
		expect(onremove).not.toHaveBeenCalled();
	});
});
