import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi } from "vitest";
import UninstallDialog from "./UninstallDialog.svelte";

function setup(overrides: Record<string, unknown> = {}) {
	const onconfirm = vi.fn();
	const oncancel = vi.fn();
	const utils = render(UninstallDialog, {
		props: {
			open: true,
			extensionName: "notes-keeper",
			onconfirm,
			oncancel,
			...overrides,
		},
	});
	return { ...utils, onconfirm, oncancel };
}

describe("UninstallDialog · retained data", () => {
	test("confirms uninstall without offering data deletion", async () => {
		const { getByTestId, queryByRole, onconfirm } = setup();
		expect(queryByRole("radio")).toBeNull();
		expect(getByTestId("uninstall-confirm")).toBeEnabled();
		await fireEvent.click(getByTestId("uninstall-confirm"));
		expect(onconfirm).toHaveBeenCalledExactlyOnceWith({ purgeData: false });
	});

	test("names the extension and states the actual retention policy", () => {
		const dialog = setup().getByTestId("uninstall-dialog");
		expect(dialog).toHaveTextContent("notes-keeper");
		expect(dialog).toHaveTextContent("release history, settings, secrets, stored data and files are kept");
		expect(dialog).toHaveTextContent("Data deletion requires a separate review");
		expect(dialog).not.toHaveTextContent("cannot be kept");
	});

	test("closed dialogs render nothing and reopening never selects deletion", async () => {
		const { queryByTestId, getByTestId, rerender, onconfirm } = setup({ open: false });
		expect(queryByTestId("uninstall-dialog")).toBeNull();
		await rerender({ open: true, extensionName: "other-extension" });
		expect(getByTestId("uninstall-dialog")).toHaveTextContent("other-extension");
		await fireEvent.click(getByTestId("uninstall-confirm"));
		expect(onconfirm).toHaveBeenCalledExactlyOnceWith({ purgeData: false });
	});
});

describe("UninstallDialog · busy state", () => {
	test("every control locks and the button reports progress", () => {
		const { getByTestId, getByText } = setup({ busy: true });

		expect(getByTestId("uninstall-confirm")).toBeDisabled();
		expect(getByText("Cancel")).toBeDisabled();
		expect(getByTestId("uninstall-confirm")).toHaveTextContent("Uninstalling");
	});

	test("Escape and the backdrop do not cancel a request already in flight", async () => {
		const { getByTestId, oncancel } = setup({ busy: true });
		const backdrop = getByTestId("uninstall-dialog");

		await fireEvent.keyDown(backdrop, { key: "Escape" });
		await fireEvent.click(backdrop);

		expect(oncancel).not.toHaveBeenCalled();
	});
});

describe("UninstallDialog · dismissal", () => {
	test("Cancel, Escape and a backdrop click all cancel", async () => {
		const { getByTestId, getByText, oncancel } = setup();
		const backdrop = getByTestId("uninstall-dialog");

		await fireEvent.click(getByText("Cancel"));
		expect(oncancel).toHaveBeenCalledTimes(1);

		await fireEvent.keyDown(backdrop, { key: "Escape" });
		expect(oncancel).toHaveBeenCalledTimes(2);

		await fireEvent.click(backdrop);
		expect(oncancel).toHaveBeenCalledTimes(3);
	});

	test("a click INSIDE the panel does not cancel", async () => {
		const { getByTestId, oncancel } = setup();

		await fireEvent.click(getByTestId("uninstall-confirm").parentElement as HTMLElement);

		expect(oncancel).not.toHaveBeenCalled();
	});

	test("a non-Escape key does not cancel", async () => {
		const { getByTestId, oncancel } = setup();

		await fireEvent.keyDown(getByTestId("uninstall-dialog"), { key: "Enter" });

		expect(oncancel).not.toHaveBeenCalled();
	});
});
