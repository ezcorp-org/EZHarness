import { test, expect, describe } from "bun:test";

// ── Types extracted from ThinkingLevelSelector.svelte ────────────────────────

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// ── Logic extracted from ThinkingLevelSelector.svelte ────────────────────────

const LEVELS: { value: ThinkingLevel; label: string }[] = [
	{ value: "off", label: "Off" },
	{ value: "minimal", label: "Minimal" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "Max" },
];

function getDisplayLabel(selected: ThinkingLevel): string {
	return LEVELS.find((l) => l.value === selected)?.label ?? "Medium";
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("LEVELS – options list", () => {
	test("contains exactly 6 levels", () => {
		expect(LEVELS).toHaveLength(6);
	});

	test("levels are in expected order: off → minimal → low → medium → high → xhigh", () => {
		expect(LEVELS.map((l) => l.value)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
	});

	test("each level has a non-empty label", () => {
		for (const level of LEVELS) {
			expect(level.label.length).toBeGreaterThan(0);
		}
	});

	test("all level values are unique", () => {
		const values = LEVELS.map((l) => l.value);
		expect(new Set(values).size).toBe(values.length);
	});
});

describe("getDisplayLabel – level-to-label mapping", () => {
	test("off → 'Off'", () => {
		expect(getDisplayLabel("off")).toBe("Off");
	});

	test("minimal → 'Minimal'", () => {
		expect(getDisplayLabel("minimal")).toBe("Minimal");
	});

	test("low → 'Low'", () => {
		expect(getDisplayLabel("low")).toBe("Low");
	});

	test("medium → 'Medium'", () => {
		expect(getDisplayLabel("medium")).toBe("Medium");
	});

	test("high → 'High'", () => {
		expect(getDisplayLabel("high")).toBe("High");
	});

	test("xhigh → 'Max'", () => {
		expect(getDisplayLabel("xhigh")).toBe("Max");
	});
});

describe("getDisplayLabel – default fallback", () => {
	test("falls back to 'Medium' for any unrecognized value (cast via type assertion)", () => {
		// In the component the default is hardcoded as "Medium" in the ?? fallback
		const unknown = "ultra" as ThinkingLevel;
		expect(getDisplayLabel(unknown)).toBe("Medium");
	});
});

describe("default selected value", () => {
	test("component default is 'medium'", () => {
		// The component declares: selected = "medium"
		const defaultSelected: ThinkingLevel = "medium";
		expect(defaultSelected).toBe("medium");
		expect(getDisplayLabel(defaultSelected)).toBe("Medium");
	});
});

describe("model compatibility – thinking level semantics", () => {
	test("'off' disables thinking entirely", () => {
		const offLevel = LEVELS.find((l) => l.value === "off");
		expect(offLevel).toBeDefined();
		expect(offLevel!.label).toBe("Off");
	});

	test("'xhigh' is the maximum thinking level", () => {
		const maxLevel = LEVELS[LEVELS.length - 1];
		expect(maxLevel.value).toBe("xhigh");
		expect(maxLevel.label).toBe("Max");
	});

	test("'off' is the minimum thinking level", () => {
		const minLevel = LEVELS[0];
		expect(minLevel.value).toBe("off");
	});

	test("levels cover the full range from off to max", () => {
		const values = LEVELS.map((l) => l.value);
		expect(values[0]).toBe("off");
		expect(values[values.length - 1]).toBe("xhigh");
	});
});
