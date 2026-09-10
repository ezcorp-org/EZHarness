import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ModelSearchPicker from "../ModelSearchPicker.svelte";

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(async () => Response.json([
		{ provider: "mock", model: "model-a", tier: "fast", costTier: "low", available: true },
		{ provider: "mock", model: "model-b", tier: "smart", costTier: "medium", available: true },
	])));
});

afterEach(() => vi.unstubAllGlobals());

async function openPicker() {
	const onselect = vi.fn();
	render(ModelSearchPicker, { selected: null, onselect });
	const input = screen.getByRole("combobox");
	await fireEvent.focus(input);
	await fireEvent.input(input, { target: { value: "model-" } });
	await screen.findByRole("button", { name: /model-b/ });
	return { input, onselect };
}

describe("ModelSearchPicker desktop keyboard controls", () => {
	test("arrow keys stay within the results and Enter selects the highlighted model", async () => {
		const { input, onselect } = await openPicker();
		for (let press = 0; press < 3; press++) await fireEvent.keyDown(input, { key: "ArrowDown" });
		expect(input).toHaveAttribute("aria-activedescendant", "model-picker-item-1");
		for (let press = 0; press < 3; press++) await fireEvent.keyDown(input, { key: "ArrowUp" });
		expect(input).toHaveAttribute("aria-activedescendant", "model-picker-item-0");
		await fireEvent.keyDown(input, { key: "Enter" });
		expect(onselect).toHaveBeenCalledExactlyOnceWith("mock", "model-a");
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	test("Escape closes the results without changing the selected model", async () => {
		const { input, onselect } = await openPicker();
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		await fireEvent.keyDown(input, { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(onselect).not.toHaveBeenCalled();
	});
});
