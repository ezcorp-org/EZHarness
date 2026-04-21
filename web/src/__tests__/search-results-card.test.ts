import { test, expect, describe } from "bun:test";
import { parseGrepOutput, parseGlobOutput } from "../lib/components/tool-cards/utils.js";

describe("parseGrepOutput", () => {
	test("groups file:line:content lines by file", () => {
		const input = `src/main.ts:10:const x = 1;
src/main.ts:20:const y = 2;
src/utils.ts:5:export function foo() {}`;

		const groups = parseGrepOutput(input);
		expect(groups).toHaveLength(2);
		expect(groups[0]!.filePath).toBe("src/main.ts");
		expect(groups[0]!.matches).toHaveLength(2);
		expect(groups[0]!.matches[0]!.lineNum).toBe(10);
		expect(groups[0]!.matches[0]!.content).toBe("const x = 1;");
		expect(groups[1]!.filePath).toBe("src/utils.ts");
		expect(groups[1]!.matches).toHaveLength(1);
	});

	test("handles context separator lines (--)", () => {
		const input = `src/main.ts:10:match one
--
src/main.ts:20:match two`;

		const groups = parseGrepOutput(input);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.matches).toHaveLength(2);
	});

	test("returns empty groups for empty input", () => {
		expect(parseGrepOutput("")).toHaveLength(0);
		expect(parseGrepOutput("   ")).toHaveLength(0);
	});

	test("handles context lines with dash separator (file:line-content)", () => {
		const input = `src/main.ts:9-context before
src/main.ts:10:actual match
src/main.ts:11-context after`;

		const groups = parseGrepOutput(input);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.matches).toHaveLength(3);
	});
});

describe("parseGlobOutput", () => {
	test("splits newline-separated file paths into a list", () => {
		const input = `src/main.ts
src/utils.ts
src/types.ts`;

		const files = parseGlobOutput(input);
		expect(files).toEqual(["src/main.ts", "src/utils.ts", "src/types.ts"]);
	});

	test("handles truncation markers by excluding them", () => {
		const input = `src/main.ts
src/utils.ts
[truncated: 100 more files]`;

		const files = parseGlobOutput(input);
		expect(files).toEqual(["src/main.ts", "src/utils.ts"]);
	});

	test("returns empty list for empty input", () => {
		expect(parseGlobOutput("")).toEqual([]);
		expect(parseGlobOutput("  ")).toEqual([]);
	});

	test("trims whitespace from paths", () => {
		const input = `  src/main.ts
  src/utils.ts  `;

		const files = parseGlobOutput(input);
		expect(files).toEqual(["src/main.ts", "src/utils.ts"]);
	});
});
