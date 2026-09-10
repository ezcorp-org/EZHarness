import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, test, vi } from "vitest";
import MobilePickerSearch from "../MobilePickerSearch.svelte";

function props(overrides: Partial<{
	activeDescendant: string;
}> = {}) {
	return {
		value: "",
		placeholder: "Search items...",
		ariaLabel: "Search items",
		controls: "items-listbox",
		oninput: vi.fn(),
		onkeydown: vi.fn(),
		...overrides,
	};
}

describe("MobilePickerSearch", () => {
	test("omits the active descendant until a result is highlighted", () => {
		render(MobilePickerSearch, props());
		const input = screen.getByRole("combobox", { name: "Search items" });
		expect(input).toHaveAttribute("aria-controls", "items-listbox");
		expect(input).not.toHaveAttribute("aria-activedescendant");
	});

	test("surfaces the highlighted result and forwards input and keyboard events", async () => {
		const componentProps = props({ activeDescendant: "items-picker-item-0" });
		render(MobilePickerSearch, componentProps);
		const input = screen.getByRole("combobox", { name: "Search items" });

		expect(input).toHaveAttribute("aria-activedescendant", "items-picker-item-0");
		await fireEvent.input(input, { target: { value: "needle" } });
		await fireEvent.keyDown(input, { key: "ArrowDown" });
		expect(componentProps.oninput).toHaveBeenCalledTimes(1);
		expect(componentProps.onkeydown).toHaveBeenCalledTimes(1);

		const inputEvent = componentProps.oninput.mock.calls[0]?.[0];
		expect(inputEvent).toMatchObject({ type: "input", target: input });
		expect((inputEvent.target as HTMLInputElement).value).toBe("needle");

		const keyEvent = componentProps.onkeydown.mock.calls[0]?.[0];
		expect(keyEvent).toMatchObject({ type: "keydown", key: "ArrowDown", target: input });
	});
});
