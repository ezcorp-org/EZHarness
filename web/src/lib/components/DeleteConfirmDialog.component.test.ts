/**
 * DOM tests for DeleteConfirmDialog.svelte. Covers: hidden when closed,
 * title + body rendering when open, confirm + cancel callbacks, Escape
 * keydown triggers cancel, backdrop click triggers cancel, click on the
 * inner dialog does NOT.
 */

import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, vi } from "vitest";
import DeleteConfirmDialog from "./DeleteConfirmDialog.svelte";

afterEach(() => cleanup());

function renderDialog(open: boolean) {
	const onconfirm = vi.fn();
	const oncancel = vi.fn();
	const utils = render(DeleteConfirmDialog, {
		open,
		conversationTitle: "My Convo",
		onconfirm,
		oncancel,
	});
	return { ...utils, onconfirm, oncancel };
}

describe("DeleteConfirmDialog", () => {
	test("renders nothing when open=false", () => {
		const { queryByText } = renderDialog(false);
		expect(queryByText("Delete conversation")).toBeNull();
	});

	test("shows heading and conversation title when open", () => {
		const { getByText, getByRole } = renderDialog(true);
		expect(getByRole("heading", { name: "Delete conversation" })).toBeInTheDocument();
		expect(getByText("My Convo")).toBeInTheDocument();
	});

	test("clicking Delete fires onconfirm and not oncancel", async () => {
		const { getByRole, onconfirm, oncancel } = renderDialog(true);
		await fireEvent.click(getByRole("button", { name: "Delete" }));
		expect(onconfirm).toHaveBeenCalledTimes(1);
		expect(oncancel).not.toHaveBeenCalled();
	});

	test("clicking Cancel fires oncancel", async () => {
		const { getByRole, onconfirm, oncancel } = renderDialog(true);
		await fireEvent.click(getByRole("button", { name: "Cancel" }));
		expect(oncancel).toHaveBeenCalledTimes(1);
		expect(onconfirm).not.toHaveBeenCalled();
	});

	test("Escape keydown on backdrop fires oncancel", async () => {
		const { container, oncancel } = renderDialog(true);
		const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement;
		expect(backdrop).not.toBeNull();
		await fireEvent.keyDown(backdrop, { key: "Escape" });
		expect(oncancel).toHaveBeenCalledTimes(1);
	});

	test("clicking the backdrop (not the inner dialog) fires oncancel", async () => {
		const { container, oncancel } = renderDialog(true);
		const backdrop = container.querySelector(".fixed.inset-0") as HTMLElement;
		await fireEvent.click(backdrop);
		expect(oncancel).toHaveBeenCalledTimes(1);
	});

	test("clicking the inner dialog surface does NOT fire oncancel", async () => {
		const { getByRole, oncancel } = renderDialog(true);
		// The heading lives inside the inner dialog pane.
		const heading = getByRole("heading", { name: "Delete conversation" });
		await fireEvent.click(heading);
		expect(oncancel).not.toHaveBeenCalled();
	});
});
