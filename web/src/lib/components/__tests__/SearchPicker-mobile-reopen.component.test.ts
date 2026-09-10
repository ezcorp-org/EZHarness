/**
 * Search pickers mount a BottomSheet below lg. The focus trap returns focus to
 * the input on close, so a click event must reopen even when focus does not
 * fire again. The browser suite proves the equivalent native interaction.
 * The opening focus also blurs when the sheet traps focus; that blur must not
 * close the sheet.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AgentSearchPicker from "../AgentSearchPicker.svelte";
import ExtensionSearchPicker from "../ExtensionSearchPicker.svelte";
import ModelSearchPicker from "../ModelSearchPicker.svelte";
import ModeSearchPicker from "../ModeSearchPicker.svelte";
import ToolSearchPicker from "../ToolSearchPicker.svelte";

const realInnerWidth = window.innerWidth;
function setInnerWidth(width: number) {
	Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
}

beforeEach(() => {
	setInnerWidth(393);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			if (input.includes("/api/extensions")) {
				return Response.json({ extensions: [{ id: "extension-a", name: "Extension A" }] });
			}
			if (input.includes("/api/models")) {
				return Response.json([{ provider: "mock", model: "model-a", tier: "fast", costTier: "low", available: true }]);
			}
			if (input.includes("/api/modes")) {
				return Response.json([{ id: "mode-a", name: "Mode A", slug: "mode-a", description: "", toolRestriction: "all" }]);
			}
			if (input.includes("/api/tools")) {
				return Response.json({ tools: [{ name: "tool-a", description: "", extension: "extension-a", extensionType: "extension" }] });
			}
			return Response.json({});
		}),
	);
});

afterEach(() => {
	vi.useRealTimers();
	setInnerWidth(realInnerWidth);
	vi.unstubAllGlobals();
});

async function verifyMobileCloseAndNativeReopen(renderPicker: () => void, resultLabel: string) {
	renderPicker();
	const input = screen.getByRole("combobox");
	await fireEvent.focus(input);
	const sheet = await screen.findByTestId("bottom-sheet");
	const sheetInput = within(sheet).getByRole("combobox");
	expect(sheetInput).not.toBe(input);
	await fireEvent.input(sheetInput, { target: { value: "no-picker-results-xyz" } });
	await waitFor(() => expect(within(sheet).queryByText(resultLabel, { exact: true })).toBeNull());
	await fireEvent.input(sheetInput, { target: { value: resultLabel } });
	await within(sheet).findByText(resultLabel, { exact: true });

	// BottomSheet traps focus while mounting. This input blur is expected and
	// must not dismiss the sheet the user just opened.
	vi.useFakeTimers();
	await fireEvent.blur(input);
	// Advance past the former 150ms desktop-close deadline. If a mobile blur
	// schedules that close, this assertion fails deterministically.
	await vi.advanceTimersByTimeAsync(151);
	expect(screen.queryByTestId("bottom-sheet")).not.toBeNull();
	vi.useRealTimers();

	await fireEvent.click(screen.getByRole("button", { name: "Close" }));
	await waitFor(() => expect(screen.queryByTestId("bottom-sheet")).toBeNull());

	// Focus restoration leaves the input focused. Model that state, then
	// dispatch the click event that must reopen the picker.
	input.focus();
	await fireEvent.click(input);
	await screen.findByTestId("bottom-sheet");
}

describe("search picker mobile dismissal and reopen", () => {
	test("agent picker survives focus-trap blur and reopens after a click event", async () => {
		await verifyMobileCloseAndNativeReopen(() => render(AgentSearchPicker, {
			agents: [{ id: "agent-a", name: "Agent A", description: "", category: "agent", prompt: "", capabilities: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
			onselect: vi.fn(),
		}), "Agent A");
	});

	test("extension picker survives focus-trap blur and reopens after a click event", async () => {
		await verifyMobileCloseAndNativeReopen(() => render(ExtensionSearchPicker, { selected: [], onchange: vi.fn() }), "Extension A");
	});

	test("model picker survives focus-trap blur and reopens after a click event", async () => {
		await verifyMobileCloseAndNativeReopen(() => render(ModelSearchPicker, { selected: null, onselect: vi.fn() }), "model-a");
	});

	test("mode picker survives focus-trap blur and reopens after a click event", async () => {
		await verifyMobileCloseAndNativeReopen(() => render(ModeSearchPicker, { selected: null, onselect: vi.fn() }), "Mode A");
	});

	test("tool picker survives focus-trap blur and reopens after a click event", async () => {
		await verifyMobileCloseAndNativeReopen(() => render(ToolSearchPicker, { selected: [], onchange: vi.fn() }), "tool-a");
	});
});
