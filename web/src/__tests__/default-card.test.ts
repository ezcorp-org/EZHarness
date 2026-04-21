import { test, expect, describe } from "bun:test";
import {
	extractInputSummary,
	formatOutputPreview,
} from "../lib/components/tool-cards/utils.js";

describe("extractInputSummary", () => {
	test("extracts command field", () => {
		expect(extractInputSummary({ command: "ls -la" })).toBe("ls -la");
	});

	test("extracts file_path field", () => {
		expect(extractInputSummary({ file_path: "/src/index.ts" })).toBe("/src/index.ts");
	});

	test("extracts path field", () => {
		expect(extractInputSummary({ path: "/home/user" })).toBe("/home/user");
	});

	test("extracts pattern field", () => {
		expect(extractInputSummary({ pattern: "**/*.ts" })).toBe("**/*.ts");
	});

	test("prefers file_path over path", () => {
		expect(extractInputSummary({ file_path: "/a.ts", path: "/b.ts" })).toBe("/a.ts");
	});

	test("returns undefined for no known field", () => {
		expect(extractInputSummary({ foo: "bar" })).toBeUndefined();
	});

	test("returns undefined for null input", () => {
		expect(extractInputSummary(null)).toBeUndefined();
	});

	test("returns undefined for undefined input", () => {
		expect(extractInputSummary(undefined)).toBeUndefined();
	});

	test("returns undefined for non-object input", () => {
		expect(extractInputSummary("string")).toBeUndefined();
	});

	test("truncates long values", () => {
		const long = "a".repeat(100);
		const result = extractInputSummary({ command: long });
		expect(result!.length).toBe(60);
		expect(result!.endsWith("...")).toBe(true);
	});

	test("does not truncate short values", () => {
		expect(extractInputSummary({ command: "short" })).toBe("short");
	});

	test("respects custom maxLen", () => {
		const result = extractInputSummary({ command: "a".repeat(20) }, 10);
		expect(result!.length).toBe(10);
		expect(result!.endsWith("...")).toBe(true);
	});
});

describe("formatOutputPreview", () => {
	test("returns short output unchanged", () => {
		expect(formatOutputPreview("hello")).toBe("hello");
	});

	test("truncates long output", () => {
		const long = "x".repeat(100);
		const result = formatOutputPreview(long);
		expect(result!.length).toBe(50);
		expect(result!.endsWith("...")).toBe(true);
	});

	test("returns undefined for null", () => {
		expect(formatOutputPreview(null)).toBeUndefined();
	});

	test("returns undefined for undefined", () => {
		expect(formatOutputPreview(undefined)).toBeUndefined();
	});

	test("stringifies object output", () => {
		expect(formatOutputPreview({ key: "val" })).toBe('{"key":"val"}');
	});

	test("returns undefined for empty object", () => {
		expect(formatOutputPreview({})).toBeUndefined();
	});

	test("returns undefined for empty string", () => {
		expect(formatOutputPreview('""')).toBeUndefined();
	});

	test("respects custom maxLen", () => {
		const result = formatOutputPreview("a".repeat(20), 10);
		expect(result!.length).toBe(10);
		expect(result!.endsWith("...")).toBe(true);
	});
});
