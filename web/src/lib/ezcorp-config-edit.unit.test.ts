/**
 * Pure-logic unit tests for `ezcorp-config-edit.ts` (Phase 4 §5.3): the
 * surgical `ezcorp.config.ts` source mutations behind the author
 * composition panel. Covers recognition, dependency read/write/remove
 * (idempotent re-edit), capability read/write/remove, and graceful
 * degradation on an unrecognized config.
 */
import { describe, test, expect } from "vitest";
import {
	isRecognizedConfig,
	parseDependencies,
	setDependencies,
	parseCapabilities,
	setCapabilityPermissions,
	unresolvedDependencies,
} from "./ezcorp-config-edit";
import type { DependencyEntry, ToggleableCapability } from "./ezcorp-config-edit";

/** The scaffold's known config shape (mirrors templates/tool.ts). */
const SCAFFOLD = `import { defineExtension } from "@ezcorp/sdk";
import { handleRequest } from "./index";

export default defineExtension({
  schemaVersion: 2,
  name: "my-ext",
  version: "0.1.0",
  description: "x",
  author: { name: "Me" },
  entrypoint: "./index.ts",
  tools: [],
  permissions: {},
});
`;

const SCAFFOLD_WITH_PERMS = SCAFFOLD.replace(
	"permissions: {}",
	`permissions: {\n    network: ["api.example.com"],\n  }`,
);

const DEP_A: DependencyEntry = { name: "ai-kit", source: "bundled", version: "^0.1.0" };
const DEP_B: DependencyEntry = { name: "web-search", source: "bundled", version: "1.0.0" };

function allCaps(over: Partial<Record<string, boolean>> = {}) {
	return { search: false, memory: false, llm: false, ...over } as Record<ToggleableCapability, boolean>;
}

describe("isRecognizedConfig", () => {
	test("true for a defineExtension config with a permissions field", () => {
		expect(isRecognizedConfig(SCAFFOLD)).toBe(true);
	});
	test("false for arbitrary / hand-rolled source", () => {
		expect(isRecognizedConfig("export const x = 1;")).toBe(false);
		expect(isRecognizedConfig("export default defineExtension({ name: 'x' })")).toBe(false); // no permissions
	});
});

describe("dependencies write + read round-trip", () => {
	test("setDependencies inserts a managed block before permissions; parse reads it back", () => {
		const { source, recognized } = setDependencies(SCAFFOLD, [DEP_A, DEP_B]);
		expect(recognized).toBe(true);
		expect(source).toContain("ezcorp:dependencies (managed)");
		expect(source).toContain('"ai-kit": { source: "bundled", version: "^0.1.0" }');
		// The block sits before permissions.
		expect(source.indexOf("dependencies:")).toBeLessThan(source.indexOf("permissions:"));
		expect(parseDependencies(source)).toEqual([DEP_A, DEP_B]);
	});

	test("re-edit REPLACES the managed block (idempotent, no duplication)", () => {
		const once = setDependencies(SCAFFOLD, [DEP_A, DEP_B]).source;
		const twice = setDependencies(once, [DEP_A]).source;
		expect(parseDependencies(twice)).toEqual([DEP_A]);
		// Only ONE managed block.
		expect(twice.split("ezcorp:dependencies (managed)").length - 1).toBe(1);
	});

	test("empty deps removes the managed block entirely", () => {
		const withDeps = setDependencies(SCAFFOLD, [DEP_A]).source;
		const cleared = setDependencies(withDeps, []).source;
		expect(cleared).not.toContain("ezcorp:dependencies");
		expect(parseDependencies(cleared)).toEqual([]);
		// permissions still intact.
		expect(isRecognizedConfig(cleared)).toBe(true);
	});

	test("parseDependencies on a config with no managed block → []", () => {
		expect(parseDependencies(SCAFFOLD)).toEqual([]);
	});

	test("unrecognized config → unchanged + recognized:false", () => {
		const res = setDependencies("export const x = 1;", [DEP_A]);
		expect(res.recognized).toBe(false);
		expect(res.source).toBe("export const x = 1;");
	});

	test("preserves the source TS validity markers (still a defineExtension call)", () => {
		const { source } = setDependencies(SCAFFOLD, [DEP_A]);
		expect(source).toContain("export default defineExtension({");
		expect(source.trimEnd().endsWith("});")).toBe(true);
	});
});

