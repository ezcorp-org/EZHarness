/**
 * Pins the picker's open/dismiss contract after the mobile self-dismiss fix
 * (2026-06-11). Below lg the picker body is wrapped in a BottomSheet whose
 * mount used to tear the picker down through three independent paths:
 * input blur (focus-trap steal), the opening tap's composed click hitting
 * the document click-outside handler, and the invisible backdrop (pinned
 * separately in BottomSheet.component.test.ts).
 *
 * Cases:
 *   Desktop (jsdom default innerWidth=1024 → bp.below=false):
 *     1. blur closes the dropdown after the 150ms grace (idiom preserved)
 *     2. a click whose press began OUTSIDE the input closes the dropdown
 *     3. a click whose press began ON the input (composed click — mousedown
 *        on input, mouseup elsewhere) does NOT close it
 *   Mobile (innerWidth=393 → bp.below=true):
 *     4. input blur does NOT close the sheet (focus-trap steals focus on
 *        mount; the sheet owns its own dismissal)
 *     5. clicks inside the sheet (e.g. selecting an option) do NOT close it
 *
 * Runner: vitest (jsdom) — matchMedia comes from src/__tests__/vitest-setup.ts.
 */

import { render, screen, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import ExtensionSearchPicker from "../ExtensionSearchPicker.svelte";

const REAL_INNER_WIDTH = window.innerWidth;

function setInnerWidth(px: number) {
	Object.defineProperty(window, "innerWidth", { value: px, configurable: true, writable: true });
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url.includes("/api/extensions")) {
				return new Response(
					JSON.stringify({
						extensions: [
							{ id: "ext-a", name: "Extension A", description: "ext A" },
							{ id: "ext-b", name: "Extension B", description: "ext B" },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
		}),
	);
});

afterEach(() => {
	setInnerWidth(REAL_INNER_WIDTH);
	vi.unstubAllGlobals();
});

async function openPicker() {
	const input = screen.getByRole("combobox");
	await fireEvent.focus(input);
	return input;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ExtensionSearchPicker dismiss semantics — desktop (≥lg)", () => {
	test("blur closes the dropdown after the grace period", async () => {
		render(ExtensionSearchPicker, { selected: [], onchange: vi.fn() });
		const input = await openPicker();
		expect(document.querySelector("#extension-picker-listbox")).not.toBeNull();

		await fireEvent.blur(input);
		await sleep(200);
		expect(document.querySelector("#extension-picker-listbox")).toBeNull();
	});

	test("click that began outside the input closes the dropdown", async () => {
		render(ExtensionSearchPicker, { selected: [], onchange: vi.fn() });
		await openPicker();
		expect(document.querySelector("#extension-picker-listbox")).not.toBeNull();

		await fireEvent.pointerDown(document.body);
		await fireEvent.click(document.body);
		expect(document.querySelector("#extension-picker-listbox")).toBeNull();
	});

	test("composed click whose press began on the input does NOT close the dropdown", async () => {
		render(ExtensionSearchPicker, { selected: [], onchange: vi.fn() });
		const input = await openPicker();
		expect(document.querySelector("#extension-picker-listbox")).not.toBeNull();

		// mousedown on the input, mouseup elsewhere → the browser dispatches
		// the click on a common ancestor (here: body). The press began on
		// the input, so the outside handler must ignore it.
		await fireEvent.pointerDown(input);
		await fireEvent.click(document.body);
		expect(document.querySelector("#extension-picker-listbox")).not.toBeNull();
	});
});

describe("ExtensionSearchPicker dismiss semantics — mobile (<lg, BottomSheet)", () => {
	beforeEach(() => setInnerWidth(393));

	test("opens in a BottomSheet and input blur does NOT close it", async () => {
		render(ExtensionSearchPicker, { selected: [], onchange: vi.fn() });
		const input = await openPicker();
		expect(screen.queryByTestId("bottom-sheet")).not.toBeNull();

		// The sheet's focus trap steals focus from the input on mount —
		// that blur must not dismiss the sheet the user just opened.
		await fireEvent.blur(input);
		await sleep(200);
		expect(screen.queryByTestId("bottom-sheet")).not.toBeNull();
	});

	test("clicks inside the sheet (option selection) do NOT close it", async () => {
		const onchange = vi.fn();
		render(ExtensionSearchPicker, { selected: [], onchange });
		await openPicker();
		const listbox = document.querySelector("#extension-picker-listbox");
		expect(listbox).not.toBeNull();

		// The extensions list arrives via the async onMount fetch — wait for
		// the option to materialize before interacting.
		const optionLabel = await screen.findByText("Extension A");
		const option = optionLabel.closest("button");
		expect(option).not.toBeNull();
		// Selection fires on mousedown (beats the input blur); the tap's
		// pointerdown + composed click follow in the real event stream.
		await fireEvent.pointerDown(option!);
		await fireEvent.mouseDown(option!);
		await fireEvent.click(option!);

		expect(onchange).toHaveBeenCalledWith(["ext-a"]);
		expect(screen.queryByTestId("bottom-sheet")).not.toBeNull();
	});
});
