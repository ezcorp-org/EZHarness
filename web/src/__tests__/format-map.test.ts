import { describe, test, expect } from "bun:test";
import {
	getFormatComponent,
	formatComponentMap,
} from "../lib/components/ui/format-map";

describe("formatComponentMap", () => {
	test("contains exactly 6 format keys", () => {
		const keys = Object.keys(formatComponentMap);
		expect(keys).toHaveLength(6);
		expect(keys.sort()).toEqual(
			["combo-box", "date", "datetime", "file-path", "search", "tag-input"].sort(),
		);
	});

	test("date and datetime map to the same component", () => {
		expect(formatComponentMap["date"]).toBe(formatComponentMap["datetime"]);
	});
});

describe("getFormatComponent", () => {
	test.each(["file-path", "combo-box", "search", "tag-input", "date", "datetime"])(
		"returns a truthy component for '%s'",
		(format) => {
			expect(getFormatComponent(format)).toBeTruthy();
		},
	);

	test("throws for unknown format with descriptive message", () => {
		expect(() => getFormatComponent("unknown-format")).toThrow(
			/Unrecognized input format/,
		);
	});

	test("error message lists valid formats", () => {
		try {
			getFormatComponent("unknown-format");
		} catch (e: any) {
			expect(e.message).toContain("file-path");
			expect(e.message).toContain("combo-box");
			expect(e.message).toContain("search");
		}
	});
});