describe("capability permissions write + read", () => {
	test("enabling search writes search:\"inherit\" into permissions; parse reads it on", () => {
		const { source, recognized } = setCapabilityPermissions(SCAFFOLD, allCaps({ search: true }));
		expect(recognized).toBe(true);
		expect(source).toContain('search: "inherit"');
		expect(parseCapabilities(source)).toEqual({ search: true, memory: false, llm: false });
	});

	test("enabling multiple capabilities", () => {
		const { source } = setCapabilityPermissions(SCAFFOLD, allCaps({ search: true, memory: true }));
		expect(parseCapabilities(source)).toEqual({ search: true, memory: true, llm: false });
	});

	test("disabling a capability REMOVES it (absent = not requested)", () => {
		const on = setCapabilityPermissions(SCAFFOLD, allCaps({ search: true, llm: true })).source;
		const off = setCapabilityPermissions(on, allCaps({ llm: true })).source;
		expect(parseCapabilities(off)).toEqual({ search: false, memory: false, llm: true });
		expect(off).not.toContain('search:');
	});

	test("preserves OTHER permission fields (network) while toggling capabilities", () => {
		const { source } = setCapabilityPermissions(SCAFFOLD_WITH_PERMS, allCaps({ search: true }));
		expect(source).toContain('network: ["api.example.com"]');
		expect(parseCapabilities(source)).toEqual({ search: true, memory: false, llm: false });
	});

	test("all-off → empty permissions, no capability keys", () => {
		const on = setCapabilityPermissions(SCAFFOLD, allCaps({ search: true })).source;
		const off = setCapabilityPermissions(on, allCaps()).source;
		expect(parseCapabilities(off)).toEqual({ search: false, memory: false, llm: false });
	});

	test("an explicit search:false in permissions reads as OFF", () => {
		const src = SCAFFOLD.replace("permissions: {}", `permissions: {\n    search: false,\n  }`);
		expect(parseCapabilities(src).search).toBe(false);
	});

	test("unrecognized config → unchanged + recognized:false", () => {
		const res = setCapabilityPermissions("export const x = 1;", allCaps({ search: true }));
		expect(res.recognized).toBe(false);
		expect(res.source).toBe("export const x = 1;");
	});

	test("parseCapabilities on a config without permissions body → all false", () => {
		expect(parseCapabilities("export const x = 1;")).toEqual({ search: false, memory: false, llm: false });
	});

	test("malformed permissions (unbalanced braces) degrades safely", () => {
		// Recognized (has defineExtension({ + permissions:) but the
		// permissions object never closes — the brace-matcher bails to null.
		const malformed = `export default defineExtension({\n  permissions: {\n    search: "inherit",\n`;
		// parse → no closing brace → all-false (no crash).
		expect(parseCapabilities(malformed)).toEqual({ search: false, memory: false, llm: false });
		// set → replacePermissionsBody returns null → recognized:false, unchanged.
		const res = setCapabilityPermissions(malformed, allCaps({ memory: true }));
		expect(res.recognized).toBe(false);
		expect(res.source).toBe(malformed);
	});
});

describe("unresolvedDependencies (non-fatal install warning)", () => {
	const installed = [
		{ name: "ai-kit", version: "0.1.0" },
		{ name: "web-search", version: "1.0.0" },
	];

	test("all declared deps installed → no warnings", () => {
		expect(unresolvedDependencies([DEP_A, DEP_B], installed)).toEqual([]);
	});

	test("a declared dep absent from the installed set → flagged by name", () => {
		const missing: DependencyEntry = { name: "ghost-ext", source: "bundled", version: "1.0.0" };
		expect(unresolvedDependencies([DEP_A, missing], installed)).toEqual(["ghost-ext"]);
	});

	test("multiple missing → all flagged, declaration order, deduped", () => {
		const m1: DependencyEntry = { name: "ghost-a", source: "x", version: "1.0.0" };
		const m2: DependencyEntry = { name: "ghost-b", source: "x", version: "1.0.0" };
		const m1dup: DependencyEntry = { name: "ghost-a", source: "x", version: "2.0.0" };
		expect(unresolvedDependencies([m1, m2, m1dup], installed)).toEqual(["ghost-a", "ghost-b"]);
	});

	test("no declared deps → no warnings", () => {
		expect(unresolvedDependencies([], installed)).toEqual([]);
	});

	test("empty installed set → every declared dep flagged", () => {
		expect(unresolvedDependencies([DEP_A, DEP_B], [])).toEqual(["ai-kit", "web-search"]);
	});
});

describe("combined: deps + capabilities coexist", () => {
	test("writing deps then capabilities preserves both", () => {
		const withDeps = setDependencies(SCAFFOLD, [DEP_A]).source;
		const withBoth = setCapabilityPermissions(withDeps, allCaps({ search: true })).source;
		expect(parseDependencies(withBoth)).toEqual([DEP_A]);
		expect(parseCapabilities(withBoth)).toEqual({ search: true, memory: false, llm: false });
	});
});
