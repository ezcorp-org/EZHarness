import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ModeSearchPicker from "../ModeSearchPicker.svelte";

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify([
			{
				id: "full-auto",
				name: "Full Auto",
				description: "Use all available tools",
				slug: "full-auto",
				toolRestriction: "all",
				builtin: true,
			},
		]), { status: 200, headers: { "content-type": "application/json" } })),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("ModeSearchPicker selection", () => {
	test("immediate native reopen survives the prior blur deadline", async () => {
		vi.useFakeTimers();
		const onselect = vi.fn();
		render(ModeSearchPicker, { selected: null, onselect });
		await vi.advanceTimersByTimeAsync(0);

		const input = screen.getByRole("combobox");
		await fireEvent.focus(input);
		const option = screen.getByRole("button", { name: /Full Auto/ });

		// The picker selects on mousedown, closes, and blurs its input. A user
		// can immediately reopen it to choose Inherited instead.
		await fireEvent.mouseDown(option);
		expect(onselect).toHaveBeenCalledWith(expect.objectContaining({ id: "full-auto" }));
		await fireEvent.blur(input);
		await fireEvent.click(input);
		await vi.advanceTimersByTimeAsync(151);

		expect(document.querySelector("#mode-picker-listbox")).not.toBeNull();

		// The broader mounted-root check must not turn an outside click into a
		// permanent open dropdown.
		await fireEvent.click(document.body);
		expect(document.querySelector("#mode-picker-listbox")).toBeNull();
	});
});
