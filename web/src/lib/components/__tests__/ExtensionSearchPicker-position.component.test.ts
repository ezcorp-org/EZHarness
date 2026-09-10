import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ExtensionSearchPicker from "../ExtensionSearchPicker.svelte";

const originalInnerHeight = window.innerHeight;

function rect(top: number, bottom: number): DOMRect {
	return { x: 16, y: top, width: 320, height: bottom - top, top, right: 336, bottom, left: 16, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
	Object.defineProperty(window, "innerHeight", { value: 720, configurable: true });
	vi.stubGlobal("fetch", vi.fn(async () => Response.json({ extensions: [{ id: "extension-a", name: "Extension A" }] })));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Object.defineProperty(window, "innerHeight", { value: originalInnerHeight, configurable: true });
});

async function openAt(top: number, bottom: number, dropdownHeight = 240) {
	render(ExtensionSearchPicker, { selected: [], onchange: vi.fn() });
	const input = screen.getByRole("combobox");
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this === input) return rect(top, bottom);
		if (this.hasAttribute("data-extension-picker-popover")) {
      const cap = this.querySelector("ul")?.style.maxHeight;
      return rect(0, cap ? Math.min(dropdownHeight, Number.parseFloat(cap)) : dropdownHeight);
    }
		return rect(0, 0);
	});
	await fireEvent.focus(input);
	await screen.findByRole("listbox");
	return document.querySelector("[data-extension-picker-popover]") as HTMLDivElement;
}

describe("ExtensionSearchPicker desktop placement", () => {
	test("opens below when the measured list fits", async () => {
		const picker = await openAt(40, 80);
		await waitFor(() => expect(picker.style.top).toBe("82px"));
		expect(picker.style.bottom).toBe("");
	});

  test("keeps a constrained list bounded after filtering and reopening", async () => {
    Object.defineProperty(window, "innerHeight", { value: 400, configurable: true });
    await openAt(180, 220);
    const input = screen.getByRole("combobox");
    await waitFor(() => expect(screen.getByRole("listbox").style.maxHeight).toBe("178px"));
    await fireEvent.input(input, { target: { value: "Extension" } });
    await waitFor(() => expect(input).toHaveValue("Extension"));
    expect(screen.getByRole("listbox").style.maxHeight).toBe("178px");
    await fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    await fireEvent.focus(input);
    await waitFor(() => expect(screen.getByRole("listbox").style.maxHeight).toBe("178px"));
  });

	test("opens above when the measured list would leave the viewport", async () => {
		const picker = await openAt(560, 600);
		await waitFor(() => expect(picker.style.bottom).toBe("162px"));
		expect(picker.style.top).toBe("");
	});
});
