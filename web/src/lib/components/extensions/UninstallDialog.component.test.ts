/**
 * UninstallDialog — the stored-data decision.
 *
 * The confirm button is gated on an explicit choice, and that gate is the
 * component's whole reason to exist. A preselected "delete" is how people
 * destroy data they meant to keep; a preselected "keep" quietly orphans
 * directories nobody remembers to clean up. So: neither radio starts
 * checked, and "Uninstall" stays disabled until one is picked.
 *
 * Also covered: the choice reaches the caller as `purgeData`, the dialog
 * resets between openings (a "delete" chosen for one extension must not
 * carry into the next), `busy` locks every control, and Escape/backdrop
 * cancel — but never while a request is in flight.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi } from "vitest";
import { tick } from "svelte";
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

describe("UninstallDialog · the data choice is mandatory", () => {
	test("neither option is preselected", () => {
		const { getByTestId } = setup();

		expect(getByTestId("uninstall-keep-data")).not.toBeChecked();
		expect(getByTestId("uninstall-delete-data")).not.toBeChecked();
	});

	test("confirm is disabled until a choice is made, and says why", async () => {
		const { getByTestId, onconfirm } = setup();
		const confirm = getByTestId("uninstall-confirm");

		expect(confirm).toBeDisabled();
		expect(confirm).toHaveAttribute("title", expect.stringContaining("stored data"));

		await fireEvent.click(confirm);
		expect(onconfirm).not.toHaveBeenCalled();

		await fireEvent.click(getByTestId("uninstall-keep-data"));
		expect(confirm).toBeEnabled();
	});
});

describe("UninstallDialog · the choice reaches the caller", () => {
	test("keep → purgeData false", async () => {
		const { getByTestId, onconfirm } = setup();

		await fireEvent.click(getByTestId("uninstall-keep-data"));
		await fireEvent.click(getByTestId("uninstall-confirm"));

		expect(onconfirm).toHaveBeenCalledWith({ purgeData: false });
	});

	test("delete → purgeData true", async () => {
		const { getByTestId, onconfirm } = setup();

		await fireEvent.click(getByTestId("uninstall-delete-data"));
		await fireEvent.click(getByTestId("uninstall-confirm"));

		expect(onconfirm).toHaveBeenCalledWith({ purgeData: true });
	});

	test("a changed mind sends the LAST choice", async () => {
		const { getByTestId, onconfirm } = setup();

		await fireEvent.click(getByTestId("uninstall-delete-data"));
		await fireEvent.click(getByTestId("uninstall-keep-data"));
		await fireEvent.click(getByTestId("uninstall-confirm"));

		expect(onconfirm).toHaveBeenCalledWith({ purgeData: false });
	});
});

describe("UninstallDialog · reset between openings", () => {
	test("a choice does not carry into the next extension's dialog", async () => {
		const { getByTestId, rerender } = setup();
		await fireEvent.click(getByTestId("uninstall-delete-data"));
		expect(getByTestId("uninstall-confirm")).toBeEnabled();

		// Close, then reopen for a DIFFERENT extension.
		await rerender({ open: false });
		await rerender({ open: true, extensionName: "other-ext" });
		await tick();

		expect(getByTestId("uninstall-delete-data")).not.toBeChecked();
		expect(getByTestId("uninstall-confirm")).toBeDisabled();
	});
});

describe("UninstallDialog · naming what will be deleted", () => {
	test("shows the extension name and its data directory", () => {
		const { getByTestId } = setup();

		// The user is deciding about a specific directory — say which one.
		expect(getByTestId("uninstall-dialog")).toHaveTextContent("notes-keeper");
		expect(getByTestId("uninstall-dialog")).toHaveTextContent(
			".ezcorp/extension-data/notes-keeper/",
		);
	});

	test("says plainly that database-held state goes either way", () => {
		// The consent defect this replaced: the dialog offered to "keep stored
		// data" and promised a reinstall would "pick up where you left off",
		// while `extension_storage`, `extension_settings_user` and
		// `extension_secrets` all CASCADE off the `extensions` row and are
		// destroyed on every uninstall regardless of the choice. A consent
		// surface that overstates what it preserves is worse than one that
		// offers no choice, so the promise is now scoped to the files.
		const dialog = setup().getByTestId("uninstall-dialog");

		expect(dialog).toHaveTextContent(/settings, secrets and stored keys go with it/i);
		expect(dialog).toHaveTextContent(/cannot be kept/i);
		// The radios must not re-broaden the claim.
		expect(dialog).toHaveTextContent(/Keep its files/);
		expect(dialog).toHaveTextContent(/Delete its files/);
		expect(dialog).not.toHaveTextContent(/picks up where you left off/i);
	});

	test("renders nothing while closed", () => {
		const { queryByTestId } = setup({ open: false });

		expect(queryByTestId("uninstall-dialog")).toBeNull();
	});
});

describe("UninstallDialog · busy state", () => {
	test("every control locks and the button reports progress", () => {
		const { getByTestId, getByText } = setup({ busy: true });

		expect(getByTestId("uninstall-keep-data")).toBeDisabled();
		expect(getByTestId("uninstall-delete-data")).toBeDisabled();
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
