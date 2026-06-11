/**
 * Unit tests for loaded-tools-logic.ts — the pure grouping/derivation
 * behind the header's loaded-tools badge + popover. No DOM; runs under
 * bun:test. Gated at 100%.
 */
import { test, expect, describe } from "bun:test";
import {
	groupToolsByExtension,
	buildExtensionTypeMap,
	sumTokenEstimates,
	type LoadedTool,
} from "../loaded-tools-logic";

function tool(overrides: Partial<LoadedTool> & Pick<LoadedTool, "name">): LoadedTool {
	return {
		description: `${overrides.name} description`,
		extension: "ext-a",
		...overrides,
	};
}

describe("groupToolsByExtension", () => {
	test("empty input → empty map", () => {
		expect(groupToolsByExtension([]).size).toBe(0);
	});

	test("groups tools under their owning extension", () => {
		const map = groupToolsByExtension([
			tool({ name: "scan", extension: "analyzer" }),
			tool({ name: "lint", extension: "analyzer" }),
			tool({ name: "summarize", extension: "markdown-utils" }),
		]);
		expect(map.size).toBe(2);
		expect(map.get("analyzer")?.map((t) => t.name)).toEqual(["scan", "lint"]);
		expect(map.get("markdown-utils")?.map((t) => t.name)).toEqual(["summarize"]);
	});

	test("preserves first-seen extension order (API order)", () => {
		const map = groupToolsByExtension([
			tool({ name: "a", extension: "z-ext" }),
			tool({ name: "b", extension: "a-ext" }),
			tool({ name: "c", extension: "z-ext" }),
		]);
		expect([...map.keys()]).toEqual(["z-ext", "a-ext"]);
	});
});

describe("buildExtensionTypeMap", () => {
	test("maps extension → extensionType", () => {
		const map = buildExtensionTypeMap([
			tool({ name: "scan", extension: "analyzer", extensionType: "mcp" }),
			tool({ name: "chat", extension: "my-agent", extensionType: "agent" }),
		]);
		expect(map.get("analyzer")).toBe("mcp");
		expect(map.get("my-agent")).toBe("agent");
	});

	test("defaults a missing extensionType to 'extension'", () => {
		const map = buildExtensionTypeMap([tool({ name: "scan", extension: "analyzer" })]);
		expect(map.get("analyzer")).toBe("extension");
	});

	test("empty input → empty map", () => {
		expect(buildExtensionTypeMap([]).size).toBe(0);
	});
});

describe("sumTokenEstimates", () => {
	test("sums token estimates", () => {
		expect(
			sumTokenEstimates([
				tool({ name: "a", tokenEstimate: 25 }),
				tool({ name: "b", tokenEstimate: 22 }),
				tool({ name: "c", tokenEstimate: 30 }),
			]),
		).toBe(77);
	});

	test("tools without an estimate count as 0", () => {
		expect(
			sumTokenEstimates([tool({ name: "a", tokenEstimate: 25 }), tool({ name: "b" })]),
		).toBe(25);
	});

	test("empty input → 0", () => {
		expect(sumTokenEstimates([])).toBe(0);
	});
});
