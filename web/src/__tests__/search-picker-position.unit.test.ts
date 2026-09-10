import { describe, expect, test } from "vitest";
import { fixedSearchPickerLayout } from "$lib/search-picker-position.js";

const anchor = { left: 16, top: 40, bottom: 80, width: 240 };

describe("fixedSearchPickerLayout", () => {
	test("keeps a fitting menu below and preserves its anchor and minimum width", () => {
		const layout = fixedSearchPickerLayout(anchor, 200, 720, 320);
		expect(layout).toEqual({
			dropdownStyle: "position:fixed;left:16px;top:82px;width:320px;z-index:9999;",
			listStyle: "",
			opensAbove: false,
		});
	});

	test("opens above when the menu does not fit below but fits above", () => {
		const layout = fixedSearchPickerLayout({ ...anchor, top: 560, bottom: 600 }, 240, 720, 320);
		expect(layout.opensAbove).toBe(true);
		expect(layout.dropdownStyle).toContain("bottom:162px;");
		expect(layout.listStyle).toBe("");
	});

	test("uses the larger side and caps a menu that fits on neither side", () => {
		const layout = fixedSearchPickerLayout({ ...anchor, top: 300, bottom: 340 }, 500, 600, 200);
		expect(layout).toEqual({
			dropdownStyle: "position:fixed;left:16px;bottom:302px;width:240px;z-index:9999;",
			listStyle: "max-height:256px;",
			opensAbove: true,
		});
	});

	test("reserves non-list menu chrome when it caps a list", () => {
		const layout = fixedSearchPickerLayout({ ...anchor, top: 300, bottom: 340 }, 400, 600, 200, 256);
		expect(layout).toEqual({
			dropdownStyle: "position:fixed;left:16px;bottom:302px;width:240px;z-index:9999;",
			listStyle: "max-height:154px;",
			opensAbove: true,
		});
	});
});
