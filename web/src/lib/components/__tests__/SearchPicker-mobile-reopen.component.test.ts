/**
 * Search pickers mount a BottomSheet below lg. The focus trap returns focus to
 * the input on close, so a native click must reopen even when focus does not
 * fire again. The opening focus also blurs when the sheet traps focus; that
 * blur must not close the sheet.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import AgentSearchPicker from "../AgentSearchPicker.svelte";
import ExtensionSearchPicker from "../ExtensionSearchPicker.svelte";
import ModelSearchPicker from "../ModelSearchPicker.svelte";
import ModeSearchPicker from "../ModeSearchPicker.svelte";
import ToolSearchPicker from "../ToolSearchPicker.svelte";

const realInnerWidth = window.innerWidth;
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
	setInnerWidth(realInnerWidth);
	vi.unstubAllGlobals();
});

async function verifyMobileCloseAndNativeReopen(renderPicker: () => void) {
	renderPicker();
	const input = screen.getByRole("combobox");
	await fireEvent.focus(input);
	await screen.findByTestId("bottom-sheet");

	// BottomSheet traps focus while mounting. This input blur is expected and
	// must not dismiss the sheet the user just opened.
	await fireEvent.blur(input);
	await sleep(200);
	expect(screen.queryByTestId("bottom-sheet")).not.toBeNull();

	await fireEvent.click(screen.getByRole("button", { name: "Close" }));
	await waitFor(() => expect(screen.queryByTestId("bottom-sheet")).toBeNull());

	// Focus restoration leaves the input focused. A native click must still
	// reopen it; focus-only opening leaves this interaction inert.
	input.focus();
	await fireEvent.click(input);
	await screen.findByTestId("bottom-sheet");
}

describe("search picker mobile dismissal and reopen", () => {
	test("agent picker survives focus-trap blur and reopens from a native click", async () => {
		await verifyMobileCloseAndNativeReopen(() => render(AgentSearchPicker, {
			agents: [{ id: "agent-a", name: "Agent A", description: "", category: "agent", prompt: "", capabilities: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
			onselect: vi.fn(),
		}));
	});

	test("extension picker survives focus-trap blur and reopens from a native click", async () => {
		await verifyMobileCloseAndNativeReopen(() => render(ExtensionSearchPicker, { selected: [], onchange: vi.fn() }));
	});

	test("model picker survives focus-trap blur and reopens from a native click", async () => {
		await verifyMobileCloseAndNativeReopen(() => render(ModelSearchPicker, { selected: null, onselect: vi.fn() }));
	});

	test("mode picker survives focus-trap blur and reopens from a native click", async () => {
		await verifyMobileCloseAndNativeReopen(() => render(ModeSearchPicker, { selected: null, onselect: vi.fn() }));
	});

	test("tool picker survives focus-trap blur and reopens from a native click", async () => {
		await verifyMobileCloseAndNativeReopen(() => render(ToolSearchPicker, { selected: [], onchange: vi.fn() }));
	});
});
