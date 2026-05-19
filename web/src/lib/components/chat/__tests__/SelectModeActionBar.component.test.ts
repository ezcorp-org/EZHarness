/**
 * DOM tests for SelectModeActionBar.svelte — the bulk-action toolbar shown
 * when chat select-mode is active. Covers the W2 contract:
 * - Renders the selected-count label ("3 turns selected").
 * - `oncancel` fires when the Cancel button is clicked.
 * - Fork / exclude / save-memory paths are disabled when isStreaming,
 *   selectCloning, or bulkBusy is true. (Exclude+save-memory are gated
 *   inside MessageToolbar by passing `undefined`, which hides those
 *   buttons; fork is disabled directly on the "Fork Chat" button.)
 * - `selectError` and `bulkStatus` render when truthy.
 */

import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi } from "vitest";
import SelectModeActionBar from "../SelectModeActionBar.svelte";

function defaultProps(overrides: Record<string, unknown> = {}) {
	return {
		selectedCount: 3,
		isStreaming: false,
		selectCloning: false,
		bulkBusy: false,
		allSelectedExcluded: false,
		bulkCopyContent: "user: hi\n\nassistant: hello",
		selectError: null,
		bulkStatus: null,
		oncancel: () => {},
		onfork: () => {},
		oncopy: () => {},
		onexclude: () => {},
		onsavememory: () => {},
		...overrides,
	};
}

describe("SelectModeActionBar", () => {
	test("renders selected-count label including the count", () => {
		const { getByTestId } = render(SelectModeActionBar, defaultProps({ selectedCount: 3 }));
		const count = getByTestId("selected-count");
		expect(count).toHaveTextContent("3");
		// Plural label when count !== 1.
		expect(count.parentElement?.textContent).toContain("turns selected");
	});

	test("uses singular 'turn' label when selectedCount === 1", () => {
		const { getByTestId } = render(SelectModeActionBar, defaultProps({ selectedCount: 1 }));
		const count = getByTestId("selected-count");
		expect(count.parentElement?.textContent).toContain("turn selected");
	});

	test("oncancel fires when the Cancel button is clicked", async () => {
		const oncancel = vi.fn();
		const { getByRole } = render(SelectModeActionBar, defaultProps({ oncancel }));
		await fireEvent.click(getByRole("button", { name: "Cancel" }));
		expect(oncancel).toHaveBeenCalledTimes(1);
	});

	test("onfork fires when the Fork Chat button is clicked", async () => {
		const onfork = vi.fn();
		const { getByTestId } = render(SelectModeActionBar, defaultProps({ onfork }));
		await fireEvent.click(getByTestId("new-chat-from-selection"));
		expect(onfork).toHaveBeenCalledTimes(1);
	});

	test("Fork Chat button is NOT disabled by isStreaming alone (parity with original page)", () => {
		// The original page only disables fork on `selectedIds.size === 0 ||
		// selectCloning || bulkBusy`. isStreaming gates the header-level
		// select-mode toggle, not the in-bar fork button. Keeping this here
		// to lock the contract — if a future change adds isStreaming to the
		// fork-disable list, this test (and the original behavior) must
		// change in lockstep.
		const { getByTestId } = render(SelectModeActionBar, defaultProps({ isStreaming: true }));
		expect(getByTestId("new-chat-from-selection")).not.toBeDisabled();
	});

	test("Fork Chat button is disabled when selectCloning", () => {
		const { getByTestId } = render(SelectModeActionBar, defaultProps({ selectCloning: true }));
		expect(getByTestId("new-chat-from-selection")).toBeDisabled();
	});

	test("Fork Chat button is disabled when bulkBusy", () => {
		const { getByTestId } = render(SelectModeActionBar, defaultProps({ bulkBusy: true }));
		expect(getByTestId("new-chat-from-selection")).toBeDisabled();
	});

	test("Cancel button is disabled while a bulk op is running (selectCloning || bulkBusy)", () => {
		const { getByRole, rerender } = render(
			SelectModeActionBar,
			defaultProps({ selectCloning: true }),
		);
		expect(getByRole("button", { name: "Cancel" })).toBeDisabled();
		rerender(defaultProps({ bulkBusy: true }));
		expect(getByRole("button", { name: "Cancel" })).toBeDisabled();
	});

	test("exclude button hidden (MessageToolbar receives undefined) when isStreaming", () => {
		const { queryByLabelText } = render(
			SelectModeActionBar,
			defaultProps({ isStreaming: true }),
		);
		// MessageToolbar omits the exclude/include button when onexclude is
		// undefined — which is exactly what the bar passes when isStreaming
		// or bulkBusy. Same path for both labels.
		expect(queryByLabelText("Exclude from LLM context")).toBeNull();
		expect(queryByLabelText("Include in LLM context")).toBeNull();
	});

	test("exclude button hidden when bulkBusy", () => {
		const { queryByLabelText } = render(SelectModeActionBar, defaultProps({ bulkBusy: true }));
		expect(queryByLabelText("Exclude from LLM context")).toBeNull();
		expect(queryByLabelText("Include in LLM context")).toBeNull();
	});

	test("save-memory button hidden (MessageToolbar receives undefined) when bulkBusy", () => {
		const { queryByLabelText } = render(SelectModeActionBar, defaultProps({ bulkBusy: true }));
		// MessageToolbar shows a "Save to memory" trigger only when
		// onsavememory is defined; the bar gates that on bulkBusy.
		expect(queryByLabelText(/save.*memor/i)).toBeNull();
	});

	test("MessageToolbar is omitted entirely when selectedCount === 0", () => {
		const { queryByTestId } = render(SelectModeActionBar, defaultProps({ selectedCount: 0 }));
		expect(queryByTestId("bulk-toolbar")).toBeNull();
	});

	test("renders selectError when truthy and not the bulkStatus row", () => {
		const { getByRole, queryByTestId } = render(
			SelectModeActionBar,
			defaultProps({ selectError: "boom", bulkStatus: "Saved 1 turn" }),
		);
		expect(getByRole("alert")).toHaveTextContent("boom");
		// bulkStatus is suppressed while selectError is present.
		expect(queryByTestId("bulk-status")).toBeNull();
	});

	test("renders bulkStatus when truthy and no selectError", () => {
		const { getByTestId } = render(
			SelectModeActionBar,
			defaultProps({ bulkStatus: "Copied 2 turns" }),
		);
		expect(getByTestId("bulk-status")).toHaveTextContent("Copied 2 turns");
	});

	test("renders neither status row when both are null", () => {
		const { queryByRole, queryByTestId } = render(SelectModeActionBar, defaultProps());
		expect(queryByRole("alert")).toBeNull();
		expect(queryByTestId("bulk-status")).toBeNull();
	});
});
